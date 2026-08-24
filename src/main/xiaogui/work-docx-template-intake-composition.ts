import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'

import { sessionScopeResolverV1 } from './scope-service'
import { getDefaultWorkDocxServiceV1 } from './work-docx-ipc'
import { WorkDocxTemplateIntakeServiceV1 } from './work-docx-template-intake-service'
import { WorkDocxTemplateIntakeStoreV1 } from './work-docx-template-intake-store'

let defaultService: WorkDocxTemplateIntakeServiceV1 | null = null

async function chooseSource(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: '选择要整理的普通成品 Word',
    properties: ['openFile'],
    filters: [{ name: 'Word 文档', extensions: ['docx'] }],
  }
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

export function getDefaultWorkDocxTemplateIntakeServiceV1(): WorkDocxTemplateIntakeServiceV1 {
  defaultService ??= new WorkDocxTemplateIntakeServiceV1({
    lookup: sessionScopeResolverV1,
    dialogs: { chooseSource },
    handoffs: getDefaultWorkDocxServiceV1(),
    store: new WorkDocxTemplateIntakeStoreV1(
      join(
        app.getPath('userData'),
        'xiaogui',
        'template-intake',
        'v1',
        'template-intake.sqlite',
      ),
    ),
  })
  return defaultService
}

export function closeDefaultWorkDocxTemplateIntakeServiceV1(): void {
  defaultService?.close()
  defaultService = null
}
