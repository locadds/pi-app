import { createHash } from 'node:crypto'

/**
 * Produces a stable one-way installation discriminator. The input path stays
 * within the Electron main process; callers transmit only this digest.
 */
export function installationIdDigestV1(userDataPath: string): string {
  return `sha256:${createHash('sha256')
    .update('xiaogui.hub.installation.v1\0', 'utf8')
    .update(userDataPath, 'utf8')
    .digest('hex')}`
}
