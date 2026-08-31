import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  XIAOGUI_CODING_EXTENSION_MANIFESTS_V1,
  type CodingExtensionManifestV1,
  type CodingExtensionRegistrationEventV1,
} from '@shared/xiaogui-coding-extension-pack'

export type CodingExtensionEventSinkV1 = (
  event: CodingExtensionRegistrationEventV1,
) => void | Promise<void>

export interface XiaoguiCodingExtensionModuleV1 {
  readonly name: string
  readonly hidden: true
  readonly manifest: CodingExtensionManifestV1
  readonly factory: ExtensionFactory
}

export interface XiaoguiCodingExtensionPackV1 {
  readonly schemaVersion: 1
  readonly name: 'xiaogui-coding-extension-pack-v1'
  readonly modules: readonly XiaoguiCodingExtensionModuleV1[]
}

export interface CreateXiaoguiCodingExtensionPackInputV1 {
  readonly registrationId: string
  readonly emit: CodingExtensionEventSinkV1
}

/**
 * First-party Pi extension registrar for CODING. P0 registers contract-only
 * modules: it deliberately installs no hooks and no tools until each later
 * production gate is accepted.
 */
export function createXiaoguiCodingExtensionPackV1(
  input: CreateXiaoguiCodingExtensionPackInputV1,
): XiaoguiCodingExtensionPackV1 {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.registrationId)) {
    throw new Error('XIAOGUI_CODING_EXTENSION_REGISTRATION_ID_INVALID')
  }

  const modules = XIAOGUI_CODING_EXTENSION_MANIFESTS_V1.map((entry) => {
    const manifest = entry
    const module: XiaoguiCodingExtensionModuleV1 = Object.freeze({
      name: `xiaogui-${manifest.extensionId.replace('.', '-')}-v1`,
      hidden: true,
      manifest,
      async factory() {
        await input.emit(Object.freeze({
          schemaVersion: 1,
          eventType: 'MODULE_REGISTERED',
          eventId: `${input.registrationId}:${manifest.extensionId}:registered`,
          source: 'PI_EXTENSION',
          manifest,
        }))
      },
    })
    return module
  })

  return Object.freeze({
    schemaVersion: 1,
    name: 'xiaogui-coding-extension-pack-v1',
    modules: Object.freeze(modules),
  })
}
