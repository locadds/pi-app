import { app, BrowserWindow, dialog, shell, type SaveDialogOptions } from 'electron'
import { join } from 'node:path'

import { sessionScopeResolverV1 } from './scope-service'
import { WorkReportDocxServiceV1 } from './work-report-docx-service'
import { WorkReportDocxStoreV1 } from './work-report-docx-store'

let defaultService: WorkReportDocxServiceV1 | null = null

async function chooseNewTarget(suggestedName: string): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: '另存为标准 Word 报告',
    defaultPath: suggestedName,
    filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  return result.canceled ? null : (result.filePath ?? null)
}

export function getDefaultWorkReportDocxServiceV1(): WorkReportDocxServiceV1 {
  defaultService ??= new WorkReportDocxServiceV1({
    lookup: sessionScopeResolverV1,
    store: new WorkReportDocxStoreV1(
      join(app.getPath('userData'), 'xiaogui', 'work-report-docx', 'v1', 'report-docx.sqlite'),
    ),
    dialogs: { chooseNewTarget },
    outputAccess: {
      openPath: (path) => shell.openPath(path),
      revealPath: async (path) => shell.showItemInFolder(path),
    },
    tempRoot: join(app.getPath('temp'), 'xiaogui-work-report-docx', 'v1'),
  })
  return defaultService
}

export function closeDefaultWorkReportDocxServiceV1(): void {
  defaultService?.close()
  defaultService = null
}
