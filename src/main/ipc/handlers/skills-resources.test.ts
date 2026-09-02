import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Record<string, unknown>) => Promise<unknown>>(),
  getSystemPrompt: vi.fn(),
  getContextPrompts: vi.fn(),
  getEffectivePromptManifest: vi.fn(),
  getEffectivePromptPreview: vi.fn(),
  getPromptTemplatesList: vi.fn(),
  reloadResources: vi.fn(),
  getSkillsList: vi.fn(),
  applySkillOverrides: vi.fn(),
  writeSkillDescription: vi.fn(),
  transferSkill: vi.fn(),
  start: vi.fn(),
  listAgentsContextFiles: vi.fn<(...args: unknown[]) => Array<Record<string, unknown>>>(() => []),
  listPiBuiltinPromptFiles: vi.fn<(...args: unknown[]) => Array<Record<string, unknown>>>(() => []),
  listPluginInjectedPromptFiles: vi.fn<(...args: unknown[]) => Array<Record<string, unknown>>>(() => []),
  listCodeOwnedPromptCatalogFiles: vi.fn<(...args: unknown[]) => Array<Record<string, unknown>>>(() => []),
  listPromptsOnDisk: vi.fn<(...args: unknown[]) => Array<Record<string, unknown>>>(() => []),
  workerManager: {
    isRunning: false,
    cwd: '',
  },
}))

vi.mock('../registry', () => ({
  registerHandler: (channel: string, handler: (request: Record<string, unknown>) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler)
  },
}))
vi.mock('../../worker-manager', () => ({
  workerManager: Object.assign(mocks.workerManager, {
    getContextPrompts: mocks.getContextPrompts,
    getEffectivePromptManifest: mocks.getEffectivePromptManifest,
    getEffectivePromptPreview: mocks.getEffectivePromptPreview,
    getPromptTemplatesList: mocks.getPromptTemplatesList,
    reloadResources: mocks.reloadResources,
    getSkillsList: mocks.getSkillsList,
    applySkillOverrides: mocks.applySkillOverrides,
    writeSkillDescription: mocks.writeSkillDescription,
    transferSkill: mocks.transferSkill,
    start: mocks.start,
  }),
}))
vi.mock('../../config-store', () => ({
  configStore: {
    get: vi.fn((key: string) => {
      if (key === 'currentProject') return 'C:/repo'
      if (key === 'skillPresentation') return {}
      return undefined
    }),
    getSkillOverrides: vi.fn(() => ({})),
    set: vi.fn(),
  },
}))
vi.mock('../../session-preview-process', () => ({
  sessionPreviewProcess: { getSystemPrompt: mocks.getSystemPrompt },
}))
vi.mock('../../pi-agent-settings-read', () => ({
  readPiAgentGlobalSettingsFromDisk: vi.fn(() => ({ defaultProvider: 'openai' })),
  readPiProjectSettingsFromDisk: vi.fn(() => ({ skills: ['.pi/skills/project-skill'] })),
}))
vi.mock('../../pi-resources-editor', () => ({
  listSkillsOnDisk: vi.fn(() => []),
  listPromptsOnDisk: mocks.listPromptsOnDisk,
  readTextFileSafe: vi.fn(),
  writeTextFileSafe: vi.fn(),
  skillStorageKey: vi.fn(() => 'skill'),
}))
vi.mock('../../pi-skill-overrides', () => ({
  getDesktopSkillOverrides: vi.fn(() => ({})),
  isSkillEnabled: vi.fn(() => true),
  setSkillEnabledInGlobal: vi.fn(() => ({})),
  applySkillOverridesBatch: vi.fn(),
  migrateElectronSkillOverrides: vi.fn(),
}))
vi.mock('../../pi-prompt-catalog', () => ({
  listAgentsContextFiles: mocks.listAgentsContextFiles,
  listPiBuiltinPromptFiles: mocks.listPiBuiltinPromptFiles,
  listPluginInjectedPromptFiles: mocks.listPluginInjectedPromptFiles,
  listCodeOwnedPromptCatalogFiles: mocks.listCodeOwnedPromptCatalogFiles,
  groupPromptCatalog: vi.fn(() => ({})),
  getGlobalSystemMd: vi.fn(() => 'C:/agent/SYSTEM.md'),
}))
vi.mock('../../resource-revisions', () => ({
  listRevisions: vi.fn(() => []),
  pushRevision: vi.fn(),
  restoreRevision: vi.fn(),
  readRevision: vi.fn(),
}))

import { registerSkillsResourceHandlers } from './skills-resources'

describe('system prompt resource preview', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.getSystemPrompt.mockReset().mockResolvedValue('assembled prompt')
    mocks.getContextPrompts.mockReset()
    mocks.getEffectivePromptManifest.mockReset().mockResolvedValue({
      manifest: {
        schemaVersion: 1,
        mode: 'WORK',
        phase: 'EXECUTE',
        workspaceAvailable: true,
        projectTrusted: true,
        capabilityIds: ['work.file-organize'],
        toolNames: ['read'],
        layers: [],
        completePromptCharacterCount: 25,
        completePromptSha256: 'a'.repeat(64),
        generatedAt: '2026-08-30T00:00:00.000Z',
      },
      migrationNotices: [],
    })
    mocks.getEffectivePromptPreview.mockReset().mockResolvedValue({
      manifest: {
        completePromptCharacterCount: 25,
        completePromptSha256: 'a'.repeat(64),
      },
      migrationNotices: [],
      prompt: 'product layers only',
    })
    mocks.getPromptTemplatesList.mockReset().mockResolvedValue([])
    mocks.reloadResources.mockReset().mockResolvedValue(undefined)
    mocks.getSkillsList.mockReset()
    mocks.applySkillOverrides.mockReset()
    mocks.writeSkillDescription.mockReset()
    mocks.transferSkill.mockReset()
    mocks.start.mockReset()
    mocks.listAgentsContextFiles.mockClear()
    mocks.listPiBuiltinPromptFiles.mockClear()
    mocks.listPluginInjectedPromptFiles.mockClear()
    mocks.listCodeOwnedPromptCatalogFiles.mockClear()
    mocks.listPromptsOnDisk.mockClear()
    mocks.workerManager.isRunning = false
    mocks.workerManager.cwd = ''
    registerSkillsResourceHandlers()
  })

  it('starts the current project Worker and reads Prompt text only for an explicit advanced preview', async () => {
    const handler = mocks.handlers.get('ipc:resource.read')
    await expect(handler?.({ path: 'xiaogui://prompt-catalog/product-system-layers-preview' })).resolves.toEqual({
      content: 'product layers only',
      path: 'xiaogui://prompt-catalog/product-system-layers-preview',
      revisions: [],
    })

    expect(mocks.start).toHaveBeenCalledWith('C:/repo')
    expect(mocks.getEffectivePromptPreview).toHaveBeenCalledOnce()
    expect(mocks.getSystemPrompt).not.toHaveBeenCalled()
  })

  it('returns the complete real-Session Manifest from prompts.list without requesting Prompt text', async () => {
    const handler = mocks.handlers.get('ipc:prompts.list')

    const result = await handler?.({}) as Record<string, unknown>

    expect(mocks.start).toHaveBeenCalledWith('C:/repo')
    expect(mocks.getEffectivePromptManifest).toHaveBeenCalledOnce()
    expect(mocks.getEffectivePromptPreview).not.toHaveBeenCalled()
    expect(result.effectivePromptDiagnostics).toEqual(
      await mocks.getEffectivePromptManifest.mock.results[0]?.value,
    )
    expect(JSON.stringify(result)).not.toContain('complete effective prompt')
  })

  it('rejects an advanced Prompt body when the displayed Manifest has become stale', async () => {
    const handler = mocks.handlers.get('ipc:resource.read')

    await expect(handler?.({
      path: 'xiaogui://prompt-catalog/product-system-layers-preview',
      expectedPromptSha256: 'b'.repeat(64),
    })).resolves.toEqual({ error: 'XIAOGUI_PROMPT_DIAGNOSTICS_STALE' })
  })

  it('keeps code-owned Prompt catalog resources read-only', async () => {
    const handler = mocks.handlers.get('ipc:resource.write')

    await expect(handler?.({
      path: 'xiaogui://prompt-catalog/capability-registry',
      content: 'forged',
    })).resolves.toEqual({ ok: false, error: '只读预览不可保存' })
  })

  it('rebinds diagnostics instead of reusing a live Worker from another project', async () => {
    mocks.workerManager.isRunning = true
    mocks.workerManager.cwd = 'C:/project-a'
    const handler = mocks.handlers.get('ipc:resource.read')

    await expect(handler?.({ path: 'xiaogui://prompt-catalog/product-system-layers-preview' })).resolves.toEqual({
      content: 'product layers only',
      path: 'xiaogui://prompt-catalog/product-system-layers-preview',
      revisions: [],
    })

    expect(mocks.start).toHaveBeenCalledWith('C:/repo')
    expect(mocks.getEffectivePromptPreview).toHaveBeenCalledOnce()
    expect(mocks.getSystemPrompt).not.toHaveBeenCalled()
  })

  it('rebinds the Prompt catalog to the current project Worker', async () => {
    mocks.workerManager.isRunning = true
    mocks.workerManager.cwd = 'C:/project-a'
    const handler = mocks.handlers.get('ipc:prompts.list')

    await handler?.({})

    expect(mocks.listAgentsContextFiles).toHaveBeenCalledWith('C:/repo')
    expect(mocks.listPiBuiltinPromptFiles).toHaveBeenCalledWith('C:/repo', true)
    expect(mocks.listPluginInjectedPromptFiles).toHaveBeenCalledWith('C:/repo')
    expect(mocks.listCodeOwnedPromptCatalogFiles).toHaveBeenCalledOnce()
    expect(mocks.listPromptsOnDisk).toHaveBeenCalledWith('C:/repo')
    expect(mocks.start).toHaveBeenCalledWith('C:/repo')
    expect(mocks.getEffectivePromptManifest).toHaveBeenCalledOnce()
    expect(mocks.getPromptTemplatesList).toHaveBeenCalledOnce()
  })

  it('keeps product, user, project, Slash, capability and subtask entries distinct', async () => {
    mocks.listAgentsContextFiles.mockReturnValueOnce([{
      id: 'agents:project', category: 'project_context', name: 'AGENTS.md',
      description: '', path: 'C:/repo/AGENTS.md', command: '', editable: true,
    }])
    mocks.listPiBuiltinPromptFiles.mockReturnValueOnce([
      {
        id: 'builtin:system:default', category: 'product_system_layers', name: 'Manifest',
        description: '', path: null, command: '', editable: false, readOnly: true,
      },
      {
        id: 'builtin:system:global', category: 'user_system_append', name: 'SYSTEM.md',
        description: '', path: 'C:/agent/SYSTEM.md', command: '', editable: true,
      },
    ])
    mocks.listCodeOwnedPromptCatalogFiles.mockReturnValueOnce([
      {
        id: 'builtin:capability-registry', category: 'tool_capability_guidelines',
        name: 'Capability', description: '', path: 'xiaogui://prompt-catalog/capability-registry',
        command: '', editable: false, readOnly: true,
      },
      {
        id: 'builtin:subtask:template-intake-analysis', category: 'subtask_prompts',
        name: 'Subtask', description: '',
        path: 'xiaogui://prompt-catalog/subtask/template-intake-analysis',
        command: '', editable: false, readOnly: true,
      },
    ])
    mocks.listPromptsOnDisk.mockReturnValueOnce([{
      name: 'review', description: '', path: 'C:/repo/.pi/prompts/review.md',
      source: 'project', command: '/review',
    }])
    const handler = mocks.handlers.get('ipc:prompts.list')

    const result = await handler?.({}) as {
      prompts: Array<{ category: string }>
      virtualSystemPreviewPath: string
    }

    expect(new Set(result.prompts.map((entry) => entry.category))).toEqual(new Set([
      'product_system_layers',
      'user_system_append',
      'project_context',
      'slash_prompt_templates',
      'tool_capability_guidelines',
      'subtask_prompts',
    ]))
    expect(result.virtualSystemPreviewPath)
      .toBe('xiaogui://prompt-catalog/product-system-layers-preview')
  })

  it('lazily starts the current project worker before listing skills', async () => {
    mocks.start.mockImplementation(async (cwd: string) => {
      mocks.workerManager.isRunning = true
      mocks.workerManager.cwd = cwd
      return { sessionId: 'sid' }
    })
    mocks.getSkillsList.mockResolvedValue({
      complete: true,
      projectTrusted: true,
      effectiveSkills: [],
      candidates: [{
        key: 'host|C:/repo/.pi/skills/review/SKILL.md|local',
        runtimeId: 'host',
        name: 'review',
        description: 'Review code',
        filePath: 'C:/repo/.pi/skills/review/SKILL.md',
        source: 'local',
        scope: 'project',
        origin: 'top-level',
        enabled: true,
        effective: true,
        shadowed: false,
        command: '/skill:review',
        editable: true,
        movable: true,
        canCopyToUser: true,
        canCopyToProject: false,
      }],
    })
    const handler = mocks.handlers.get('ipc:skills.list')

    const result = await handler?.({}) as { skills?: Array<{ name?: string }> }

    expect(mocks.start).toHaveBeenCalledWith('C:/repo')
    expect(mocks.getSkillsList).toHaveBeenCalled()
    expect(result.skills?.[0]?.name).toBe('review')
  })

  it('authorizes skill mutations by opaque catalog key and reports reload failures', async () => {
    mocks.workerManager.isRunning = true
    mocks.applySkillOverrides.mockResolvedValue(1)
    mocks.reloadResources.mockRejectedValue(new Error('reload failed'))
    const handler = mocks.handlers.get('ipc:skills.applyOverrides')

    await expect(handler?.({
      changes: [{ key: 'host|/skills/review/SKILL.md|local', enabled: false, path: 'C:/forged' }],
    })).resolves.toEqual({ ok: false, error: 'reload failed' })

    expect(mocks.applySkillOverrides).toHaveBeenCalledWith([
      { key: 'host|/skills/review/SKILL.md|local', enabled: false },
    ])
  })

  it('does not accept a renderer path for skill description writes', async () => {
    mocks.workerManager.isRunning = true
    mocks.writeSkillDescription.mockResolvedValue('Updated')
    const handler = mocks.handlers.get('ipc:skills.description.write')

    await expect(handler?.({
      key: 'host|/skills/review/SKILL.md|local',
      path: 'C:/forged',
      description: 'Updated',
    })).resolves.toEqual({ ok: true, description: 'Updated' })

    expect(mocks.writeSkillDescription).toHaveBeenCalledWith(
      'host|/skills/review/SKILL.md|local',
      'Updated',
    )
  })
})
