import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'

import {
  canonicalizeXiaoguiTaskDeliveryReceiptV1,
  parseXiaoguiTaskDeliveryReceiptV1,
  type XiaoguiTaskDeliveryReceiptUnsignedV1,
  type XiaoguiTaskDeliveryReceiptV1,
} from '@shared/xiaogui-hub-task-contract'

export interface XiaoguiHubIssuedNodeKeyPairV1 {
  keyId: string
  publicKeyPem: string
  publicKeyDigest: string
  /** Pairing response only. Do not write this value to Hub storage or logs. */
  privateKeyPem: string
}

/**
 * Generates an Ed25519 key pair for the one-time node pairing response.
 * The caller owns any safe local persistence of the returned private key.
 */
export function issueXiaoguiHubNodeKeyPairV1(): XiaoguiHubIssuedNodeKeyPairV1 {
  const keyPair = generateKeyPairSync('ed25519')
  const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyDigest = sha256(publicKeyPem)
  return {
    keyId: `ed25519:${publicKeyDigest.slice('sha256:'.length, 'sha256:'.length + 32)}`,
    publicKeyPem,
    publicKeyDigest,
    privateKeyPem,
  }
}

export function signXiaoguiTaskDeliveryReceiptV1(
  receipt: XiaoguiTaskDeliveryReceiptUnsignedV1,
  privateKeyPem: string,
): XiaoguiTaskDeliveryReceiptV1 {
  const unsigned = parseXiaoguiTaskDeliveryReceiptV1({ ...receipt, signature: SIGNATURE_SENTINEL })
  if (!unsigned.ok) throw new Error(unsigned.reasonCode)
  const signature = sign(null, Buffer.from(canonicalizeXiaoguiTaskDeliveryReceiptV1(receipt), 'utf8'), privateKeyPem)
    .toString('base64')
  return { ...receipt, signature }
}

export function verifyXiaoguiTaskDeliveryReceiptV1(
  receipt: XiaoguiTaskDeliveryReceiptV1,
  publicKeyPem: string,
): boolean {
  const parsed = parseXiaoguiTaskDeliveryReceiptV1(receipt)
  if (!parsed.ok) return false
  try {
    return verify(
      null,
      Buffer.from(canonicalizeXiaoguiTaskDeliveryReceiptV1(receipt), 'utf8'),
      publicKeyPem,
      Buffer.from(receipt.signature, 'base64'),
    )
  } catch {
    return false
  }
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

const SIGNATURE_SENTINEL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
