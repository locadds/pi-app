import { describe, expect, it } from 'vitest'

import {
  isRuntimeSelectionAllowed,
  validateRuntimePublicDto,
  type RuntimeAdapterSelectionV1,
  type RuntimeCapabilityV1,
  type RuntimeProductionPolicyV1,
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

const policy = {
  rejectDiagnosticOnly: true,
  allowedSelections: [approvedSelection],
} satisfies RuntimeProductionPolicyV1

describe('xiaogui agent runtime shared contract', () => {
  it('allows only an exact approved production runtime selection', () => {
    expect(isRuntimeSelectionAllowed(approvedSelection, policy)).toEqual({ ok: true })
    expect(isRuntimeSelectionAllowed({ ...approvedSelection, capabilityDigest: 'sha256:changed' }, policy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_SELECTION_NOT_APPROVED',
    })
    expect(isRuntimeSelectionAllowed({ ...approvedSelection, diagnosticOnly: true } as RuntimeCapabilityV1, policy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_DIAGNOSTIC_ONLY',
    })
    expect(isRuntimeSelectionAllowed({ ...approvedSelection, protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC' } as RuntimeCapabilityV1, policy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_DIAGNOSTIC_PROTOCOL',
    })
    expect(isRuntimeSelectionAllowed({ ...approvedSelection, stream: 'NONE' } as RuntimeCapabilityV1, policy)).toEqual({
      ok: false,
      reasonCode: 'RUNTIME_STREAM_UNAVAILABLE',
    })
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
})
