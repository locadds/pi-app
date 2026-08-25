import { app, BrowserWindow, dialog, shell, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { join } from 'node:path'

import { sessionScopeResolverV1 } from './scope-service'
import { WorkDocxAdvancedGenerationServiceV1 } from './work-docx-advanced-generation-service'
import { WorkDocxAdvancedGenerationStoreV1 } from './work-docx-advanced-generation-store'

let defaultService: WorkDocxAdvancedGenerationServiceV1 | null = null

async function chooseTemplate(): Promise<string | null> {
  const options: OpenDialogOptions = { title: '选择小规正式 Word 模板', filters: [{ name: 'Word 文档', extensions: ['docx'] }], properties: ['openFile'] }
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function chooseNewTarget(suggestedName: string): Promise<string | null> {
  const options: SaveDialogOptions = { title: '另存为 Word 成品', defaultPath: suggestedName, filters: [{ name: 'Word 文档', extensions: ['docx'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] }
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  return result.canceled ? null : (result.filePath ?? null)
}

export function getDefaultWorkDocxAdvancedGenerationServiceV1(): WorkDocxAdvancedGenerationServiceV1 {
  defaultService ??= new WorkDocxAdvancedGenerationServiceV1({
    lookup: sessionScopeResolverV1,
    store: new WorkDocxAdvancedGenerationStoreV1(join(app.getPath('userData'), 'xiaogui', 'advanced-generation', 'v1', 'advanced-generation.sqlite')),
    dialogs: { chooseTemplate, chooseNewTarget },
    outputAccess: { openPath: (path) => shell.openPath(path), revealPath: async (path) => shell.showItemInFolder(path) },
    tempRoot: join(app.getPath('temp'), 'xiaogui-advanced-generation', 'v1'),
  })
  return defaultService
}

export function closeDefaultWorkDocxAdvancedGenerationServiceV1(): void { defaultService?.close(); defaultService = null }
