import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../agent-dir', () => ({ resolveActiveAgentDir: () => '' }))
vi.mock('../../extension-compat/extension-probe', () => ({ probeExtensions: () => [] }))
vi.mock('../../extension-compat/adapter-loader', () => ({ loadAdapterCatalog: () => ({ adapters: [] }), v2DisplayInfo: () => undefined }))
import { listSkillsOnDisk } from '../pi-resources-editor'
import { scanStaticSlashCommands } from '../commands-catalog'

const roots: string[] = []
function fixture(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'c2-skill-bom-'))
  roots.push(root)
  const dir = join(root, '.pi', 'skills', 'artifact-id')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, content, 'utf8')
  return { root, path }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Skill 文件读取到命令目录', () => {
  it('有无首BOM均读取name/description，命令使用name且不修改文件字节', () => {
    for (const bom of ['', '\uFEFF']) {
      const f = fixture(`${bom}---\r\nname: c2-lan-acceptance\r\ndescription: 测试技能\r\n---\r\n正文`)
      const before = readFileSync(f.path)
      const skill = listSkillsOnDisk(f.root).find(s => s.path === f.path)
      expect(skill?.name).toBe('c2-lan-acceptance')
      expect(skill?.description).toBe('测试技能')
      const command = scanStaticSlashCommands(f.root).find(c => c.source?.path === f.path)
      expect(command?.name).toBe('/skill:c2-lan-acceptance')
      expect(command?.description).toBe('测试技能')
      expect(readFileSync(f.path)).toEqual(before)
    }
  })
  it('缺少或未闭合frontmatter仍按原规则回退目录名；不去掉中间或多个BOM', () => {
    for (const text of ['普通正文', '\uFEFF普通正文', '---\nname: unfinished', '\n\uFEFF---\nname: middle\n---\n正文', '\uFEFF\uFEFF---\nname: double\n---\n正文']) {
      const f = fixture(text)
      const before = readFileSync(f.path)
      expect(listSkillsOnDisk(f.root).find(s => s.path === f.path)?.name).toBe('artifact-id')
      expect(scanStaticSlashCommands(f.root).find(c => c.source?.path === f.path)?.name).toBe('/skill:artifact-id')
      expect(readFileSync(f.path)).toEqual(before)
    }
  })
})
