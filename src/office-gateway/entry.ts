import { startOfficeGatewayV1 } from './server'

interface UtilityParentPort {
  postMessage(value: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

const cookieName = process.env.XIAOGUI_OFFICE_GATEWAY_COOKIE_NAME
const sessionToken = process.env.XIAOGUI_OFFICE_GATEWAY_SESSION_TOKEN
const viewerRoot = process.env.XIAOGUI_OFFICE_VIEWER_ROOT
const parentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort

if (!cookieName || !sessionToken || !viewerRoot || !parentPort) {
  throw new Error('Office Gateway utility process configuration is incomplete')
}

const handle = await startOfficeGatewayV1({
  sessionCookieName: cookieName,
  sessionToken,
  viewerRoot,
  initialSnapshot: {},
})

parentPort.postMessage({
  type: 'XIAOGUI_OFFICE_GATEWAY_READY_V1',
  origin: handle.origin,
  headSha256: handle.headSha256,
})

parentPort.on('message', (event) => {
  const message = event.data as { type?: unknown }
  if (message?.type !== 'XIAOGUI_OFFICE_GATEWAY_CLOSE_V1') return
  void handle.close().finally(() => process.exit(0))
})

process.once('SIGTERM', () => void handle.close().finally(() => process.exit(0)))
process.once('SIGINT', () => void handle.close().finally(() => process.exit(0)))
