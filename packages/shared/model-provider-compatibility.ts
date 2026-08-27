export const ANTHROPIC_MESSAGES_API = 'anthropic-messages' as const

export type ModelProviderBaseUrlNormalization = {
  baseUrl: string | undefined
  changed: boolean
  warning?: 'ANTHROPIC_BASE_URL_ENDPOINT_REMOVED'
}

/**
 * Anthropic SDK 会在 baseUrl 后追加 /v1/messages；配置项只能保存服务根地址。
 * 只纠正常见的完整端点和末尾 /v1，不猜测自定义中转的其他路径。
 */
export function normalizeModelProviderBaseUrl(
  api: string | undefined,
  baseUrl: string | undefined,
): ModelProviderBaseUrlNormalization {
  if (typeof baseUrl !== 'string') return { baseUrl, changed: false }
  if (api !== ANTHROPIC_MESSAGES_API) {
    return { baseUrl, changed: false }
  }

  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  const normalized = trimmed.replace(/\/v1(?:\/messages)?$/i, '')
  if (normalized !== trimmed) {
    return {
      baseUrl: normalized || undefined,
      changed: true,
      warning: 'ANTHROPIC_BASE_URL_ENDPOINT_REMOVED',
    }
  }
  return { baseUrl: trimmed || undefined, changed: trimmed !== baseUrl }
}
