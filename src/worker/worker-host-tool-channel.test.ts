import { describe, expect, it } from 'vitest'

import { receiveWorkerHostToolResponse } from './worker-host-tool-channel'

describe('worker host-tool response routing', () => {
  it('consumes a valid late response instead of leaking it into ordinary RPC dispatch', () => {
    expect(
      receiveWorkerHostToolResponse({
        type: 'host-tool-response',
        requestId: 'already-timed-out',
        outcome: {
          ok: false,
          error: {
            code: 'HOST_TOOL_TIMEOUT',
            message: 'late response',
          },
        },
      }),
    ).toBe(true)
  })

  it('leaves unrelated messages for ordinary RPC dispatch', () => {
    expect(receiveWorkerHostToolResponse({ type: 'response', requestId: 'rpc-1' })).toBe(false)
  })
})
