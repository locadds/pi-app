/**
 * DESIGN 扩展自动部署（pi-app 主进程侧）。
 *
 * 项目打标为 DESIGN（或已打标项目的 worker 启动）时：
 * 1. 把小规仓库的 src/design/design-extension/（index.ts / rpc.ts /
 *    phase-guard.ts）同步到项目内 .pi/extensions/xiaogui-design-project/，
 *    使 Pi 会话加载 design.* Tool；
 * 2. 把小规仓库的 src/design/context/DESIGN_SYSTEM.md 以段落标记方式幂等写入
 *    项目 .pi/APPEND_SYSTEM.md（Pi 项目级系统提示追加资源）；
 * 3. 阶段 5A（#60）：把 src/design/skills/（项目理解流程技能）同步到项目
 *    .pi/skills/，把 src/design/desktop-adapters/xiaogui-design.json 同步到
 *    项目 .pi/desktop/adapters/（工具卡声明式呈现增强）。两者均幂等且
 *    容忍源缺失（旧版小规仓库无这些文件时不影响既有部署链路）。
 *
 * - 扩展：EXTENSION_FILES 逐一比对，全部与源内容一致才跳过同步（幂等，
 *   不触碰项目文件；仅比 index.ts 会漏掉 rpc.ts / phase-guard.ts 单独变更）；
 * - 系统提示：标记段已存在且内容一致时跳过写入；存在但内容过期则原地替换
 *   （与 BEGIN 配对的是其后第一个 END，双段场景只替换第一段，段间内容保留）；
 *   不存在则追加到文件末尾。标记段之外的内容（如 CODING 企业段）原样保留；
 * - 部署时写出 .xiaogui-deploy.json 记录 runtimeDir，供扩展定位 sidecar；
 * - 任何失败仅 console.warn 并返回 false，绝不阻塞 worker 启动链路。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveXiaoguiConfig } from './config'

/** 项目内扩展安装目录名（Pi 扩展包加载约定）。 */
const EXTENSION_DIR_NAME = 'xiaogui-design-project'

/** 部署清单 schema：v1 仅有 runtimeDir；v2 加入源身份和内容哈希。 */
const DEPLOY_MANIFEST_SCHEMA_VERSION = 2

const DEPLOY_MANIFEST_FILE = '.xiaogui-deploy.json'

/** 需要同步的扩展源文件（阶段 5A：phase-guard.ts 被 index.ts import）。 */
const EXTENSION_FILES = ['index.ts', 'rpc.ts', 'phase-guard.ts'] as const

/** DESIGN 系统提示源文件（相对小规仓库根，经 repoRoot 解析）。 */
const DESIGN_SYSTEM_SOURCE = join('src', 'design', 'context', 'DESIGN_SYSTEM.md')

/** 阶段 5A：skills 源目录与入口文件名（Pi 项目级技能约定 <cwd>/.pi/skills/<name>/SKILL.md）。 */
const SKILLS_SOURCE_DIR = join('src', 'design', 'skills')
const SKILL_ENTRY_FILE = 'SKILL.md'

/** 阶段 5A：桌面 adapter 源文件与项目内目标文件名（项目层 .pi/desktop/adapters/ 优先级最高）。 */
const ADAPTER_SOURCE = join('src', 'design', 'desktop-adapters', 'xiaogui-design.json')
const ADAPTER_TARGET_NAME = 'xiaogui-design.json'

/** DESIGN 系统提示段标记（幂等写入 / 原地替换的锚点）。 */
export const DESIGN_SYSTEM_BEGIN = '<!-- XIAOGUI:DESIGN:BEGIN -->'
export const DESIGN_SYSTEM_END = '<!-- XIAOGUI:DESIGN:END -->'

/** 由源内容构造标记段（行尾统一为 LF，保证跨平台幂等）。 */
export function buildDesignSystemSection(source: string): string {
  const normalized = source.replace(/\r\n/g, '\n').trimEnd()
  return `${DESIGN_SYSTEM_BEGIN}\n${normalized}\n${DESIGN_SYSTEM_END}`
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function readUtf8IfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function buildDeployManifest(params: {
  repoRoot: string
  runtimeDir: string | null
  extensionSourceDir: string
  designSystemSource: string
  extensionSources: Partial<Record<(typeof EXTENSION_FILES)[number], string>>
}): string {
  const files = Object.fromEntries(
    EXTENSION_FILES.flatMap((file) => {
      const content = params.extensionSources[file]
      return content === undefined ? [] : [[file, { sha256: sha256(content) }]]
    }),
  )

  return (
    JSON.stringify(
      {
        schemaVersion: DEPLOY_MANIFEST_SCHEMA_VERSION,
        runtimeDir: params.runtimeDir,
        source: {
          repoRoot: params.repoRoot,
          extensionDir: params.extensionSourceDir,
          designSystem: DESIGN_SYSTEM_SOURCE,
        },
        files,
        designSystem: {
          sha256: sha256(params.designSystemSource),
        },
      },
      null,
      2,
    ) + '\n'
  )
}

/**
 * 将标记段并入 APPEND_SYSTEM.md 现有内容：
 * - 已存在完整标记段 → 原地替换该段，段外内容（如 CODING 企业段）原样保留；
 * - 双段场景 → 与 BEGIN 配对的是其后第一个 END（正向 indexOf 配对），
 *   只替换第一段，段间内容及后续段原样保留（若用 lastIndexOf(END) 配对，
 *   会把第一个 BEGIN 到最后一个 END 之间的内容整体吞掉）；
 * - 有 BEGIN 无 END（残段）→ 丢弃残段，按完整标记段重写（补写 END 锚点）；
 * - 不存在标记段 → 追加到文件末尾（保留全部既有内容）。
 */
export function upsertDesignSystemSection(existing: string, section: string): string {
  const begin = existing.indexOf(DESIGN_SYSTEM_BEGIN)
  if (begin !== -1) {
    const end = existing.indexOf(DESIGN_SYSTEM_END, begin + DESIGN_SYSTEM_BEGIN.length)
    if (end !== -1) {
      return (
        existing.slice(0, begin) + section + existing.slice(end + DESIGN_SYSTEM_END.length)
      )
    }
    // 有 BEGIN 无 END：从 BEGIN 处截断丢弃残段，重写完整标记段
    const prefix = existing.slice(0, begin).trimEnd()
    return prefix.length > 0 ? `${prefix}\n\n${section}\n` : `${section}\n`
  }
  const trimmed = existing.trimEnd()
  return trimmed.length > 0 ? `${trimmed}\n\n${section}\n` : `${section}\n`
}

/**
 * 阶段 5A：同步 skills 与桌面 adapter（均幂等、容忍源缺失）。
 * 返回 true 表示源不存在（跳过）或全部同步成功。
 */
function syncAuxiliaryAssets(repoRoot: string, projectPath: string): boolean {
  let ok = true

  // skills：<repoRoot>/src/design/skills/<name>/SKILL.md → <project>/.pi/skills/<name>/SKILL.md
  const skillsSource = join(repoRoot, SKILLS_SOURCE_DIR)
  if (existsSync(skillsSource)) {
    for (const entry of readdirSync(skillsSource, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillFile = join(skillsSource, entry.name, SKILL_ENTRY_FILE)
      if (!existsSync(skillFile)) continue
      const targetFile = join(projectPath, '.pi', 'skills', entry.name, SKILL_ENTRY_FILE)
      if (
        existsSync(targetFile) &&
        readFileSync(targetFile, 'utf8') === readFileSync(skillFile, 'utf8')
      ) {
        continue // 幂等：内容一致跳过
      }
      try {
        mkdirSync(join(projectPath, '.pi', 'skills', entry.name), { recursive: true })
        copyFileSync(skillFile, targetFile)
      } catch (e) {
        console.warn(`[xiaogui] skill deploy failed (${entry.name}):`, e)
        ok = false
      }
    }
  }

  // adapter：<repoRoot>/src/design/desktop-adapters/xiaogui-design.json → <project>/.pi/desktop/adapters/
  const adapterSource = join(repoRoot, ADAPTER_SOURCE)
  if (existsSync(adapterSource)) {
    const targetFile = join(projectPath, '.pi', 'desktop', 'adapters', ADAPTER_TARGET_NAME)
    const sourceContent = readFileSync(adapterSource, 'utf8')
    if (!existsSync(targetFile) || readFileSync(targetFile, 'utf8') !== sourceContent) {
      try {
        mkdirSync(join(projectPath, '.pi', 'desktop', 'adapters'), { recursive: true })
        copyFileSync(adapterSource, targetFile)
      } catch (e) {
        console.warn('[xiaogui] desktop adapter deploy failed:', e)
        ok = false
      }
    }
  }

  return ok
}

/**
 * 确保项目内已部署 xiaogui-design-project 扩展，且 DESIGN 系统提示已注入。
 * 返回 true 表示均已就绪（内容一致或本次同步成功）；false 表示跳过/失败。
 */
export async function ensureDesignExtensionDeployed(projectPath: string): Promise<boolean> {
  try {
    const { repoRoot, pythonCwd } = resolveXiaoguiConfig()
    if (!repoRoot) {
      // DESIGN 扩展源必须来自小规仓库根；仅有 runtime 目录无法定位扩展源。
      console.warn('[xiaogui] DESIGN 扩展部署 skipped：未配置 XIAOGUI_REPO，无法定位扩展源')
      return false
    }
    const srcDir = join(repoRoot, 'src', 'design', 'design-extension')
    const targetDir = join(projectPath, '.pi', 'extensions', EXTENSION_DIR_NAME)

    // 幂等（扩展）：EXTENSION_FILES 逐一比对（index.ts 为入口必须存在，
    // rpc.ts / phase-guard.ts 容忍源缺失，与下方复制逻辑的容忍语义一致），
    // 全部一致才视为扩展已最新——仅比 index.ts 会漏掉其余文件单独变更的场景。
    // 首次采集延迟到 every 循环内部，避免在已幂等时仍提前读取 index.ts。
    const extensionSources: Partial<Record<(typeof EXTENSION_FILES)[number], string>> = {}
    const extensionUpToDate = EXTENSION_FILES.every((file) => {
      const sourceFile = join(srcDir, file)
      if (!existsSync(sourceFile)) return file !== 'index.ts' // index.ts 必须存在
      const targetFile = join(targetDir, file)
      const sourceContent = (extensionSources[file] = readFileSync(sourceFile, 'utf8'))
      return existsSync(targetFile) && readFileSync(targetFile, 'utf8') === sourceContent
    })

    // 幂等（系统提示）：并入后的内容与现状一致则无需写入
    const designSystemSource = readFileSync(join(repoRoot, DESIGN_SYSTEM_SOURCE), 'utf8')
    const section = buildDesignSystemSection(designSystemSource)
    const appendSystemPath = join(projectPath, '.pi', 'APPEND_SYSTEM.md')
    const existing = existsSync(appendSystemPath)
      ? readFileSync(appendSystemPath, 'utf8')
      : ''
    const next = upsertDesignSystemSection(existing, section)

    const deployManifest = buildDeployManifest({
      repoRoot,
      runtimeDir: pythonCwd,
      extensionSourceDir: srcDir,
      designSystemSource,
      extensionSources,
    })
    const deployManifestPath = join(targetDir, DEPLOY_MANIFEST_FILE)
    const manifestUpToDate = readUtf8IfExists(deployManifestPath) === deployManifest

    // 阶段 5A：skills + 桌面 adapter 同步（幂等、容忍源缺失）
    const auxOk = syncAuxiliaryAssets(repoRoot, projectPath)

    if (extensionUpToDate && manifestUpToDate && next === existing && auxOk) {
      return true
    }

    if (!extensionUpToDate) {
      mkdirSync(targetDir, { recursive: true })
      for (const file of EXTENSION_FILES) {
        // 容忍源缺失（旧版小规仓库无 phase-guard.ts 等新文件时仅跳过）
        const sourceFile = join(srcDir, file)
        if (!existsSync(sourceFile)) continue
        copyFileSync(sourceFile, join(targetDir, file))
      }
    }

    if (!manifestUpToDate) {
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(deployManifestPath, deployManifest, 'utf8')
    }

    if (next !== existing) {
      mkdirSync(join(projectPath, '.pi'), { recursive: true })
      writeFileSync(appendSystemPath, next, 'utf8')
    }
    return true
  } catch (e) {
    console.warn('[xiaogui] design extension deploy failed:', e)
    return false
  }
}
