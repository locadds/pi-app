import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelAuthProjectionRuntime } from '@shared/model-auth-projection'
import {
  handleGeteffectivepromptmanifest,
  handleGetmodels,
  handleGetmodelsettingssnapshot,
  handleGetsessioncontextpreview,
  handleReloadmodels,
} from './worker-handlers-catalog'
import { st, type WorkerModelRuntime } from '../worker-runtime'

function modelRuntimeWith(options?: {
  models?: Array<{ provider: string; id: string; name?: string }>
  catalog?: Array<{ provider: string; id: string; name?: string }>
  refresh?: () => Promise<unknown>
  auth?: ModelAuthProjectionRuntime
}): WorkerModelRuntime {
  return {
    getModel: vi.fn(),
    getModels: vi.fn(() => options?.catalog ?? options?.models ?? []),
    getAvailable: vi.fn(async () => options?.models ?? []),
    refresh: vi.fn(options?.refresh ?? (async () => ({ providers: [] }))),
    ...options?.auth,
  } as unknown as WorkerModelRuntime
}

afterEach(() => {
  st.modelRuntime = null
  st.session = null
  st.currentSessionId = ''
  st.promptDiagnostics = null
  st.effectivePrompt = null
  st.promptPreflight = null
})

describe('worker effective Prompt diagnostics handler', () => {
  it('keeps Prompt text out of the default Manifest response and returns the same body only for advanced diagnostics', async () => {
    st.currentSessionId = 'session-a'
    st.session = { sessionFile: 'C:/sessions/a.jsonl' } as never
    st.promptDiagnostics = {
      manifest: {
        schemaVersion: 1,
        mode: 'WORK',
        phase: 'EXECUTE',
        workspaceAvailable: true,
        projectTrusted: true,
        capabilityIds: ['work.file-organize'],
        toolNames: ['read'],
        layers: [],
        completePromptCharacterCount: 21,
        completePromptSha256: 'f'.repeat(64),
        generatedAt: '2026-08-30T00:00:00.000Z',
      },
      migrationNotices: [],
    }
    st.effectivePrompt = 'complete prompt body!'
    const manifestReply = vi.fn()
    const advancedReply = vi.fn()

    await handleGeteffectivepromptmanifest({ sessionFile: 'C:/sessions/a.jsonl' }, manifestReply)
    await handleGeteffectivepromptmanifest({
      sessionFile: 'C:/sessions/a.jsonl',
      includePromptBody: true,
    }, advancedReply)

    expect(manifestReply).toHaveBeenCalledWith(expect.objectContaining({
      type: 'getEffectivePromptManifest-done',
      promptDiagnostics: st.promptDiagnostics,
    }))
    expect(manifestReply.mock.calls[0]?.[0]).not.toHaveProperty('prompt')
    expect(advancedReply).toHaveBeenCalledWith(expect.objectContaining({
      promptDiagnostics: st.promptDiagnostics,
      prompt: 'complete prompt body!',
    }))
  })

  it('refreshes idle diagnostics through the real Session preflight Builder', async () => {
    const freshDiagnostics = {
      manifest: {
        schemaVersion: 1 as const,
        mode: 'CODING' as const,
        phase: 'PLAN' as const,
        workspaceAvailable: true,
        projectTrusted: true,
        capabilityIds: ['coding.workspace' as const],
        toolNames: ['read'],
        layers: [],
        completePromptCharacterCount: 12,
        completePromptSha256: 'd'.repeat(64),
        generatedAt: '2026-08-30T00:00:00.000Z',
      },
      migrationNotices: [],
    }
    const freshContext = {
      schemaVersion: 1 as const,
      mode: 'CODING' as const,
      phase: 'PLAN' as const,
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: ['coding.workspace' as const],
      availableToolNames: ['read'],
    }
    st.session = { sessionFile: 'C:/sessions/a.jsonl', isStreaming: false } as never
    st.promptDiagnostics = null
    st.effectivePrompt = null
    st.promptPreflight = vi.fn(() => ({
      prompt: 'fresh prompt',
      context: freshContext,
      diagnostics: freshDiagnostics,
    }))
    const reply = vi.fn()

    await handleGeteffectivepromptmanifest({}, reply)

    expect(st.promptPreflight).toHaveBeenCalledOnce()
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      promptDiagnostics: freshDiagnostics,
    }))
    expect(st.effectivePrompt).toBe('fresh prompt')
  })
})

describe('worker model catalog handlers', () => {
  it('rejects reload when ModelRuntime is not ready', async () => {
    const reply = vi.fn()

    await handleReloadmodels({}, reply)

    expect(reply).toHaveBeenCalledWith({ type: 'error', error: 'MODEL_RUNTIME_NOT_READY' })
  })

  it('reloads and lists available models through the shared ModelRuntime', async () => {
    const runtime = modelRuntimeWith({ models: [{ provider: 'openai', id: 'gpt/new', name: 'GPT New' }] })
    st.modelRuntime = runtime
    const reloadReply = vi.fn()
    const listReply = vi.fn()

    await handleReloadmodels({}, reloadReply)
    await handleGetmodels({}, listReply)

    expect(runtime.refresh).toHaveBeenCalledOnce()
    expect(runtime.getAvailable).toHaveBeenCalledOnce()
    expect(reloadReply).toHaveBeenCalledWith({ type: 'reloadModels-done', ok: true })
    expect(listReply).toHaveBeenCalledWith({
      type: 'getModels-done',
      models: [{
        id: 'gpt/new',
        name: 'GPT New',
        provider: 'openai',
        contextWindow: 0,
        maxOutput: 0,
        available: true,
      }],
    })
  })

  it('returns a secret-free settings snapshot from the live Worker-owned runtime', async () => {
    const getAuth = vi.fn(() => ({ apiKey: 'sk-secret' }))
    const runtime = modelRuntimeWith({
      catalog: [
        { provider: 'anthropic', id: 'claude' },
        { provider: 'openai', id: 'gpt' },
      ],
      auth: {
        getProviderAuthStatus(provider: string) {
          expect(this).toBe(runtime)
          return { configured: provider === 'openai', source: 'stored' }
        },
        async listCredentials() {
          expect(this).toBe(runtime)
          return [{ providerId: 'openai', type: 'oauth', secret: 'credential-secret' }]
        },
        getAuth,
      } as never,
    })
    st.modelRuntime = runtime
    const reply = vi.fn()

    await handleGetmodelsettingssnapshot({}, reply)

    expect(runtime.getModels).toHaveBeenCalledOnce()
    expect(runtime.getAvailable).not.toHaveBeenCalled()
    expect(getAuth).not.toHaveBeenCalled()
    const payload = reply.mock.calls[0]?.[0]
    expect(payload).toEqual({
      type: 'getModelSettingsSnapshot-done',
      models: [
        expect.objectContaining({
          id: 'claude',
          available: false,
          managedBy: 'active-sdk',
          auth: { supported: true, configured: false, source: 'stored', type: undefined },
        }),
        expect.objectContaining({
          id: 'gpt',
          available: true,
          managedBy: 'active-sdk',
          auth: { supported: true, configured: true, source: 'stored', type: 'oauth' },
        }),
      ],
    })
    expect(JSON.stringify(payload)).not.toMatch(/sk-secret|credential-secret/)
  })

  it('rejects a settings snapshot when ModelRuntime is not ready', async () => {
    const reply = vi.fn()

    await handleGetmodelsettingssnapshot({}, reply)

    expect(reply).toHaveBeenCalledWith({ type: 'error', error: 'MODEL_RUNTIME_NOT_READY' })
  })
})

describe('worker context preview handler', () => {
  it('uses the persisted-message metric even when the live session has a system prompt', async () => {
    st.currentSessionId = 'session-a'
    st.session = {
      sessionFile: '/sessions/a.jsonl',
      systemPrompt: 'live-only-system-prompt',
      messages: [{ role: 'user', content: 'hello' }],
    } as never
    const reply = vi.fn()

    await handleGetsessioncontextpreview({ sessionFile: '/sessions/a.jsonl' }, reply)

    expect(reply).toHaveBeenCalledWith({
      type: 'getSessionContextPreview-done',
      preview: expect.objectContaining({
        sessionFile: '/sessions/a.jsonl',
        estimatedChars: 5,
        roleBreakdown: [{ role: 'user', chars: 5 }],
      }),
    })
  })
})
