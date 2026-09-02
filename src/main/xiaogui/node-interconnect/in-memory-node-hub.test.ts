import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateXiaoguiNodePublicDtoV1, type XiaoguiNodeCapabilityManifestV1 } from '@shared/xiaogui-node-contract'
import { createInMemoryXiaoguiNodeHubV1 } from './in-memory-node-hub'

describe('InMemory Xiaogui node hub v1', () => {
  it('routes one assignment between isolated Xiaogui nodes without exposing agent-private details', async () => {
    let id = 0
    const hub = createInMemoryXiaoguiNodeHubV1({
      hubId: 'hub-1',
      now: () => '2026-08-25T00:00:00.000Z',
      idFactory: (prefix) => `${prefix}_${++id}`,
      trustedManifests: new Map([
        ['node-a', node('node-a', ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.EXTERNAL_ALLOWED'], 'EXTERNAL_ALLOWED')],
        ['node-b', node('node-b', ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'], 'LOCAL_ONLY')],
      ]),
    })

    await expect(hub.register(node('node-a', ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.EXTERNAL_ALLOWED'], 'EXTERNAL_ALLOWED'))).resolves.toEqual({ ok: true })
    await expect(hub.register(node('node-b', ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'], 'LOCAL_ONLY'))).resolves.toEqual({ ok: true })

    const offered = await hub.offer({
      taskId: 'task-1',
      requiredCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT'],
      dataEgressPolicy: 'LOCAL_ONLY',
      payloadRef: {
        mediaType: 'application/vnd.xiaogui.assignment-payload+json',
        artifactId: 'artifact-1',
        digest: 'sha256:payload',
      },
    })
    expect(offered).toMatchObject({
      ok: true,
      envelope: {
        targetNodeId: 'node-b',
        humanApproval: 'REQUIRED',
        status: 'AWAITING_LOCAL_APPROVAL',
      },
    })
    if (!offered.ok) throw new Error('offer failed')
    await expect(hub.markRunning('node-b', offered.envelope.assignmentId, offered.envelope.leaseId)).resolves.toEqual({
      ok: false,
      reasonCode: 'ASSIGNMENT_STATUS_INVALID',
    })
    await expect(hub.approveLocal('node-a', offered.envelope.assignmentId, offered.envelope.leaseId)).resolves.toEqual({
      ok: false,
      reasonCode: 'ASSIGNMENT_NODE_MISMATCH',
    })
    await expect(hub.approveLocal('node-b', offered.envelope.assignmentId, offered.envelope.leaseId)).resolves.toEqual({ ok: true })
    await expect(hub.markRunning('node-b', offered.envelope.assignmentId, offered.envelope.leaseId)).resolves.toEqual({ ok: true })
    await expect(hub.complete('node-b', offered.envelope.assignmentId, offered.envelope.leaseId, 'sha256:result')).resolves.toEqual({ ok: true })

    const publicEvents = JSON.stringify(hub.events())
    expect(validateXiaoguiNodePublicDtoV1(hub.events())).toEqual({ ok: true })
    expect(publicEvents).not.toMatch(/kimi|qoder|codex|adapter|runtimeSession|C:\\|D:\\|token|secret|prompt/i)
  })

  it('rejects duplicate assignment and expired lease transitions', async () => {
    let now = '2026-08-25T00:00:00.000Z'
    let id = 0
    const hub = createInMemoryXiaoguiNodeHubV1({
      now: () => now,
      idFactory: (prefix) => `${prefix}_${++id}`,
      trustedManifests: new Map([
        ['node-a', node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'], 'LOCAL_ONLY', 1000)],
      ]),
    })
    await hub.register(node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'], 'LOCAL_ONLY', 1000))
    const input = {
      taskId: 'task-template',
      requiredCapabilities: ['WORK.DOCX.TEMPLATE' as const],
      dataEgressPolicy: 'LOCAL_ONLY' as const,
      payloadRef: {
        mediaType: 'application/vnd.xiaogui.assignment-payload+json' as const,
        artifactId: 'artifact-template',
        digest: 'sha256:template-payload',
      },
    }
    const offered = await hub.offer(input)
    expect(offered).toMatchObject({ ok: true })
    await expect(hub.offer(input)).resolves.toEqual({ ok: false, reasonCode: 'ASSIGNMENT_ALREADY_EXISTS' })
    if (!offered.ok) throw new Error('offer failed')

    now = '2026-08-25T00:00:02.000Z'
    await expect(hub.approveLocal('node-a', offered.envelope.assignmentId, offered.envelope.leaseId)).resolves.toEqual({
      ok: false,
      reasonCode: 'ASSIGNMENT_LEASE_EXPIRED',
    })
    expect(hub.events()).toContainEqual(expect.objectContaining({
      type: 'ASSIGNMENT_LEASE_EXPIRED',
      assignmentId: offered.envelope.assignmentId,
    }))
  })

  it('rejects manifests and payloads that leak local paths or runtime-private names', async () => {
    const hub = createInMemoryXiaoguiNodeHubV1({
      trustedManifests: new Map([
        ['node-a', node('node-a', ['CODING.GIT.CHANGESET'], 'EXTERNAL_ALLOWED')],
      ]),
    })
    await expect(hub.register({ ...node('node-a', ['CODING.GIT.CHANGESET'], 'EXTERNAL_ALLOWED'), displayPath: 'D:\\secret' } as unknown as XiaoguiNodeCapabilityManifestV1)).resolves.toEqual({
      ok: false,
      reasonCode: 'PUBLIC_DTO_LEAK',
    })
    await expect(hub.offer({
      taskId: 'task-1',
      requiredCapabilities: ['CODING.GIT.CHANGESET'],
      dataEgressPolicy: 'EXTERNAL_ALLOWED',
      payloadRef: {
        mediaType: 'application/vnd.xiaogui.assignment-payload+json',
        artifactId: 'codex-private-session',
        digest: 'sha256:payload',
      },
    })).resolves.toEqual({
      ok: false,
      reasonCode: 'NODE_PUBLIC_DTO_LEAK',
    })
  })

  it('persists task identity and unknown or expired outcomes across Hub process restarts', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'xiaogui-hub-assignment-store-'))
    let now = '2026-08-27T05:00:00.000Z'
    let id = 0
    const options = {
      hubId: 'hub-persisted',
      userDataDir,
      now: () => now,
      idFactory: (prefix: string) => `${prefix}_${++id}`,
      trustedManifests: new Map([
        ['node-a', node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'], 'LOCAL_ONLY', 1_000)],
      ]),
    }
    const unknownTask = task('task-unknown-after-restart')
    const expiringTask = task('task-expired-after-restart')
    try {
      const first = createInMemoryXiaoguiNodeHubV1(options)
      await first.register(node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'], 'LOCAL_ONLY', 1_000))
      const unknown = await first.offer(unknownTask)
      if (!unknown.ok) throw new Error('unknown task offer failed')
      await first.claim('node-a')
      await first.outcomeUnknown(
        'node-a',
        unknown.envelope.assignmentId,
        unknown.envelope.leaseId,
        'RESULT_DELIVERY_UNCONFIRMED',
      )
      const expiring = await first.offer(expiringTask)
      if (!expiring.ok) throw new Error('expiring task offer failed')

      const restarted = createInMemoryXiaoguiNodeHubV1(options)
      await restarted.register(node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'], 'LOCAL_ONLY', 1_000))
      await expect(restarted.offer(unknownTask)).resolves.toEqual({ ok: false, reasonCode: 'ASSIGNMENT_ALREADY_EXISTS' })
      await expect(restarted.reconcile(unknown.envelope.assignmentId)).resolves.toEqual({
        ok: true,
        status: 'OUTCOME_UNKNOWN',
        reasonCode: 'RESULT_DELIVERY_UNCONFIRMED',
      })

      now = '2026-08-27T05:00:02.000Z'
      await expect(restarted.reconcile(expiring.envelope.assignmentId)).resolves.toMatchObject({ ok: true, status: 'LEASE_EXPIRED' })
      const restartedAgain = createInMemoryXiaoguiNodeHubV1(options)
      await expect(restartedAgain.offer(expiringTask)).resolves.toEqual({ ok: false, reasonCode: 'ASSIGNMENT_ALREADY_EXISTS' })

      const persisted = await readFile(
        join(userDataDir, 'xiaogui', 'node-hub', 'v1', 'assignment-ledger.json'),
        'utf8',
      )
      expect(persisted).toContain(unknown.envelope.assignmentId)
      expect(persisted).toContain(expiring.envelope.assignmentId)
      expect(persisted).not.toMatch(/token|secret|password|prompt|[A-Z]:\\\\|\\\\\\\\/i)
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('routes only from the trusted approved manifest and rejects node capability self-promotion', async () => {
    const approved = node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'], 'LOCAL_ONLY')
    const hub = createInMemoryXiaoguiNodeHubV1({
      trustedManifests: new Map([['node-a', approved]]),
      now: () => '2026-08-27T05:30:00.000Z',
    })
    const promoted = node(
      'node-a',
      ['WORK.DOCX.TEMPLATE', 'CODING.TYPESCRIPT', 'EXECUTION.EXTERNAL_ALLOWED'],
      'EXTERNAL_ALLOWED',
    )

    await expect(hub.register(promoted)).resolves.toEqual({ ok: false, reasonCode: 'NODE_MANIFEST_NOT_APPROVED' })
    await expect(hub.offer({
      ...task('task-capability-spoof'),
      requiredCapabilities: ['CODING.TYPESCRIPT', 'EXECUTION.EXTERNAL_ALLOWED'],
      dataEgressPolicy: 'EXTERNAL_ALLOWED',
    })).resolves.toEqual({ ok: false, reasonCode: 'NO_NODE_CAPABILITY' })

    await expect(hub.register(approved)).resolves.toEqual({ ok: true })
    await expect(hub.offer(task('task-approved-capability'))).resolves.toMatchObject({
      ok: true,
      envelope: { targetNodeId: 'node-a', dataEgressPolicy: 'LOCAL_ONLY' },
    })
  })
})

function task(taskId: string) {
  return {
    taskId,
    requiredCapabilities: ['WORK.DOCX.TEMPLATE' as const, 'EXECUTION.LOCAL_ONLY' as const],
    dataEgressPolicy: 'LOCAL_ONLY' as const,
    payloadRef: {
      mediaType: 'application/vnd.xiaogui.assignment-payload+json' as const,
      artifactId: `artifact-${taskId}`,
      digest: `sha256:${taskId}`,
    },
  }
}

function node(
  nodeId: string,
  capabilities: XiaoguiNodeCapabilityManifestV1['capabilities'],
  dataEgressPolicy: XiaoguiNodeCapabilityManifestV1['dataEgressPolicy'],
  leaseTtlMs = 60_000,
): XiaoguiNodeCapabilityManifestV1 {
  return {
    identity: {
      nodeId,
      protocolVersion: 'xiaogui-node.v1',
      product: 'XIAOGUI_DESKTOP',
      displayName: nodeId,
    },
    capabilities,
    dataEgressPolicy,
    health: 'ONLINE',
    leaseTtlMs,
    updatedAt: '2026-08-25T00:00:00.000Z',
    designReserved: true,
  }
}
