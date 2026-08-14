/**
 * DESIGN 扩展自动部署（pi-app 主进程侧）。
 *
 * 项目打标为 DESIGN（或已打标项目的 worker 启动）时，把小规仓库的
 * src/design/design-extension/（index.ts / rpc.ts）同步到项目内
 * .pi/extensions/xiaogui-design-project/，使 Pi 会话加载 design.* Tool。
 *
 * - 目标 index.ts 与源内容一致时直接返回（幂等，不触碰项目文件）；
 * - 部署时写出 .xiaogui-deploy.json 记录 runtimeDir，供扩展定位 sidecar；
 * - 任何失败仅 console.warn 并返回 false，绝不阻塞 worker 启动链路。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveXiaoguiConfig } from './config'

/** 项目内扩展安装目录名（Pi 扩展包加载约定）。 */
const EXTENSION_DIR_NAME = 'xiaogui-design-project'

/** 需要同步的扩展源文件。 */
const EXTENSION_FILES = ['index.ts', 'rpc.ts'] as const

/**
 * 确保项目内已部署 xiaogui-design-project 扩展。
 * 返回 true 表示已部署（内容一致或本次同步成功）；false 表示跳过/失败。
 */
export async function ensureDesignExtensionDeployed(projectPath: string): Promise<boolean> {
  try {
    const { repoRoot, pythonCwd } = resolveXiaoguiConfig()
    const srcDir = join(repoRoot, 'src', 'design', 'design-extension')
    const targetDir = join(projectPath, '.pi', 'extensions', EXTENSION_DIR_NAME)

    // 幂等：目标 index.ts 与源内容一致即视为已部署
    const targetIndex = join(targetDir, 'index.ts')
    const sourceIndex = readFileSync(join(srcDir, 'index.ts'), 'utf8')
    if (existsSync(targetIndex) && readFileSync(targetIndex, 'utf8') === sourceIndex) {
      return true
    }

    mkdirSync(targetDir, { recursive: true })
    for (const file of EXTENSION_FILES) {
      copyFileSync(join(srcDir, file), join(targetDir, file))
    }
    // runtimeDir 指向小规仓库 python/（含 xiaogui_runtime 包），扩展据此拉起 sidecar
    writeFileSync(
      join(targetDir, '.xiaogui-deploy.json'),
      JSON.stringify({ runtimeDir: pythonCwd }, null, 2) + '\n',
      'utf8',
    )
    return true
  } catch (e) {
    console.warn('[xiaogui] design extension deploy failed:', e)
    return false
  }
}
