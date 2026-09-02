import { describe, expect, it } from 'vitest'

import {
  isRuntimeContractTestSelectionAllowed,
  isRuntimeSelectionAllowed,
  validateRuntimeContractTestCreateRequestShapeV1,
  validateRuntimeProductionCreateRequestShapeV1,
  validateRuntimePublicDto,
  type RuntimeAdapterSelectionV1,
  type RuntimeCapabilityV1,
  type RuntimeContractTestCreateOrResumeRequestV1,
  type RuntimeContractTestPolicyV1,
  type RuntimeCreateOrResumeRequestV1,
  type RuntimeProductionPolicyV1,
  type RuntimeTestAdapterSelectionV1,
} from './xiaogui-agent-runtime'

const approvedSelection = {
  adapterId: 'kimi-acp',
  runtimeKind: 'KIMI',
  protocol: 'ACP',
  capabilityDigest: 'sha256:capability-approved',
  approvalStatus: 'APPROVED_FOR_PRODUCTION',
  diagnosticOnly: false,
  stream: 'PUSH',
  interrupt: 'ACKED',
  inspect: 'RECONCILE',
} satisfies RuntimeAdapterSelectionV1

const approvedCapability = {
  ...approvedSelection,
  health: 'AVAILABLE',
  canCreateSession: true,
  canResumeSession: true,
  interactivePermission: 'HOST_MEDIATED',
} satisfies RuntimeCapabilityV1

const policy = {
  rejectDiagnosticOnly: true,
  allowedSelections: [approvedSelection],
} satisfies RuntimeProductionPolicyV1

const testSelection = {
  adapterId: 'kimi-acp',
  runtimeKind: 'KIMI',
  protocol: 'ACP',
  capabilityDigest: 'sha256:capability-test',
  approvalStatus: 'APPROVED_FOR_TEST',
  diagnosticOnly: false,
  stream: 'POLL',
  interrupt: 'BEST_EFFORT',
  inspect: 'RECONCILE',
} satisfies RuntimeTestAdapterSelectionV1

const contractPolicy = {
  rejectDiagnosticOnly: true,
  workspacePolicy: 'ATTEMPT_WORKTREE_ONLY',
  productEnablement: false,
  allowedSelections: [testSelection],
} satisfies RuntimeContractTestPolicyV1

function productionRequest(overrides: Partial<RuntimeCreateOrResumeRequestV1> = {}): RuntimeCreateOrResumeRequestV1 {
  return {
    requestId: 'req-create',
    scope: {
      projectId: 'project-1',
      sessionKey: 'session-1',
      sessionMode: 'CODING',
      flowId: 'flow-1',
      taskRunId: 'run-1',
      attemptId: 'attempt-1',
      attemptDigest: 'sha256:attempt',
      workspaceReceiptId: 'workspace-receipt-1',
      workspaceReceiptDigest: 'sha256:workspace',
    },
    workspace: {
      attemptWorktreeId: 'worktree-1',
      worktreeRootDigest: 'sha256:worktree-root',
      baseRevisionDigest: 'sha256:base',
      targetProjectRootDigest: 'sha256:target',
      writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    },
    selection: approvedSelection,
    productionPolicy: policy,
    promptEnvelopeRef: {
      refId: 'prompt-1',
      digest: 'sha256:prompt',
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
    ...overrides,
  }
}

function contractRequest(overrides: Partial<RuntimeContractTestCreateOrResumeRequestV1> = {}): RuntimeContractTestCreateOrResumeRequestV1 {
  return {
    executionMode: 'CONTRACT_TEST',
    requestId: 'req-contract',
    scope: productionRequest().scope,
    workspace: productionRequest().workspace,
    selection: testSelection,
    contractTestPolicy: contractPolicy,
    promptEnvelopeRef: productionRequest().promptEnvelopeRef,
    ...overrides,
  }
}

describe('xiaogui agent runtime shared contract', () => {
  it('allows only an exact approved production runtime selection', () => {
    expect(isRuntimeSelectionAllowed(approvedSelection, policy)).toEqual({ ok: true })
    expect(isRuntimeSelectionAllowed({ ...approvedSelection, capabilityDigest: 'sha256:changed' }, policy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_SELECTION_NOT_APPROVED',
    })
    expect(isRuntimeSelectionAllowed({ ...approvedCapability, diagnosticOnly: true }, policy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_DIAGNOSTIC_ONLY',
    })
    expect(isRuntimeSelectionAllowed({ ...approvedCapability, protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC' }, policy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_DIAGNOSTIC_PROTOCOL',
    })
    expect(isRuntimeSelectionAllowed({ ...approvedCapability, stream: 'NONE' }, policy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_STREAM_UNAVAILABLE',
    })
  })

  it('allows only an exact approved contract-test runtime selection without product enablement', () => {
    expect(isRuntimeContractTestSelectionAllowed(testSelection, contractPolicy)).toEqual({ ok: true })
    expect(isRuntimeContractTestSelectionAllowed({ ...testSelection, capabilityDigest: 'sha256:changed' }, contractPolicy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_SELECTION_NOT_APPROVED_FOR_TEST',
    })
    expect(isRuntimeContractTestSelectionAllowed({ ...approvedCapability, capabilityDigest: 'sha256:capability-test' }, contractPolicy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_SELECTION_NOT_APPROVED_FOR_TEST',
    })
    const productEnabled = { ...contractPolicy }
    Object.defineProperty(productEnabled, 'productEnablement', { value: true })
    expect(isRuntimeContractTestSelectionAllowed(testSelection, productEnabled)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_CONTRACT_TEST_PRODUCT_ENABLEMENT_FORBIDDEN',
    })
  })

  it('validates the total production create request shape before nested data is trusted', () => {
    expect(validateRuntimeProductionCreateRequestShapeV1(productionRequest())).toEqual({ ok: true })

    for (const malformed of [
      null,
      { requestId: 'req' },
      { ...productionRequest(), scope: undefined },
      { ...productionRequest(), workspace: { writePolicy: 'ATTEMPT_WORKTREE_ONLY' } },
      { ...productionRequest(), selection: { approvalStatus: 'APPROVED_FOR_PRODUCTION' } },
      { ...productionRequest(), productionPolicy: { rejectDiagnosticOnly: true } },
      { ...productionRequest(), productionPolicy: { ...policy, allowedSelections: [approvedSelection, testSelection] } },
      { ...productionRequest(), promptEnvelopeRef: { refId: 'prompt-1', digest: 'sha256:prompt' } },
      { ...productionRequest(), resumeTokenDigest: 42 },
      Object.create({ selection: approvedSelection }),
      new Proxy(productionRequest(), {
        get() {
          throw new Error('hostile get')
        },
      }),
      new Proxy(productionRequest(), {
        getPrototypeOf() {
          throw new Error('hostile prototype')
        },
      }),
    ]) {
      expect(validateRuntimeProductionCreateRequestShapeV1(malformed)).toEqual({
        ok: false,
        reasonCode: 'RUNTIME_CREATE_REQUEST_INVALID',
      })
    }
  })

  it('validates the total contract-test create request shape before nested data is trusted', () => {
    expect(validateRuntimeContractTestCreateRequestShapeV1(contractRequest())).toEqual({ ok: true })

    for (const malformed of [
      { executionMode: 'CONTRACT_TEST' },
      { ...contractRequest(), scope: null },
      { ...contractRequest(), workspace: { ...contractRequest().workspace, writePolicy: 'TARGET_WORKTREE_ONLY' } },
      { ...contractRequest(), selection: { ...testSelection, stream: 'NONE' } },
      { ...contractRequest(), contractTestPolicy: undefined },
      { ...contractRequest(), contractTestPolicy: { ...contractPolicy, allowedSelections: [] } },
      { ...contractRequest(), contractTestPolicy: { ...contractPolicy, allowedSelections: [testSelection, testSelection] } },
      { ...contractRequest(), promptEnvelopeRef: { ...contractRequest().promptEnvelopeRef, mediaType: 'text/plain' } },
      { ...contractRequest(), resumeTokenDigest: {} },
      { ...contractRequest(), productionPolicy: policy },
      new Proxy(contractRequest(), {
        get() {
          throw new Error('hostile get')
        },
      }),
      new Proxy(contractRequest(), {
        getPrototypeOf() {
          throw new Error('hostile prototype')
        },
      }),
    ]) {
      expect(validateRuntimeContractTestCreateRequestShapeV1(malformed)).toEqual({
        ok: false,
        reasonCode: 'RUNTIME_CREATE_REQUEST_INVALID',
      })
    }
  })

  it('rejects public DTOs that leak local paths, credentials, env names, URLs, or raw output', () => {
    expect(validateRuntimePublicDto({ runtimeSessionId: 'xgrs_1', reasonCode: 'OK', toolName: 'shell' })).toEqual({ ok: true })

    for (const value of [
      { path: 'C:\\Users\\90662\\secret.txt' },
      { path: 'C:/Users/90662/secret.txt' },
      { path: '\\\\server\\share\\secret.txt' },
      { path: '/home/user/.config/token' },
      { logLine: 'adapter wrote /opt/xiaogui/runtime/session.json' },
      { uri: 'file:///C:/Users/90662/secret.txt' },
      { runtimeSessionId: 'runtime session with spaces' },
      { runtimeSessionId: 'C:/runtime/session' },
      { token: 'ghp_1234567890abcdefghijklmnop' },
      { env: 'OPENAI_API_KEY' },
      { url: 'http://127.0.0.1:3210/internal' },
      'api_key：abcd1234',
      '{"token":"abcd1234"}',
      { stdout: 'full stdout should stay behind resolver' },
      { prompt: 'write the entire user prompt into the event' },
      { candidatePath: 'src/main/index.ts' },
    ]) {
      expect(validateRuntimePublicDto(value)).toEqual({ ok: false, reasonCode: 'PUBLIC_DTO_LEAK' })
    }
  })

  it('fails closed instead of throwing when public DTO traversal hits hostile properties', () => {
    const hostile = { runtimeSessionId: 'xgrs_1', reasonCode: 'OK' }
    Object.defineProperty(hostile, 'extra', {
      enumerable: true,
      get() {
        throw new Error('hostile getter')
      },
    })

    expect(validateRuntimePublicDto(hostile)).toEqual({ ok: false, reasonCode: 'PUBLIC_DTO_LEAK' })
    expect(validateRuntimePublicDto(new Proxy({ runtimeSessionId: 'xgrs_1' }, {
      ownKeys() {
        throw new Error('hostile ownKeys')
      },
    }))).toEqual({ ok: false, reasonCode: 'PUBLIC_DTO_LEAK' })
  })
})
