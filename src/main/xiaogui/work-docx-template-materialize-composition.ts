import { app, BrowserWindow, dialog, shell, type SaveDialogOptions } from 'electron'
import { join } from 'node:path'

import { sessionScopeResolverV1 } from './scope-service'
import { getDefaultWorkDocxTemplateIntakeServiceV1 } from './work-docx-template-intake-composition'
import { WorkDocxTemplateMaterializeServiceV1 } from './work-docx-template-materialize-service'
import { WorkDocxTemplateMaterializeStoreV1 } from './work-docx-template-materialize-store'

let defaultService: WorkDocxTemplateMaterializeServiceV1 | null = null

async function chooseNewTarget(suggestedName: string): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: '另存为正式 Word 模板',
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

export function getDefaultWorkDocxTemplateMaterializeServiceV1(): WorkDocxTemplateMaterializeServiceV1 {
  defaultService ??= new WorkDocxTemplateMaterializeServiceV1({
    lookup: sessionScopeResolverV1,
    intake: getDefaultWorkDocxTemplateIntakeServiceV1(),
    store: new WorkDocxTemplateMaterializeStoreV1(
      join(
        app.getPath('userData'),
        'xiaogui',
        'template-materialize',
        'v1',
        'template-materialize.sqlite',
      ),
    ),
    dialogs: { chooseNewTarget },
    outputAccess: {
      openPath: (path) => shell.openPath(path),
      revealPath: async (path) => shell.showItemInFolder(path),
    },
    tempRoot: join(app.getPath('temp'), 'xiaogui-template-materialize', 'v1'),
  })
  return defaultService
}

export function closeDefaultWorkDocxTemplateMaterializeServiceV1(): void {
  defaultService?.close()
  defaultService = null
}
