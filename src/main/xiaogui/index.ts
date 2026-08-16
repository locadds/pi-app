/**
 * 小规集成入口：由 src/main/index.ts 在 app.whenReady() 后调用。
 *
 * 职责：
 * - 注册小规 IPC handlers（白名单见 packages/shared/ipc-channels.ts）。
 *
 * sidecar 优雅退出已并入主进程 gracefulShutdownWorkers 链（带超时 await），
 * 不再在 before-quit 里 fire-and-forget——否则 app.exit(0) 会竞态残留孤儿
 * python 进程。见 shutdownXiaoguiSidecar。
 */

import { registerXiaoguiHandlers } from './ipc-handlers'
import { xiaogui } from './sidecar-bridge'
import { registerWorkDocxHandlers } from './work-docx-ipc'

let initialized = false

export function initXiaogui(): void {
  if (initialized) return
  initialized = true

  registerXiaoguiHandlers()
  registerWorkDocxHandlers()

  console.log('[xiaogui] 集成层已初始化（sidecar 惰性启动：首次 tool.invoke 时 spawn）')
}

/** 优雅停止 Python sidecar（并入 gracefulShutdownWorkers 链，带超时 await）。 */
export async function shutdownXiaoguiSidecar(): Promise<void> {
  await xiaogui.shutdown()
}
