import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'

import { sessionScopeResolverV1 } from './scope-service'
import {
  WorkDocumentSnapshotServiceV1,
  type WorkDocumentSnapshotDialogPortV1,
} from './work-document-snapshot-service'

function currentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
}

async function choosePdf(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: '选择要读取的 PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  }
  const win = currentWindow()
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

const nativeDialogs: WorkDocumentSnapshotDialogPortV1 = {
  choosePdf,
}

let defaultService: WorkDocumentSnapshotServiceV1 | null = null

/**
 * 默认组合：系统选择器 + 主进程临时目录 + 可信会话绑定。
 * 不注册任何 Renderer IPC；Pi Worker 工具是唯一入口。
 */
export function getDefaultWorkDocumentSnapshotServiceV1(): WorkDocumentSnapshotServiceV1 {
  defaultService ??= new WorkDocumentSnapshotServiceV1({
    lookup: sessionScopeResolverV1,
    dialogs: nativeDialogs,
    tempRoot: join(app.getPath('userData'), 'work-document-snapshot-v1'),
  })
  return defaultService
}
