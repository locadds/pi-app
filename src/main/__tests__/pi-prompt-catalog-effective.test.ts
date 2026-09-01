import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../pi-skill-overrides', () => ({
  readGlobalSettingsJson: () => ({}),
}))

vi.mock('../agent-dir', () => ({
  resolveActiveAgentDir: () => 'C:/xiaogui-test-agent',
}))

import {
  groupPromptCatalog,
  listCodeOwnedPromptCatalogFiles,
  listPiBuiltinPromptFiles,
  type PromptCatalogItem,
  type PromptCategory,
} from '../pi-prompt-catalog'
import {
  readCodeOwnedPromptCatalogResourceV1,
} from '../pi-prompt-catalog-virtual-resources'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Pi Prompt catalog Effective Prompt entry', () => {
  it('keeps real Effective Prompt diagnostics available when a project SYSTEM.md exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-prompt-catalog-'))
    roots.push(root)
    mkdirSync(join(root, '.pi'), { recursive: true })
    writeFileSync(join(root, '.pi', 'SYSTEM.md'), '# custom system')

    const entries = listPiBuiltinPromptFiles(root, true)

    expect(entries.map((entry) => entry.id)).toContain('builtin:system:default')
    expect(entries.find((entry) => entry.id === 'builtin:system:default')?.category)
      .toBe('product_system_layers')
    expect(entries.find((entry) => entry.id === 'builtin:system:project')?.category)
      .toBe('user_system_append')
  })

  it('groups the catalog by the six product concepts instead of System-context membership', () => {
    const categories: PromptCategory[] = [
      'product_system_layers',
      'user_system_append',
      'project_context',
      'slash_prompt_templates',
      'tool_capability_guidelines',
      'subtask_prompts',
    ]
    const items = categories.map((category, index): PromptCatalogItem => ({
      id: `item-${index}`,
      category,
      name: category,
      description: '',
      path: null,
      command: '',
      editable: false,
      inSystemContext: index % 2 === 0,
    }))

    expect(groupPromptCatalog(items).map((group) => group.category)).toEqual(categories)
  })

  it('exposes code-owned capability, tool and subtask resources as read-only virtual URIs', () => {
    const entries = listCodeOwnedPromptCatalogFiles()

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'builtin:capability-registry',
        category: 'tool_capability_guidelines',
        readOnly: true,
        editable: false,
      }),
      expect.objectContaining({
        id: 'builtin:tool-guidelines',
        category: 'tool_capability_guidelines',
        readOnly: true,
        editable: false,
      }),
      expect.objectContaining({
        id: 'builtin:subtask:template-intake-analysis',
        category: 'subtask_prompts',
        readOnly: true,
        editable: false,
      }),
    ]))
    expect(entries.every((entry) => entry.path?.startsWith('xiaogui://'))).toBe(true)
    expect(entries.every((entry) => !/^[A-Za-z]:[\\/]/.test(entry.path || ''))).toBe(true)

    const subtask = entries.find((entry) => entry.id === 'builtin:subtask:template-intake-analysis')
    expect(readCodeOwnedPromptCatalogResourceV1(subtask?.path || '')?.content)
      .toContain('template-intake-analysis@1.2.0')
    expect(readCodeOwnedPromptCatalogResourceV1(subtask?.path || '')?.content)
      .toContain('其他 OTHER')
  })

})
