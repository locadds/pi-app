import {
  isCodingExtensionRegistrationEventV1,
  type CodingExtensionHubReceiptV1,
  type CodingExtensionRegistrationEventV1,
  type CodingExtensionRendererProjectionV1,
  type CodingExtensionRoundTripReceiptV1,
} from '@shared/xiaogui-coding-extension-pack'

export interface CodingExtensionTaskHubPortV1 {
  accept(event: CodingExtensionRegistrationEventV1): Promise<CodingExtensionHubReceiptV1>
}

export interface CodingExtensionRendererPortV1 {
  publish(projection: CodingExtensionRendererProjectionV1): Promise<void>
}

export interface CodingExtensionSeamBridgeV1 {
  dispatch(event: unknown): Promise<CodingExtensionRoundTripReceiptV1>
}

export interface CreateCodingExtensionSeamBridgeInputV1 {
  readonly taskHub: CodingExtensionTaskHubPortV1
  readonly renderer: CodingExtensionRendererPortV1
}

/**
 * P0 architectural Spike. TaskHub must accept the Pi event before Renderer can
 * observe a projection. Production persistence and UI activation remain gated
 * to P1-P3; this module intentionally does not alter TaskHub state.
 */
export function createCodingExtensionSeamBridgeV1(
  input: CreateCodingExtensionSeamBridgeInputV1,
): CodingExtensionSeamBridgeV1 {
  return Object.freeze({
    async dispatch(event: unknown): Promise<CodingExtensionRoundTripReceiptV1> {
      if (!isCodingExtensionRegistrationEventV1(event)) {
        throw new Error('XIAOGUI_CODING_EXTENSION_EVENT_INVALID')
      }

      const hubReceipt = await input.taskHub.accept(event)
      if (!isMatchingHubReceipt(hubReceipt, event.eventId)) {
        throw new Error('XIAOGUI_CODING_EXTENSION_HUB_RECEIPT_INVALID')
      }

      await input.renderer.publish(Object.freeze({
        schemaVersion: 1,
        sourceEventId: event.eventId,
        hubSequence: hubReceipt.hubSequence,
        extensionId: event.manifest.extensionId,
        displayName: event.manifest.displayName,
        readiness: 'CONTRACT_REGISTERED',
      }))

      return Object.freeze({
        schemaVersion: 1,
        eventId: event.eventId,
        hubSequence: hubReceipt.hubSequence,
        rendererPublished: true,
      })
    },
  })
}

function isMatchingHubReceipt(
  value: CodingExtensionHubReceiptV1,
  eventId: string,
): boolean {
  return value.schemaVersion === 1
    && value.accepted === true
    && value.eventId === eventId
    && Number.isSafeInteger(value.hubSequence)
    && value.hubSequence > 0
    && /^sha256:[0-9a-f]{64}$/.test(value.manifestDigest)
}
