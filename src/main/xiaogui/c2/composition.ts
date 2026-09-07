import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

import type { C2ArtifactReleaseRefV1, C2InstallPublicStateV1 } from '@shared/xiaogui-c2-artifact'
import { resolveActiveAgentDir } from '../../agent-dir'
import { workerManager } from '../../worker-manager'
import { xiaogui } from '../sidecar-bridge'
import { createHubTaskWorkerCredentialsV1 } from '../hub-task/worker-credentials'
import { C2ArchiveInstallerV1 } from './archive-installer'
import { c2InstallDeepLinkDispatcher } from './deep-link-dispatcher'
import { C2HubProxyGatewayV1 } from './http-gateway'
import { C2InstallCoordinatorV1 } from './install-coordinator'
import { C2ArtifactReceiptOutboxV1 } from './receipt-outbox'
import { C2StaticAppSandboxV1, registerC2StaticAppProtocolV1 } from './static-app-sandbox'

let coordinator: C2InstallCoordinatorV1 | null = null
let sandbox: C2StaticAppSandboxV1 | null = null

export function initC2ArtifactInstallV1(): C2InstallCoordinatorV1 {
  if (coordinator) return coordinator
  const appsRoot = join(app.getPath('userData'), 'c2-static-apps')
  registerC2StaticAppProtocolV1(appsRoot)
  sandbox = new C2StaticAppSandboxV1()
  coordinator = new C2InstallCoordinatorV1({
    gateway: new C2HubProxyGatewayV1(createHubTaskWorkerCredentialsV1()),
    installer: new C2ArchiveInstallerV1({
      currentXiaoguiVersion: app.getVersion(),
      supportedModes: ['WORK', 'DESIGN', 'CODING'],
    }),
    outbox: new C2ArtifactReceiptOutboxV1(join(app.getPath('userData'), 'c2', 'artifact-receipt-outbox-v1.json')),
    resolveTarget: (release) => resolveInstallTarget(release, appsRoot),
    reloadPiResources: () => workerManager.reloadResources(),
    currentMode: () => xiaogui.getMode(),
    onState: publishState,
  })
  c2InstallDeepLinkDispatcher.setConsumer((link) => {
    focusMainWindow()
    void coordinator?.preview(link)
  })
  void coordinator.flushReceipts().catch(() => undefined)
  return coordinator
}

export function getC2ArtifactInstallCoordinatorV1(): C2InstallCoordinatorV1 {
  return coordinator ?? initC2ArtifactInstallV1()
}

export function openLastInstalledC2StaticAppV1(): boolean {
  const state = getC2ArtifactInstallCoordinatorV1().status()
  if (state.phase !== 'INSTALLED' || state.installed.kind !== 'APP' || !sandbox) return false
  sandbox.open({ artifactId: state.installed.artifactId, version: state.installed.version })
  return true
}

function resolveInstallTarget(release: C2ArtifactReleaseRefV1, appsRoot: string): string {
  return release.kind === 'SKILL'
    ? join(resolveActiveAgentDir(), 'skills', release.artifactId)
    : join(appsRoot, release.artifactId, release.version)
}

function publishState(state: C2InstallPublicStateV1): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('ipc:xiaogui-c2-install-state', state)
  }
  if (state.phase === 'AWAITING_CONFIRMATION') focusMainWindow()
}

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
