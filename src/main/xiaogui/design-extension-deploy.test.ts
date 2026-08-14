import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DESIGN_SYSTEM_BEGIN,
  DESIGN_SYSTEM_END,
  buildDesignSystemSection,
  ensureDesignExtensionDeployed,
  upsertDesignSystemSection,
} from './design-extension-deploy'

const CODING_SECTION = '# 小规企业开发规范（CODING 会话注入）\n\n- CODING 企业段内容（应被原样保留）\n'

describe('buildDesignSystemSection / upsertDesignSystemSection（段落标记幂等注入）', () => {
  const section = buildDesignSystemSection('# DESIGN 系统提示\n\n- 图数文一致性铁律\n')

  it('标记段由 BEGIN/END 锚点包裹源内容', () => {
    expect(section.startsWith(DESIGN_SYSTEM_BEGIN)).toBe(true)
    expect(section.endsWith(DESIGN_SYSTEM_END)).toBe(true)
    expect(section).toContain('# DESIGN 系统提示')
  })

  it('源内容 CRLF 行尾归一为 LF（跨平台幂等）', () => {
    const crlf = buildDesignSystemSection('# DESIGN\r\n\r\n- 铁律\r\n')
    expect(crlf).not.toContain('\r')
    expect(crlf).toBe(buildDesignSystemSection('# DESIGN\n\n- 铁律\n'))
  })

  it('空内容 → 直接写入标记段', () => {
    expect(upsertDesignSystemSection('', section)).toBe(`${section}\n`)
  })

  it('已有 CODING 企业段 → 追加到末尾且原内容逐字保留', () => {
    const next = upsertDesignSystemSection(CODING_SECTION, section)
    expect(next.startsWith(CODING_SECTION)).toBe(true)
    expect(next.endsWith(`${section}\n`)).toBe(true)
    // CODING 段与 DESIGN 段之间以空行分隔
    expect(next).toContain(`- CODING 企业段内容（应被原样保留）\n\n${DESIGN_SYSTEM_BEGIN}`)
  })

  it('已存在标记段 → 原地替换，段外前缀/后缀内容不变', () => {
    const stale = buildDesignSystemSection('# 旧版 DESIGN 系统提示\n')
    const file = `${CODING_SECTION}\n${stale}\n尾部其他内容\n`
    const next = upsertDesignSystemSection(file, section)
    expect(next.startsWith(CODING_SECTION)).toBe(true)
    expect(next.endsWith('尾部其他内容\n')).toBe(true)
    expect(next).toContain(section)
    expect(next).not.toContain('# 旧版 DESIGN 系统提示')
    // 标记只出现一次（替换而非追加）
    expect(next.split(DESIGN_SYSTEM_BEGIN).length - 1).toBe(1)
  })

  it('内容一致时输出与输入完全一致（幂等）', () => {
    const file = `${CODING_SECTION}\n${section}\n`
    expect(upsertDesignSystemSection(file, section)).toBe(file)
  })
})

describe('ensureDesignExtensionDeployed（临时仓库端到端）', () => {
  const prevRepo = process.env['XIAOGUI_REPO']
  const dirs: string[] = []

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  /** 构造伪小规仓库：design-extension 源 + DESIGN_SYSTEM.md 源。 */
  function makeFakeRepo(): string {
    const repo = makeTempDir('xg-repo-')
    const extDir = join(repo, 'src', 'design', 'design-extension')
    const ctxDir = join(repo, 'src', 'design', 'context')
    mkdirSync(extDir, { recursive: true })
    mkdirSync(ctxDir, { recursive: true })
    writeFileSync(join(extDir, 'index.ts'), '// design extension v1\n', 'utf8')
    writeFileSync(join(extDir, 'rpc.ts'), '// rpc\n', 'utf8')
    writeFileSync(join(ctxDir, 'DESIGN_SYSTEM.md'), '# DESIGN 系统提示 v1\n', 'utf8')
    return repo
  }

  afterEach(() => {
    if (prevRepo === undefined) delete process.env['XIAOGUI_REPO']
    else process.env['XIAOGUI_REPO'] = prevRepo
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('首次部署：扩展落位 + APPEND_SYSTEM.md 注入 DESIGN 段', async () => {
    process.env['XIAOGUI_REPO'] = makeFakeRepo()
    const project = makeTempDir('xg-proj-')
    // 预置 CODING 企业段，验证 DESIGN 段追加且不破坏既有内容
    mkdirSync(join(project, '.pi'), { recursive: true })
    writeFileSync(join(project, '.pi', 'APPEND_SYSTEM.md'), CODING_SECTION, 'utf8')

    await expect(ensureDesignExtensionDeployed(project)).resolves.toBe(true)

    expect(readFileSync(join(project, '.pi', 'extensions', 'xiaogui-design-project', 'index.ts'), 'utf8')).toBe(
      '// design extension v1\n',
    )
    const append = readFileSync(join(project, '.pi', 'APPEND_SYSTEM.md'), 'utf8')
    expect(append.startsWith(CODING_SECTION)).toBe(true)
    expect(append).toContain(DESIGN_SYSTEM_BEGIN)
    expect(append).toContain('# DESIGN 系统提示 v1')
  })

  it('重复部署：内容未变时不再触碰项目文件（幂等）', async () => {
    process.env['XIAOGUI_REPO'] = makeFakeRepo()
    const project = makeTempDir('xg-proj-')
    await expect(ensureDesignExtensionDeployed(project)).resolves.toBe(true)
    const appendPath = join(project, '.pi', 'APPEND_SYSTEM.md')
    const before = readFileSync(appendPath, 'utf8')
    const mtimeBefore = statSync(appendPath).mtimeMs

    await expect(ensureDesignExtensionDeployed(project)).resolves.toBe(true)
    expect(readFileSync(appendPath, 'utf8')).toBe(before)
    expect(statSync(appendPath).mtimeMs).toBe(mtimeBefore)
  })

  it('源更新后：标记段原地替换，CODING 段保留', async () => {
    const repo = makeFakeRepo()
    process.env['XIAOGUI_REPO'] = repo
    const project = makeTempDir('xg-proj-')
    mkdirSync(join(project, '.pi'), { recursive: true })
    writeFileSync(join(project, '.pi', 'APPEND_SYSTEM.md'), CODING_SECTION, 'utf8')
    await expect(ensureDesignExtensionDeployed(project)).resolves.toBe(true)

    // 模拟小规仓库更新 DESIGN_SYSTEM.md 与扩展源
    writeFileSync(join(repo, 'src', 'design', 'context', 'DESIGN_SYSTEM.md'), '# DESIGN 系统提示 v2\n', 'utf8')
    writeFileSync(join(repo, 'src', 'design', 'design-extension', 'index.ts'), '// design extension v2\n', 'utf8')

    await expect(ensureDesignExtensionDeployed(project)).resolves.toBe(true)
    expect(readFileSync(join(project, '.pi', 'extensions', 'xiaogui-design-project', 'index.ts'), 'utf8')).toBe(
      '// design extension v2\n',
    )
    const append = readFileSync(join(project, '.pi', 'APPEND_SYSTEM.md'), 'utf8')
    expect(append.startsWith(CODING_SECTION)).toBe(true)
    expect(append).toContain('# DESIGN 系统提示 v2')
    expect(append).not.toContain('# DESIGN 系统提示 v1')
    expect(append.split(DESIGN_SYSTEM_BEGIN).length - 1).toBe(1)
  })

  it('源缺失时返回 false 不抛异常（不阻塞 worker 启动链路）', async () => {
    const repo = makeTempDir('xg-empty-repo-') // 空仓库：无扩展源文件
    process.env['XIAOGUI_REPO'] = repo
    const project = makeTempDir('xg-proj-')
    await expect(ensureDesignExtensionDeployed(project)).resolves.toBe(false)
  })
})
