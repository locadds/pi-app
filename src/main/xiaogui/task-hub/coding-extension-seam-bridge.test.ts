import { describe, expect, it, vi } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { createXiaoguiCodingExtensionPackV1 } from '../../../worker/xiaogui-coding-extensions/extension-pack'
import { createCodingExtensionSeamBridgeV1 } from './coding-extension-seam-bridge'

describe('CODING P0 three-seam Scripted round trip', () => {
  it('carries each Pi module registration through TaskHub before publishing a renderer projection', async () => {
    const accepted: string[] = []
    const projections: unknown[] = []
    const bridge = createCodingExtensionSeamBridgeV1({
      taskHub: {
        async accept(event) {
          accepted.push(event.eventId)
          return {
            schemaVersion: 1,
            eventId: event.eventId,
            accepted: true,
            hubSequence: accepted.length,
            manifestDigest: `sha256:${'a'.repeat(64)}`,
          }
        },
      },
      renderer: {
        async publish(projection) {
          projections.push(projection)
        },
      },
    })
    const receipts: unknown[] = []
    const pack = createXiaoguiCodingExtensionPackV1({
      registrationId: 'p0-roundtrip',
      emit: async (event) => {
        receipts.push(await bridge.dispatch(event))
      },
    })

    for (const module of pack.modules) {
      await module.factory({} as ExtensionAPI)
    }

    expect(accepted).toHaveLength(6)
    expect(projections).toEqual(pack.modules.map((module, index) => ({
      schemaVersion: 1,
      sourceEventId: `p0-roundtrip:${module.manifest.extensionId}:registered`,
      hubSequence: index + 1,
      extensionId: module.manifest.extensionId,
      displayName: module.manifest.displayName,
      readiness: 'CONTRACT_REGISTERED',
    })))
    expect(receipts).toEqual(accepted.map((eventId, index) => ({
      schemaVersion: 1,
      eventId,
      hubSequence: index + 1,
      rendererPublished: true,
    })))
  })

  it('fails closed before TaskHub when a Pi event does not match the frozen manifest', async () => {
    const accept = vi.fn()
    const publish = vi.fn()
    const bridge = createCodingExtensionSeamBridgeV1({
      taskHub: { accept },
      renderer: { publish },
    })

    await expect(bridge.dispatch({
      schemaVersion: 1,
      eventType: 'MODULE_REGISTERED',
      eventId: 'forged:coding.context:registered',
      source: 'PI_EXTENSION',
      manifest: {
        schemaVersion: 1,
        extensionId: 'coding.context',
        displayName: '伪造模块',
        allowedModes: ['CODING'],
        defaultEnabled: false,
        requiredSeams: ['PI_EXTENSION', 'TASK_HUB', 'RENDERER_EXTENSION_UI'],
        capabilities: ['CONTEXT.FILE'],
      },
    })).rejects.toThrow('XIAOGUI_CODING_EXTENSION_EVENT_INVALID')
    expect(accept).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects undeclared fields before an absolute path can reach TaskHub', async () => {
    const accept = vi.fn()
    const bridge = createCodingExtensionSeamBridgeV1({
      taskHub: { accept },
      renderer: { publish: vi.fn() },
    })
    const pack = createXiaoguiCodingExtensionPackV1({
      registrationId: 'p0-path-guard',
      emit: vi.fn(),
    })

    await expect(bridge.dispatch({
      schemaVersion: 1,
      eventType: 'MODULE_REGISTERED',
      eventId: 'p0-path-guard:coding.context:registered',
      source: 'PI_EXTENSION',
      manifest: pack.modules[0]?.manifest,
      sourcePath: 'C:\\secret\\project',
    })).rejects.toThrow('XIAOGUI_CODING_EXTENSION_EVENT_INVALID')
    expect(accept).not.toHaveBeenCalled()
  })
})
