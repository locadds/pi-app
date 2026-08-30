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

import { listPiBuiltinPromptFiles } from '../pi-prompt-catalog'

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
  })
})
