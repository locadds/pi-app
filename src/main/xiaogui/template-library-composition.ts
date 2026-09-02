import { app, BrowserWindow, dialog } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { join } from 'node:path'

import { TemplateLibraryServiceV1 } from './template-library-service'

let defaultService: TemplateLibraryServiceV1 | null = null

export function getDefaultTemplateLibraryServiceV1(): TemplateLibraryServiceV1 {
  defaultService ??= new TemplateLibraryServiceV1({
    preferencePath: join(
      app.getPath('userData'),
      'xiaogui',
      'template-library',
      'v1',
      'root.json',
    ),
  })
  return defaultService
}

export async function chooseAndConfigureDefaultTemplateLibraryV1(): Promise<{ configured: boolean }> {
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const options: OpenDialogOptions = {
    title: '选择小规模板库文件夹',
    properties: ['openDirectory', 'createDirectory'],
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return { configured: false }
  return getDefaultTemplateLibraryServiceV1().configureRoot(result.filePaths[0])
}

export function closeDefaultTemplateLibraryServiceV1(): void {
  defaultService?.close()
  defaultService = null
}
