import { app, BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'

import type { WorkDocxConfirmRequestV1, WorkDocxPrepareRequestV1 } from '@shared/xiaogui-work-docx'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import { registerHandlerWithSchema } from '../ipc/registry'
import { sessionScopeResolverV1 } from './scope-service'
import { WorkDocxServiceV1, type WorkDocxDialogPortV1 } from './work-docx-service'

const AddressSchema = z.object({
  projectId: z.string().regex(/^xgp1_[0-9a-f]{64}$/),
  sessionKey: z.string().regex(/^xgs1_[0-9a-f]{64}$/),
}).strict()

const PrepareSchema = z.object({ address: AddressSchema }).strict()
const ConfirmSchema = z.object({
  address: AddressSchema,
  operationId: z.string().regex(/^xgw1_[0-9a-f-]{36}$/),
}).strict()

function currentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
}

async function chooseFile(title: string, extension: string): Promise<string | null> {
  const options: OpenDialogOptions = {
    title,
    properties: ['openFile'],
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  }
  const win = currentWindow()
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

const nativeDialogs: WorkDocxDialogPortV1 = {
  chooseTemplate: () => chooseFile('选择 DOCX 模板', 'docx'),
  choosePayload: () => chooseFile('选择 JSON 数据', 'json'),
  async chooseNewTarget() {
    const options: SaveDialogOptions = {
      title: '另存为新的 DOCX',
      defaultPath: '小规生成文档.docx',
      filters: [{ name: 'DOCX', extensions: ['docx'] }],
    }
    const win = currentWindow()
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return result.canceled ? null : (result.filePath ?? null)
  },
}

let defaultService: WorkDocxServiceV1 | null = null

function service(): WorkDocxServiceV1 {
  defaultService ??= new WorkDocxServiceV1({
    lookup: sessionScopeResolverV1,
    dialogs: nativeDialogs,
    tempRoot: join(app.getPath('userData'), 'work-docx-v1'),
  })
  return defaultService
}

export function registerWorkDocxHandlers(): void {
  registerHandlerWithSchema('ipc:xiaogui.work.docx.discover', AddressSchema, async (address) => {
    return service().discover(address as SessionAddressV1)
  })
  registerHandlerWithSchema('ipc:xiaogui.work.docx.prepare', PrepareSchema, async (request) => {
    return service().prepare(request as WorkDocxPrepareRequestV1)
  })
  registerHandlerWithSchema('ipc:xiaogui.work.docx.confirm', ConfirmSchema, async (request) => {
    return service().confirm(request as WorkDocxConfirmRequestV1)
  })
}
