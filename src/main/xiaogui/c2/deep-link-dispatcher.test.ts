import { describe, expect, it, vi } from 'vitest'

import { C2InstallDeepLinkDispatcher } from './deep-link-dispatcher'

describe('C2InstallDeepLinkDispatcher', () => {
  it('buffers a first-start install link and delivers later second-instance links in arrival order', () => {
    const dispatcher = new C2InstallDeepLinkDispatcher()
    const first = 'xiaogui://install/123e4567-e89b-12d3-a456-426614174000?nonce=first-once'
    const second = 'xiaogui://install/123e4567-e89b-12d3-a456-426614174001?nonce=second-once'

    expect(dispatcher.acceptArgv(['xiaogui-agent.exe', first])).toBe(true)

    const consumer = vi.fn()
    dispatcher.setConsumer(consumer)
    expect(dispatcher.acceptArgv(['xiaogui-agent.exe', '--flag', second])).toBe(true)

    expect(consumer.mock.calls.map(([value]) => value)).toEqual([
      { installIntentId: '123e4567-e89b-12d3-a456-426614174000', nonce: 'first-once' },
      { installIntentId: '123e4567-e89b-12d3-a456-426614174001', nonce: 'second-once' },
    ])
  })

  it('ignores unrelated argv and rejects malformed or over-specified install links', () => {
    const dispatcher = new C2InstallDeepLinkDispatcher()
    const consumer = vi.fn()
    dispatcher.setConsumer(consumer)

    expect(dispatcher.acceptArgv(['xiaogui-agent.exe', 'https://example.test'])).toBe(false)
    expect(dispatcher.acceptArgv([
      'xiaogui-agent.exe',
      'xiaogui://install/not-a-uuid?nonce=secret',
    ])).toBe(false)
    expect(dispatcher.acceptArgv([
      'xiaogui-agent.exe',
      'xiaogui://install/123e4567-e89b-12d3-a456-426614174000?nonce=secret&ticket=forbidden',
    ])).toBe(false)
    expect(consumer).not.toHaveBeenCalled()
  })
})
