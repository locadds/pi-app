import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { createReadTool, loadSkills } from '@earendil-works/pi-coding-agent'

describe('xiaogui bundled Skills', () => {
  const skillRoot = join(process.cwd(), 'resources', 'pi-skills')

  it('is discovered by the pinned Pi native Skill loader without diagnostics', () => {
    const result = loadSkills({
      cwd: process.cwd(),
      agentDir: join(process.cwd(), '.pi-test-agent'),
      skillPaths: [skillRoot],
      includeDefaults: false,
    })

    expect(result.diagnostics).toEqual([])
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      'internal-comms',
      'xiaogui-work-documents',
    ])
  })

  it('loads a discovered Skill body using the pinned Pi native read tool', async () => {
    const { skills } = loadSkills({
      cwd: process.cwd(), agentDir: join(process.cwd(), '.pi-test-agent'),
      skillPaths: [skillRoot], includeDefaults: false,
    })
    const skill = skills.find((entry) => entry.name === 'xiaogui-work-documents')!
    const result = await createReadTool(process.cwd()).execute('skill-read-smoke', { path: skill.filePath })
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('先判断任务意图') }),
    ]))
  })

  it('keeps document intent routing in the Skill and preserves the PDF formal-template boundary', () => {
    const skill = readFileSync(join(skillRoot, 'xiaogui-work-documents', 'SKILL.md'), 'utf8')
    expect(skill).toContain('xiaogui_read_pdf')
    expect(skill).toContain('xiaogui_work_read_materials')
    expect(skill).toContain('xiaogui_work_docx_template_intake')
    expect(skill).toContain('PDF 当前只支持读取、分析和只读报告')
    expect(skill).not.toContain('中央文件类型路由器')
  })
})
