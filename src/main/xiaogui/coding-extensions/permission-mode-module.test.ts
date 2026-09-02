import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import type { CodingPermissionIntentV1 } from '@shared/xiaogui-coding-extension-pack'
import {
  CodingPermissionModeModuleV1,
  codingPermissionPolicyDigestV1,
  taskHubBoundaryState,
} from './permission-mode-module'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CodingPermissionModeModuleV1', () => {
  it('captures one selected mode, binds it immutably, and restores it after restart', async () => {
    const root = await tempRoot()
    const dbPath = join(root, 'permission.sqlite')
    let selected: unknown = 'AUTO_APPROVE'
    const first = moduleFor(dbPath, () => selected)
    const captured = first.captureSelection()
    const binding = first.bindAttempt('attempt-p1b', captured)
    expect(binding).toMatchObject({
      attemptId: 'attempt-p1b',
      mode: 'AUTO_APPROVE',
      source: 'USER_SELECTED',
      policyDigest: codingPermissionPolicyDigestV1('AUTO_APPROVE'),
    })

    selected = 'FULL_AUTONOMY'
    expect(first.readAttemptBinding('attempt-p1b')?.mode).toBe('AUTO_APPROVE')
    expect(() => first.bindAttempt('attempt-p1b', first.captureSelection()))
      .toThrow('CODING_PERMISSION_MODE_ATTEMPT_ALREADY_BOUND')
    first.close()

    const restarted = moduleFor(dbPath, () => selected)
    expect(restarted.verifyAttemptBinding('attempt-p1b', captured)).toBe(true)
    expect(restarted.readAttemptBinding('attempt-p1b')?.mode).toBe('AUTO_APPROVE')
    restarted.close()
  })

  it('falls back to confirm-each for an invalid global preference', async () => {
    const root = await tempRoot()
    const module = moduleFor(join(root, 'permission.sqlite'), () => 'UNKNOWN')
    expect(module.captureSelection()).toMatchObject({ mode: 'CONFIRM_EACH' })
    module.close()
  })

  it('rejects a tampered policy digest on recovery', async () => {
    const root = await tempRoot()
    const dbPath = join(root, 'permission.sqlite')
    const first = moduleFor(dbPath, () => 'AUTO_APPROVE')
    first.bindAttempt('attempt-p1b', first.captureSelection())
    first.close()

    const db = new DatabaseSync(dbPath)
    db.prepare(`
      update xiaogui_coding_permission_mode_bindings_v1
      set policy_digest = 'sha256:tampered'
      where attempt_id = 'attempt-p1b'
    `).run()
    db.close()

    const restarted = moduleFor(dbPath, () => 'AUTO_APPROVE')
    expect(() => restarted.readAttemptBinding('attempt-p1b'))
      .toThrow('CODING_PERMISSION_MODE_BINDING_INVALID')
    restarted.close()
  })

  it('auto-allows only TaskHub-verified file operations and keeps command and egress closed', async () => {
    const root = await tempRoot()
    const manifest = {
      attemptId: 'attempt-p1b',
      version: 1,
      grants: [
        { operation: 'MODIFY' as const, relativePath: 'src/allowed.ts', baselineDigest: 'sha256:base' },
      ],
      manifestDigest: 'sha256:manifest',
    }
    const module = new CodingPermissionModeModuleV1({
      dbPath: join(root, 'permission.sqlite'),
      readSelectedMode: () => 'FULL_AUTONOMY',
      readAttemptManifest: () => manifest,
      now: () => '2026-09-02T00:00:00.000Z',
    })
    module.bindAttempt('attempt-p1b', module.captureSelection())

    await expect(module.evaluate(intent('WRITE', ['src/allowed.ts']))).resolves.toMatchObject({
      effect: 'ALLOW_ONCE',
      mode: 'FULL_AUTONOMY',
    })
    await expect(module.evaluate(intent('WRITE', ['src/outside.ts']))).resolves.toMatchObject({
      effect: 'DENY',
      reasonCode: 'TASKHUB_BOUNDARY_DENIED',
    })
    await expect(module.evaluate(intent('COMMAND', ['src/allowed.ts']))).resolves.toMatchObject({
      effect: 'DENY',
      reasonCode: 'TASKHUB_BOUNDARY_UNVERIFIED',
    })
    await expect(module.evaluate(intent('DATA_EGRESS', ['src/allowed.ts']))).resolves.toMatchObject({
      effect: 'DENY',
      reasonCode: 'TASKHUB_BOUNDARY_UNVERIFIED',
    })
    module.close()
  })

  it('does not infer a hard boundary from absolute paths or a mismatched manifest', () => {
    const manifest = {
      attemptId: 'attempt-p1b',
      version: 1,
      grants: [{ operation: 'MODIFY' as const, relativePath: 'src/allowed.ts' }],
      manifestDigest: 'sha256:manifest',
    }
    expect(taskHubBoundaryState(intent('READ', ['D:/secret.txt']), manifest)).toBe('DENIED')
    expect(taskHubBoundaryState(intent('READ', ['.git/config']), manifest)).toBe('DENIED')
    expect(taskHubBoundaryState(intent('READ', ['src/allowed.ts']), {
      ...manifest,
      attemptId: 'other-attempt',
    })).toBe('UNVERIFIED')
  })
})

function moduleFor(dbPath: string, readSelectedMode: () => unknown): CodingPermissionModeModuleV1 {
  return new CodingPermissionModeModuleV1({
    dbPath,
    readSelectedMode,
    readAttemptManifest: () => undefined,
    now: () => '2026-09-02T00:00:00.000Z',
  })
}

function intent(
  operation: CodingPermissionIntentV1['operation'],
  relativePaths: readonly string[],
): CodingPermissionIntentV1 {
  return {
    schemaVersion: 1,
    attemptId: 'attempt-p1b',
    requestDigest: `sha256:${operation.toLowerCase()}-${relativePaths.join('-')}`,
    operation,
    relativePaths,
    dataEgress: operation === 'DATA_EGRESS' ? 'REQUESTED' : 'NONE',
    ...((operation === 'COMMAND' || operation === 'DATA_EGRESS')
      ? { actionDigest: `sha256:${'a'.repeat(64)}` }
      : {}),
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-permission-mode-'))
  roots.push(root)
  return root
}
