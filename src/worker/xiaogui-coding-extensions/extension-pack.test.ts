import { describe, expect, it, vi } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { createXiaoguiCodingExtensionPackV1 } from './extension-pack'

describe('Xiaogui Coding Extension Pack V1 Pi seam', () => {
  it('registers six hidden contract-only modules without hooks or tools in P0', async () => {
    const emitted: unknown[] = []
    const pack = createXiaoguiCodingExtensionPackV1({
      registrationId: 'p0-scripted',
      emit: async (event) => {
        emitted.push(event)
      },
    })
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI

    expect(pack.schemaVersion).toBe(1)
    expect(pack.modules).toHaveLength(6)
    for (const module of pack.modules) {
      expect(module.hidden).toBe(true)
      await module.factory(pi)
    }

    expect(pi.on).not.toHaveBeenCalled()
    expect(pi.registerTool).not.toHaveBeenCalled()
    expect(emitted).toEqual(pack.modules.map((module) => ({
      schemaVersion: 1,
      eventType: 'MODULE_REGISTERED',
      eventId: `p0-scripted:${module.manifest.extensionId}:registered`,
      source: 'PI_EXTENSION',
      manifest: module.manifest,
    })))
  })
})
