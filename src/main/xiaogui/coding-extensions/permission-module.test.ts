import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  CodingPermissionIntentV1,
  CodingPermissionPromptV1,
  CodingPermissionUserChoiceV1,
} from '@shared/xiaogui-coding-extension-pack'
import {
  CodingPermissionModuleV1,
  type CodingPermissionUIPortV1,
} from './permission-module'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-coding-permission-'))
  roots.push(root)
  return join(root, 'permissions.sqlite')
}

function intent(overrides: Partial<CodingPermissionIntentV1> = {}): CodingPermissionIntentV1 {
  return {
    schemaVersion: 1,
    attemptId: 'xhba_attempt_1',
    requestDigest: `sha256:${'1'.repeat(64)}`,
    operation: 'WRITE',
    relativePaths: ['src/a.ts'],
    dataEgress: 'NONE',
    ...overrides,
  }
}

class ScriptedPermissionUI implements CodingPermissionUIPortV1 {
  readonly prompts: CodingPermissionPromptV1[] = []
  constructor(private readonly choices: CodingPermissionUserChoiceV1[]) {}
  async request(prompt: CodingPermissionPromptV1): Promise<CodingPermissionUserChoiceV1> {
    this.prompts.push(prompt)
    return this.choices.shift() ?? 'DENY'
  }
}

describe('CodingPermissionModuleV1', () => {
  it('支持仅一次放行，并只向 UI 暴露相对路径和安全摘要', async () => {
    const ui = new ScriptedPermissionUI(['ALLOW_ONCE'])
    const module = new CodingPermissionModuleV1({ dbPath: databasePath(), ui })

    await expect(module.decide(intent())).resolves.toBe('ALLOW_ONCE')
    expect(ui.prompts).toEqual([
      expect.objectContaining({
        operation: 'WRITE',
        relativePaths: ['src/a.ts'],
        choices: ['ALLOW_ONCE', 'ALLOW_TASK_RULE', 'DENY'],
      }),
    ])
    expect(JSON.stringify(ui.prompts)).not.toMatch(/[A-Z]:[\\/]/)
    module.close()
  })

  it('把本次任务规则持久化，重启后仅复用相同 Attempt、操作和路径', async () => {
    const dbPath = databasePath()
    const firstUI = new ScriptedPermissionUI(['ALLOW_TASK_RULE'])
    const first = new CodingPermissionModuleV1({ dbPath, ui: firstUI })
    await expect(first.decide(intent())).resolves.toBe('ALLOW_ONCE')
    first.close()

    const secondUI = new ScriptedPermissionUI(['DENY'])
    const restored = new CodingPermissionModuleV1({ dbPath, ui: secondUI })
    await expect(restored.decide(intent({ requestDigest: `sha256:${'2'.repeat(64)}` }))).resolves.toBe('ALLOW_ONCE')
    expect(secondUI.prompts).toHaveLength(0)
    await expect(restored.decide(intent({
      requestDigest: `sha256:${'3'.repeat(64)}`,
      relativePaths: ['src/b.ts'],
    }))).resolves.toBe('DENY')
    expect(secondUI.prompts).toHaveLength(1)
    restored.close()
  })

  it('拒绝绝对路径，并在 UI 超时或异常时默认拒绝', async () => {
    const request = vi.fn(async () => await new Promise<CodingPermissionUserChoiceV1>(() => undefined))
    const module = new CodingPermissionModuleV1({
      dbPath: databasePath(),
      ui: { request },
      timeoutMs: 5,
    })

    await expect(module.decide(intent({ relativePaths: ['C:/secret.txt'] }))).resolves.toBe('DENY')
    expect(request).not.toHaveBeenCalled()
    await expect(module.decide(intent())).resolves.toBe('DENY')
    module.close()

    const failed = new CodingPermissionModuleV1({
      dbPath: databasePath(),
      ui: { request: vi.fn(async () => { throw new Error('renderer unavailable') }) },
    })
    await expect(failed.decide(intent())).resolves.toBe('DENY')
    failed.close()
  })

  it('命令和外传必须携带可显示的精确元数据，并进入规则摘要', async () => {
    const ui = new ScriptedPermissionUI(['ALLOW_ONCE', 'ALLOW_ONCE'])
    const module = new CodingPermissionModuleV1({ dbPath: databasePath(), ui })

    await expect(module.decide(intent({
      operation: 'COMMAND',
      relativePaths: ['src/a.ts'],
      actionDigest: `sha256:${'a'.repeat(64)}`,
      commandSummary: 'npm run typecheck',
    }))).resolves.toBe('ALLOW_ONCE')
    await expect(module.decide(intent({
      requestDigest: `sha256:${'2'.repeat(64)}`,
      operation: 'DATA_EGRESS',
      relativePaths: ['src/a.ts'],
      dataEgress: 'REQUESTED',
      actionDigest: `sha256:${'b'.repeat(64)}`,
      egressDestination: 'approved.example.test',
    }))).resolves.toBe('ALLOW_ONCE')
    expect(ui.prompts).toEqual([
      expect.objectContaining({ operation: 'COMMAND', commandSummary: 'npm run typecheck' }),
      expect.objectContaining({
        operation: 'DATA_EGRESS',
        dataEgress: 'REQUESTED',
        egressDestination: 'approved.example.test',
      }),
    ])
    await expect(module.decide(intent({
      requestDigest: `sha256:${'3'.repeat(64)}`,
      operation: 'COMMAND',
      relativePaths: [],
      actionDigest: `sha256:${'c'.repeat(64)}`,
    }))).resolves.toBe('DENY')
    await expect(module.decide(intent({
      requestDigest: `sha256:${'4'.repeat(64)}`,
      operation: 'DATA_EGRESS',
      relativePaths: [],
      dataEgress: 'REQUESTED',
      actionDigest: `sha256:${'d'.repeat(64)}`,
    }))).resolves.toBe('DENY')
    expect(ui.prompts).toHaveLength(2)
    module.close()
  })

  it('任务规则只复用相同的私有动作摘要，并拒绝敏感展示摘要', async () => {
    const dbPath = databasePath()
    const firstUI = new ScriptedPermissionUI(['ALLOW_TASK_RULE'])
    const first = new CodingPermissionModuleV1({ dbPath, ui: firstUI })
    await expect(first.decide(intent({
      operation: 'COMMAND',
      actionDigest: `sha256:${'a'.repeat(64)}`,
      commandSummary: 'npm run typecheck',
    }))).resolves.toBe('ALLOW_ONCE')
    first.close()

    const secondUI = new ScriptedPermissionUI(['DENY'])
    const restored = new CodingPermissionModuleV1({ dbPath, ui: secondUI })
    await expect(restored.decide(intent({
      requestDigest: `sha256:${'2'.repeat(64)}`,
      operation: 'COMMAND',
      actionDigest: `sha256:${'a'.repeat(64)}`,
      commandSummary: 'npm run typecheck',
    }))).resolves.toBe('ALLOW_ONCE')
    await expect(restored.decide(intent({
      requestDigest: `sha256:${'3'.repeat(64)}`,
      operation: 'COMMAND',
      actionDigest: `sha256:${'b'.repeat(64)}`,
      commandSummary: 'npm run typecheck',
    }))).resolves.toBe('DENY')
    expect(secondUI.prompts).toHaveLength(1)
    for (const commandSummary of [
      'run C:/secret/token.txt',
      'run(C:/Users/alice/key.txt)',
      'Authorization: Bearer abc123',
      'token abc123',
    ]) {
      await expect(restored.decide(intent({
        requestDigest: `sha256:${'4'.repeat(64)}`,
        operation: 'COMMAND',
        actionDigest: `sha256:${'c'.repeat(64)}`,
        commandSummary,
      }))).resolves.toBe('DENY')
    }
    expect(secondUI.prompts).toHaveLength(1)
    restored.close()
  })
})
