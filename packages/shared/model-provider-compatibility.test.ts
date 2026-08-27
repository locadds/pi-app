import { describe, expect, it } from 'vitest'

import { normalizeModelProviderBaseUrl } from './model-provider-compatibility'

describe('模型供应商地址兼容性', () => {
  it.each([
    ['https://api.anthropic.com/v1', 'https://api.anthropic.com'],
    ['https://relay.example.com/anthropic/v1/messages/', 'https://relay.example.com/anthropic'],
  ])('Anthropic Messages 移除 SDK 会自动追加的端点：%s', (input, expected) => {
    expect(normalizeModelProviderBaseUrl('anthropic-messages', input)).toEqual({
      baseUrl: expected,
      changed: true,
      warning: 'ANTHROPIC_BASE_URL_ENDPOINT_REMOVED',
    })
  })

  it('不改写自定义 Anthropic 中转前缀', () => {
    expect(
      normalizeModelProviderBaseUrl('anthropic-messages', 'https://relay.example.com/anthropic'),
    ).toEqual({ baseUrl: 'https://relay.example.com/anthropic', changed: false })
  })

  it('OpenAI 兼容接口保留末尾 /v1', () => {
    expect(normalizeModelProviderBaseUrl('openai-completions', 'https://relay.example.com/v1')).toEqual({
      baseUrl: 'https://relay.example.com/v1',
      changed: false,
    })
  })
})
