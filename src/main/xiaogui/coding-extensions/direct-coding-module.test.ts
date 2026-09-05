import { createHash } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DirectCodingAuthorizationSubjectV2 } from '@shared/xiaogui-direct-coding'
import type { ProjectId, SessionKey } from '@shared/xiaogui-session-scope'
import type { DirectCodingAuthorizationPortV2 } from './coding-authorization-module'
import { CodingAuthorizationModuleV2 } from './coding-authorization-module'
import { DirectCodingModuleV2, inspectProjectPath } from './direct-coding-module'

const roots: string[] = []
const subject = {
  schemaVersion: 2 as const,
  kind: 'DIRECT_SESSION' as const,
  address: {
    projectId: `xgp1_${'a'.repeat(64)}` as ProjectId,
    sessionKey: `xgs1_${'b'.repeat(64)}` as SessionKey,
  },
} satisfies DirectCodingAuthorizationSubjectV2

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DirectCodingModuleV2', () => {
  it('checkpoints and restores an existing file without an Attempt or conversation rollback', async () => {
    const root = await tempRoot()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/a.ts'), 'before\n')
    const ui = { request: vi.fn(async () => 'DENY' as const) }
    const module = moduleFor(root, new CodingAuthorizationModuleV2({
      directUi: ui,
      taskHub: { decide: vi.fn(async () => 'DENY' as const) },
    }))

    const requestDigest = digest('modify-existing')
    const firstPreflight = await module.preflight(
      input(root, 'write-1', requestDigest, 'WRITE', 'AUTO_APPROVE', join(root, 'src/a.ts')),
    )
    expect(firstPreflight).toMatchObject({
      decision: 'ALLOW',
      state: 'ALLOWED',
      reasonCode: 'MODE_POLICY_AUTO_ALLOWED',
      authorizedRelativePath: 'src/a.ts',
    })
    expect(ui.request).not.toHaveBeenCalled()
    expect(module.list(subject)).toMatchObject({
      ok: true,
      value: { checkpoints: [] },
    })
    const firstBegin = await module.begin(lifecycle(root, 'write-1', requestDigest))
    expect(firstBegin).toMatchObject({
      decision: 'ALLOW',
      state: 'EXECUTING',
      authorizedRelativePath: 'src/a.ts',
    })
    if (firstPreflight.decision !== 'ALLOW' || firstBegin.decision !== 'ALLOW') {
      throw new Error('first lifecycle request should be allowed')
    }
    expect(firstBegin.authorizedRelativePath).toBe(firstPreflight.authorizedRelativePath)
    await expect(module.preflight(
      input(root, 'write-1', requestDigest, 'WRITE', 'AUTO_APPROVE', join(root, 'src/a.ts')),
    )).resolves.toEqual(expect.objectContaining({
      decision: 'DENY',
      reasonCode: 'DUPLICATE_REQUEST_NOT_REPLAYED',
    }))
    const duplicatePreflight = await module.preflight(
      input(root, 'write-1', requestDigest, 'WRITE', 'AUTO_APPROVE', join(root, 'src/a.ts')),
    )
    const duplicateBegin = await module.begin(lifecycle(root, 'write-1', requestDigest))
    expect(duplicatePreflight).not.toHaveProperty('authorizedRelativePath')
    expect(duplicateBegin).toMatchObject({
      decision: 'DENY',
      reasonCode: 'DUPLICATE_EXECUTION',
    })
    expect(duplicateBegin).not.toHaveProperty('authorizedRelativePath')
    writeFileSync(join(root, 'src/a.ts'), 'after\n')
    await expect(module.settle({ ...lifecycle(root, 'write-1', requestDigest), isError: false }))
      .resolves.toMatchObject({ state: 'SETTLED' })

    const listed = module.list(subject)
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error('checkpoint missing')
    const checkpoint = listed.value.checkpoints[0]
    expect(checkpoint).toMatchObject({
      schemaVersion: 2,
      subject: 'DIRECT_SESSION',
      toolCallId: 'write-1',
      relativePath: 'src/a.ts',
      existedBefore: true,
      status: 'AVAILABLE',
    })
    expect('attemptId' in checkpoint).toBe(false)

    const preview = module.prepareRestore(subject, root, checkpoint.checkpointToken)
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error('preview missing')
    expect(preview.value.preview).toMatchObject({
      action: 'RESTORE_PREVIOUS_BYTES',
      conversationEffect: 'UNCHANGED',
    })
    const restored = module.confirmRestore(subject, root, {
      checkpointToken: checkpoint.checkpointToken,
      previewToken: preview.value.preview.previewToken,
      previewDigest: preview.value.preview.previewDigest,
    })
    expect(restored).toMatchObject({ ok: true, value: { checkpoint: { status: 'RESTORED' } } })
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('before\n')
    module.close()
  })

  it('removes a newly created file on restore and preserves unrelated dirty content', async () => {
    const root = await tempRoot()
    writeFileSync(join(root, 'unrelated.txt'), 'user dirty change')
    const module = moduleFor(root, allowAll())
    const requestDigest = digest('create-new')

    await expect(module.preflight(input(root, 'write-2', requestDigest, 'WRITE', 'FULL_AUTONOMY', 'new.txt')))
      .resolves.toMatchObject({ decision: 'ALLOW', state: 'ALLOWED' })
    await expect(module.begin(lifecycle(root, 'write-2', requestDigest))).resolves.toMatchObject({ decision: 'ALLOW' })
    writeFileSync(join(root, 'new.txt'), 'created')
    await module.settle({ ...lifecycle(root, 'write-2', requestDigest), isError: false })

    const listed = module.list(subject)
    if (!listed.ok) throw new Error('checkpoint missing')
    const checkpoint = listed.value.checkpoints[0]
    const preview = module.prepareRestore(subject, root, checkpoint.checkpointToken)
    if (!preview.ok) throw new Error('preview missing')
    expect(preview.value.preview.action).toBe('REMOVE_CREATED_FILE')
    expect(module.confirmRestore(subject, root, {
      checkpointToken: checkpoint.checkpointToken,
      previewToken: preview.value.preview.previewToken,
      previewDigest: preview.value.preview.previewDigest,
    }).ok).toBe(true)
    expect(() => readFileSync(join(root, 'new.txt'))).toThrow()
    expect(readFileSync(join(root, 'unrelated.txt'), 'utf8')).toBe('user dirty change')
    module.close()
  })

  it('rechecks the file after permission and refuses to checkpoint changed content', async () => {
    const root = await tempRoot()
    writeFileSync(join(root, 'a.txt'), 'before')
    const authorization: DirectCodingAuthorizationPortV2 = {
      decideDirect: vi.fn(async () => {
        writeFileSync(join(root, 'a.txt'), 'changed while waiting')
        return {
          decision: 'ALLOW_ONCE' as const,
          reasonCode: 'USER_ALLOWED_ONCE' as const,
        }
      }),
    }
    const module = moduleFor(root, authorization)
    await expect(module.preflight(input(
      root,
      'write-race',
      digest('write-race'),
      'WRITE',
      'CONFIRM_EACH',
      'a.txt',
    ))).resolves.toMatchObject({
      decision: 'DENY',
      state: 'SETTLED',
      reasonCode: 'PATH_CHANGED_AFTER_AUTHORIZATION',
    })
    const listed = module.list(subject)
    expect(listed.ok && listed.value.checkpoints).toHaveLength(0)
    module.close()
  })

  it('keeps Bash outside the checkpoint promise and never replays a duplicate call', async () => {
    const root = await tempRoot()
    const ui = { request: vi.fn(async () => 'ALLOW_ONCE' as const) }
    const module = moduleFor(root, new CodingAuthorizationModuleV2({
      directUi: ui,
      taskHub: { decide: vi.fn(async () => 'DENY' as const) },
    }))
    const requestDigest = digest('bash-call')
    const bashInput = {
      ...input(root, 'bash-1', requestDigest, 'BASH', 'FULL_AUTONOMY'),
      commandText: 'git status --short',
      commandDigest: digest('git status --short'),
    }
    await expect(module.preflight(bashInput)).resolves.toMatchObject({ decision: 'ALLOW', state: 'ALLOWED' })
    expect(ui.request).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'BASH',
      choices: ['ALLOW_ONCE', 'DENY'],
      commandText: 'git status --short',
    }), expect.objectContaining({ projectLabel: '测试项目' }))
    expect(module.list(subject)).toMatchObject({ ok: true, value: { checkpoints: [] } })
    await expect(module.begin(lifecycle(root, 'bash-1', requestDigest))).resolves.toMatchObject({ state: 'EXECUTING' })
    await expect(module.settle({
      ...lifecycle(root, 'bash-1', requestDigest),
      isError: false,
      exitCode: 0,
    })).resolves.toMatchObject({ state: 'SETTLED' })
    await expect(module.preflight(bashInput)).resolves.toMatchObject({
      decision: 'DENY',
      state: 'SETTLED',
      reasonCode: 'DUPLICATE_REQUEST_NOT_REPLAYED',
    })
    expect(ui.request).toHaveBeenCalledTimes(1)
    module.close()
  })

  it('marks an interrupted allowed write unknown and does not replay it after restart', async () => {
    const root = await tempRoot()
    writeFileSync(join(root, 'a.txt'), 'before')
    const dbPath = join(root, 'direct.sqlite')
    const requestDigest = digest('interrupted')
    const first = moduleFor(root, allowAll(), dbPath)
    await first.preflight(input(root, 'write-unknown', requestDigest, 'WRITE', 'AUTO_APPROVE', 'a.txt'))
    first.close()

    const restarted = moduleFor(root, allowAll(), dbPath)
    await expect(restarted.preflight(input(
      root,
      'write-unknown',
      requestDigest,
      'WRITE',
      'AUTO_APPROVE',
      'a.txt',
    ))).resolves.toMatchObject({
      decision: 'DENY',
      state: 'OUTCOME_UNKNOWN',
      reasonCode: 'DUPLICATE_REQUEST_NOT_REPLAYED',
    })
    expect(restarted.list(subject)).toMatchObject({
      ok: true,
      value: { checkpoints: [expect.objectContaining({ status: 'OUTCOME_UNKNOWN' })] },
    })
    restarted.close()
  })

  it('rejects traversal, .git, junction and hardlink writes', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    writeFileSync(join(root, 'linked.txt'), 'shared')
    linkSync(join(root, 'linked.txt'), join(root, 'alias.txt'))
    mkdirSync(join(outside, 'external'))
    writeFileSync(join(outside, 'external/out.txt'), 'outside')
    symlinkSync(join(outside, 'external'), join(root, 'junction'), 'junction')

    expect(() => inspectProjectPath(root, '../outside.txt', 'WRITE')).toThrow('PATH_OUTSIDE_PROJECT')
    expect(() => inspectProjectPath(root, '.git/config', 'WRITE')).toThrow('PATH_INVALID')
    expect(() => inspectProjectPath(root, join(outside, 'external/out.txt'), 'WRITE')).toThrow('PATH_OUTSIDE_PROJECT')
    expect(() => inspectProjectPath(root, 'junction/out.txt', 'WRITE')).toThrow('PATH_LINK_REJECTED')
    expect(() => inspectProjectPath(root, 'linked.txt', 'WRITE')).toThrow('PATH_HARDLINK_REJECTED')
    expect(inspectProjectPath(root, './alias.txt', 'READ').relativePath).toBe('alias.txt')
    expect(inspectProjectPath(root, join(root, 'alias.txt'), 'READ').relativePath).toBe('alias.txt')
  })

  it('refuses restore when the file changed after the recorded tool result', async () => {
    const root = await tempRoot()
    writeFileSync(join(root, 'a.txt'), 'before')
    const module = moduleFor(root, allowAll())
    const requestDigest = digest('restore-conflict')
    await module.preflight(input(root, 'write-conflict', requestDigest, 'WRITE', 'AUTO_APPROVE', 'a.txt'))
    await module.begin(lifecycle(root, 'write-conflict', requestDigest))
    writeFileSync(join(root, 'a.txt'), 'tool result')
    await module.settle({ ...lifecycle(root, 'write-conflict', requestDigest), isError: false })
    const listed = module.list(subject)
    if (!listed.ok) throw new Error('checkpoint missing')
    writeFileSync(join(root, 'a.txt'), 'later user change')
    expect(module.prepareRestore(subject, root, listed.value.checkpoints[0].checkpointToken))
      .toMatchObject({ ok: false, error: { code: 'CHECKPOINT_CONFLICT' } })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('later user change')
    module.close()
  })

  it('refuses preview and restore when the current trusted project root changed', async () => {
    const root = await tempRoot()
    const otherRoot = await tempRoot()
    writeFileSync(join(root, 'a.txt'), 'before')
    writeFileSync(join(otherRoot, 'a.txt'), 'unrelated project')
    const module = moduleFor(root, allowAll())
    const requestDigest = digest('restore-root-binding')
    await module.preflight(input(root, 'write-root-binding', requestDigest, 'WRITE', 'AUTO_APPROVE', 'a.txt'))
    await module.begin(lifecycle(root, 'write-root-binding', requestDigest))
    writeFileSync(join(root, 'a.txt'), 'tool result')
    await module.settle({ ...lifecycle(root, 'write-root-binding', requestDigest), isError: false })
    const listed = module.list(subject)
    if (!listed.ok) throw new Error('checkpoint missing')
    const checkpointToken = listed.value.checkpoints[0].checkpointToken

    expect(module.prepareRestore(subject, otherRoot, checkpointToken))
      .toMatchObject({ ok: false, error: { code: 'CHECKPOINT_CONFLICT' } })
    const preview = module.prepareRestore(subject, root, checkpointToken)
    if (!preview.ok) throw new Error('preview missing')
    expect(module.confirmRestore(subject, otherRoot, {
      checkpointToken,
      previewToken: preview.value.preview.previewToken,
      previewDigest: preview.value.preview.previewDigest,
    })).toMatchObject({ ok: false, error: { code: 'CHECKPOINT_CONFLICT' } })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('tool result')
    expect(readFileSync(join(otherRoot, 'a.txt'), 'utf8')).toBe('unrelated project')
    module.close()
  })

  it('rejects execution when the directory entity is replaced at the same path', async () => {
    const stateRoot = await tempRoot()
    const root = join(stateRoot, 'project')
    mkdirSync(root)
    writeFileSync(join(root, 'a.txt'), 'before')
    const module = moduleFor(root, allowAll(), join(stateRoot, 'direct.sqlite'))
    const requestDigest = digest('same-path-replacement')

    await expect(module.preflight(input(
      root,
      'same-path-write',
      requestDigest,
      'WRITE',
      'AUTO_APPROVE',
      'a.txt',
    ))).resolves.toMatchObject({ decision: 'ALLOW' })
    renameSync(root, join(stateRoot, 'old-project'))
    mkdirSync(root)
    writeFileSync(join(root, 'a.txt'), 'replacement project')

    await expect(module.begin(lifecycle(root, 'same-path-write', requestDigest))).resolves.toMatchObject({
      decision: 'DENY',
      state: 'OUTCOME_UNKNOWN',
      reasonCode: 'PROJECT_IDENTITY_CHANGED',
    })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('replacement project')
    module.close()
  })

  it('does not read a large file during READ authorization and refuses an uncheckpointed write', async () => {
    const root = await tempRoot()
    const largePath = join(root, 'large.bin')
    writeFileSync(largePath, Buffer.alloc(16 * 1024 * 1024 + 1, 7))
    const module = moduleFor(root, allowAll())

    await expect(module.preflight(input(
      root,
      'large-read',
      digest('large-read'),
      'READ',
      'AUTO_APPROVE',
      largePath,
    ))).resolves.toMatchObject({ decision: 'ALLOW', state: 'ALLOWED' })
    await expect(module.preflight(input(
      root,
      'large-write',
      digest('large-write'),
      'WRITE',
      'AUTO_APPROVE',
      './large.bin',
    ))).resolves.toMatchObject({
      decision: 'DENY',
      state: 'SETTLED',
      reasonCode: 'CHECKPOINT_FILE_TOO_LARGE',
    })
    module.close()
  })
})

function moduleFor(
  root: string,
  authorization: DirectCodingAuthorizationPortV2,
  dbPath = join(root, 'direct.sqlite'),
) {
  let sequence = 0
  return new DirectCodingModuleV2({
    dbPath,
    authorization,
    now: () => '2026-09-05T00:00:00.000Z',
    token: (prefix) => `${prefix}_token-${String(++sequence).padStart(4, '0')}`,
  })
}

function allowAll(): DirectCodingAuthorizationPortV2 {
  return {
    decideDirect: vi.fn(async () => ({
      decision: 'ALLOW_ONCE' as const,
      reasonCode: 'MODE_POLICY_AUTO_ALLOWED' as const,
    })),
  }
}

function input(
  rootPath: string,
  toolCallId: string,
  requestDigest: string,
  operation: 'READ' | 'EDIT' | 'WRITE' | 'BASH',
  mode: 'CONFIRM_EACH' | 'AUTO_APPROVE' | 'FULL_AUTONOMY',
  path?: string,
) {
  return {
    subject,
    rootPath,
    sourceSessionId: 'pi-session-1',
    toolCallId,
    requestDigest,
    operation,
    mode,
    ...(path ? { path } : {}),
    origin: {
      projectLabel: '测试项目',
      sessionLabel: '测试对话',
      fromCwd: rootPath,
      fromPoolKey: 'D:/session.jsonl',
      sessionFile: 'D:/session.jsonl',
      sourceSessionId: 'pi-session-1',
    },
  }
}

function lifecycle(rootPath: string, toolCallId: string, requestDigest: string) {
  return {
    subject,
    rootPath,
    sourceSessionId: 'pi-session-1',
    toolCallId,
    requestDigest,
  }
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-direct-coding-'))
  roots.push(root)
  return root
}
