import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FlowId, HubAddressV1, InitialPlanDraftInputV1 } from '@shared/xiaogui-collaboration-hub'
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import type { AcpTransportFactoryV1 } from '../agent-runtime/acp/types'
import {
  KIMI_ACP_APPROVED_VERSION_V1,
  KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1,
} from '../agent-runtime/acp/kimi-tool-policy'
import { KIMI_PRODUCTION_CONFIG_CONTENT_V1 } from '../agent-runtime/kimi-production-home'
import type { KimiAcpProbeV1 } from '../agent-runtime/kimi-adapter'
import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'
import {
  createXiaoguiRuntimeCompositionV1,
  type XiaoguiRuntimeCompositionV1,
} from './runtime-composition'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const roots: string[] = []
const compositions: XiaoguiRuntimeCompositionV1[] = []

afterEach(async () => {
  for (const composition of compositions.splice(0)) {
    try {
      await composition.close()
    } catch {
      // The test assertion remains the primary failure.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Xiaogui runtime composition v1', () => {
  it('maps one explicit staging seam to private stores and closes idempotently without provisioning Kimi', async () => {
    const userDataDir = tempUserData()
    const probe = fakeKimiProbe()
    const transportFactory = rejectingTransportFactory()
    const composition = track(createXiaoguiRuntimeCompositionV1({
      userDataDir,
      productionEnabled: false,
      lookup: lookup('CODING'),
      projectResolver: unusedProjectResolver(),
      kimiProbe: probe,
      kimiTransportFactory: transportFactory,
      now: () => '2026-08-17T00:00:00.000Z',
    }))

    const staged = composition.stageAttemptInput({
      attemptId: 'xhba_stage_input',
      projectId: ADDRESS.projectId,
      sessionKey: ADDRESS.sessionKey,
      promptBytes: '只修改明确授权的文件',
      grants: [{ operation: 'CREATE', relativePath: 'src/new-file.ts' }],
    })
    expect(staged).toMatchObject({
      attemptId: 'xhba_stage_input',
      projectId: ADDRESS.projectId,
      sessionKey: ADDRESS.sessionKey,
      grants: [{ operation: 'CREATE', relativePath: 'src/new-file.ts' }],
      promptRef: { attemptId: 'xhba_stage_input' },
    })
    expect(composition.stageAttemptInput({
      attemptId: 'xhba_stage_input',
      projectId: ADDRESS.projectId,
      sessionKey: ADDRESS.sessionKey,
      promptBytes: '只修改明确授权的文件',
      grants: [{ operation: 'CREATE', relativePath: 'src/new-file.ts' }],
    })).toEqual(staged)

    await expect(composition.application.observe(ADDRESS)).resolves.toMatchObject({ ok: true })
    await expect(composition.application.executeSystem({
      contractVersion: 'm2b.v1',
      address: ADDRESS as HubAddressV1,
      trustedActor: { kind: 'main-process-system' },
      requestId: 'sys-disabled',
      intent: { type: 'system.schedule', flowId: 'xhbf_disabled' as FlowId },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'AGENT_UNAVAILABLE', safeArgs: { reason: 'NO_AGENT_RUNTIME' } },
    })
    const taskHubDir = join(userDataDir, 'xiaogui', 'task-hub')
    expect([
      'attempt-workspaces.sqlite',
      'private-runtime-payloads.sqlite',
      'attempt-execution-inputs.sqlite',
      'delivery-apply-attempts.sqlite',
    ].every((name) => existsSync(join(taskHubDir, name)))).toBe(true)
    expect(existsSync(join(userDataDir, 'xiaogui-task-hub-m2a.sqlite'))).toBe(true)
    expect(existsSync(join(userDataDir, 'xiaogui', 'agent-runtime'))).toBe(false)
    expect(probe.findExecutable).not.toHaveBeenCalled()
    expect(transportFactory.create).not.toHaveBeenCalled()

    const firstClose = composition.close()
    const secondClose = composition.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
    expect(() => composition.stageAttemptInput({
      attemptId: 'xhba_after_close',
      projectId: ADDRESS.projectId,
      sessionKey: ADDRESS.sessionKey,
      promptBytes: 'closed',
      grants: [],
    })).toThrow('XIAOGUI_RUNTIME_COMPOSITION_CLOSED')
  })

  it('provisions the isolated Kimi home only when production is enabled', () => {
    const userDataDir = tempUserData()
    const probe = fakeKimiProbe()
    const transportFactory = rejectingTransportFactory()
    track(createXiaoguiRuntimeCompositionV1({
      userDataDir,
      productionEnabled: true,
      lookup: lookup('CODING'),
      projectResolver: unusedProjectResolver(),
      kimiProbe: probe,
      kimiTransportFactory: transportFactory,
    }))

    const home = join(userDataDir, 'xiaogui', 'agent-runtime', 'kimi-v1')
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(KIMI_PRODUCTION_CONFIG_CONTENT_V1)
    expect(readFileSync(join(home, 'agents', 'agent.md'), 'utf8')).toBe(
      KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1,
    )
    expect(probe.findExecutable).not.toHaveBeenCalled()
    expect(transportFactory.create).not.toHaveBeenCalled()
  })

  it('pins the application preflight to the approved Kimi 0.34.0 production selection without running Git or Kimi', async () => {
    const userDataDir = tempUserData()
    const probe = fakeKimiProbe()
    const transportFactory = rejectingTransportFactory()
    const resolveProjectRoot = vi.fn(async () => {
      throw new Error('STOP_BEFORE_GIT')
    })
    const composition = track(createXiaoguiRuntimeCompositionV1({
      userDataDir,
      productionEnabled: true,
      lookup: lookup('CODING'),
      projectResolver: { resolveProjectRoot },
      kimiProbe: probe,
      kimiTransportFactory: transportFactory,
    }))

    const start = await composition.application.execute({
      contractVersion: 'm2a.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-user' },
      requestId: 'req-start',
      intent: { type: 'flow.start.with_draft', draft: draft() },
    })
    if (!start.ok || !start.value.flowId || !start.value.revisionId) throw new Error('start failed')
    const draftProjection = await composition.application.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeRevision) throw new Error('draft missing')
    await expect(composition.application.execute({
      contractVersion: 'm2a.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-user' },
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: start.value.flowId,
        baseRevisionId: start.value.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })).resolves.toMatchObject({ ok: true })
    const approved = await composition.application.observeM2B(ADDRESS)

    await expect(composition.application.executeSystem({
      contractVersion: 'm2b.v1',
      address: ADDRESS as HubAddressV1,
      trustedActor: { kind: 'main-process-system' },
      requestId: 'sys-schedule',
      expectedSessionVersion: approved.ok ? approved.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: start.value.flowId as FlowId },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'BASELINE_UNAVAILABLE',
        safeArgs: { reason: 'BASELINE_PROVIDER_ERROR' },
      },
    })
    expect(probe.findExecutable).toHaveBeenCalledTimes(2)
    expect(resolveProjectRoot).toHaveBeenCalledWith(ADDRESS.projectId)
    expect(transportFactory.create).not.toHaveBeenCalled()
  })
})

function tempUserData(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-runtime-composition-'))
  roots.push(root)
  return root
}

function track(composition: XiaoguiRuntimeCompositionV1): XiaoguiRuntimeCompositionV1 {
  compositions.push(composition)
  return composition
}

function lookup(mode: SessionMode): SessionScopeLookupV1 {
  return {
    lookup: async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: mode },
    }),
  }
}

function unusedProjectResolver(): ProjectWorkspaceResolverV1 {
  return {
    resolveProjectRoot: vi.fn(async () => {
      throw new Error('PROJECT_RESOLVER_MUST_NOT_RUN')
    }),
  }
}

function fakeKimiProbe(): KimiAcpProbeV1 & { findExecutable: ReturnType<typeof vi.fn> } {
  return {
    findExecutable: vi.fn(async () => ({
      available: true as const,
      command: 'never-spawn-kimi',
      version: KIMI_ACP_APPROVED_VERSION_V1,
    })),
  }
}

function rejectingTransportFactory(): AcpTransportFactoryV1 & { create: ReturnType<typeof vi.fn> } {
  return {
    create: vi.fn(() => {
      throw new Error('KIMI_TRANSPORT_MUST_NOT_START')
    }),
  }
}

function draft(): InitialPlanDraftInputV1 {
  return {
    objective: '验证固定 Kimi 生产选择',
    tasks: [{ taskKey: 'first', title: '执行首个任务' }],
  }
}
