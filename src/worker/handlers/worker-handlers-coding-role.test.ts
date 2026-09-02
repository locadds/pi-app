import { createHash } from 'node:crypto'

import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readCodingRoleRuntimeV1,
  releaseCodingRoleRuntimeV1,
  st,
} from '../worker-runtime'
import { handleCodingRoleBinding } from './worker-handlers-coding-role'

function privateSnapshot(overrides: Partial<CodingRoleAgentSnapshotV1['snapshot']> = {}): CodingRoleAgentSnapshotV1 {
  const snapshot = {
    schemaVersion: 1 as const,
    profileId: 'role.research.custom',
    role: 'RESEARCH' as const,
    name: '研究',
    description: '只读',
    systemPrompt: '保持只读，不得修改文件。',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    requestedToolAllowlist: ['read', 'bash', 'edit', 'write'],
    effectiveToolAllowlist: ['read'],
    profileDigest: `sha256:${'1'.repeat(64)}`,
    ...overrides,
  }
  return {
    schemaVersion: 1,
    attemptId: 'attempt-1',
    boundAt: '2026-08-31T12:00:00.000Z',
    snapshot,
    snapshotDigest: `sha256:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`,
  }
}

function codingSession(model = 'openai/gpt-5.6-sol') {
  let selected = model
  const setModel = vi.fn(async (next: { provider: string; id?: string; modelId?: string }) => {
    selected = `${next.provider}/${next.modelId ?? next.id}`
  })
  const session = {
    isStreaming: false,
    setModel,
    get model() {
      const [provider, modelId] = selected.split('/')
      return { provider, modelId }
    },
  } as unknown as AgentSession
  return { session, setModel }
}

describe('Worker coding role private binding', () => {
  beforeEach(() => {
    releaseCodingRoleRuntimeV1()
    st.agentTurnActive = false
    st.promptContextCandidate = {
      schemaVersion: 1,
      mode: 'CODING',
      phase: 'EXECUTE',
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: ['coding.workspace'],
      availableToolNames: [],
    }
    const { session } = codingSession()
    st.session = session
    st.modelRuntime = {
      getModel: vi.fn((provider: string, modelId: string) => (
        provider === 'openai' && modelId === 'gpt-5.6-sol'
          ? { provider, modelId }
          : undefined
      )),
    } as never
  })

  afterEach(() => {
    releaseCodingRoleRuntimeV1()
    st.session = null
    st.modelRuntime = null
    st.promptContextCandidate = null
    st.agentTurnActive = false
  })

  it('先检查再绑定，回包不含 systemPrompt', async () => {
    const snapshot = privateSnapshot()
    const checked: unknown[] = []
    await handleCodingRoleBinding({
      type: 'codingRoleBinding',
      action: 'CHECK',
      codingRole: snapshot,
    }, (value) => { checked.push(value) })
    expect(readCodingRoleRuntimeV1()).toBeNull()

    const bound: unknown[] = []
    await handleCodingRoleBinding({
      type: 'codingRoleBinding',
      action: 'BIND',
      codingRole: snapshot,
    }, (value) => { bound.push(value) })

    expect(readCodingRoleRuntimeV1()?.attemptId).toBe('attempt-1')
    expect(bound).toEqual([expect.objectContaining({
      type: 'codingRoleBinding-done',
      action: 'BIND',
      attemptId: 'attempt-1',
      profileId: 'role.research.custom',
      role: 'RESEARCH',
      model: 'openai/gpt-5.6-sol',
    })])
    expect(JSON.stringify([...checked, ...bound])).not.toContain(snapshot.snapshot.systemPrompt)
  })

  it('显式模型可用时在绑定前切换并核对实际模型', async () => {
    const { session, setModel } = codingSession('openai/old-model')
    st.session = session
    const replies: unknown[] = []

    await handleCodingRoleBinding({
      type: 'codingRoleBinding',
      action: 'BIND',
      codingRole: privateSnapshot({ modelSelector: 'openai/gpt-5.6-sol' }),
    }, (value) => { replies.push(value) })

    expect(setModel).toHaveBeenCalledOnce()
    expect(replies).toEqual([expect.objectContaining({
      type: 'codingRoleBinding-done',
      model: 'openai/gpt-5.6-sol',
    })])
  })

  it('模型或运行时策略不受支持时明确失败且不绑定', async () => {
    const modelReplies: unknown[] = []
    await handleCodingRoleBinding({
      type: 'codingRoleBinding',
      action: 'BIND',
      codingRole: privateSnapshot({ modelSelector: 'openai/missing' }),
    }, (value) => { modelReplies.push(value) })
    expect(modelReplies).toEqual([{ type: 'error', error: 'XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE' }])
    expect(readCodingRoleRuntimeV1()).toBeNull()

    const policyReplies: unknown[] = []
    await handleCodingRoleBinding({
      type: 'codingRoleBinding',
      action: 'BIND',
      codingRole: privateSnapshot({ runtimePolicyId: 'cloud.unapproved' }),
    }, (value) => { policyReplies.push(value) })
    expect(policyReplies).toEqual([{ type: 'error', error: 'XIAOGUI_CODING_ROLE_RUNTIME_POLICY_UNSUPPORTED' }])
    expect(readCodingRoleRuntimeV1()).toBeNull()
  })

  it('忙碌、非 CODING 或错误 Attempt 释放都 fail closed', async () => {
    const snapshot = privateSnapshot()
    await handleCodingRoleBinding({ action: 'BIND', codingRole: snapshot }, vi.fn())

    st.agentTurnActive = true
    const busy: unknown[] = []
    await handleCodingRoleBinding({
      action: 'RELEASE',
      expectedAttemptId: 'attempt-1',
    }, (value) => { busy.push(value) })
    expect(busy).toEqual([{ type: 'error', error: 'XIAOGUI_CODING_ROLE_RUNTIME_BUSY' }])

    st.agentTurnActive = false
    const mismatch: unknown[] = []
    await handleCodingRoleBinding({
      action: 'RELEASE',
      expectedAttemptId: 'attempt-2',
    }, (value) => { mismatch.push(value) })
    expect(mismatch).toEqual([{ type: 'error', error: 'XIAOGUI_CODING_ROLE_RUNTIME_ATTEMPT_MISMATCH' }])
    expect(readCodingRoleRuntimeV1()?.attemptId).toBe('attempt-1')

    st.promptContextCandidate = { ...st.promptContextCandidate!, mode: 'WORK' }
    const wrongMode: unknown[] = []
    await handleCodingRoleBinding({ action: 'CHECK', codingRole: snapshot }, (value) => { wrongMode.push(value) })
    expect(wrongMode).toEqual([{ type: 'error', error: 'XIAOGUI_CODING_ROLE_CODING_SESSION_REQUIRED' }])
  })
})
