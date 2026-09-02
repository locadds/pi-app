import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { basename, extname, join } from 'node:path'

import { sessionScopeResolverV1 } from './scope-service'
import { getDefaultWorkDocxServiceV1 } from './work-docx-ipc'
import { WorkDocxTemplateIntakeServiceV1 } from './work-docx-template-intake-service'
import { WorkDocxTemplateIntakeStoreV1 } from './work-docx-template-intake-store'
import { getDefaultDocumentReviewRendererV1 } from './work-document-review-renderer-composition'
import { opaqueScopeIdDeriverV1 } from './scope-derive'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

let defaultService: WorkDocxTemplateIntakeServiceV1 | null = null
const stagedSourceByProject = new Map<string, { sourcePath: string; stagedAt: number }>()
const STAGED_SOURCE_TTL_MS = 15 * 60 * 1000

function currentStagedSource(projectId: string): { sourcePath: string; stagedAt: number } | null {
  const staged = stagedSourceByProject.get(projectId) ?? null
  if (!staged) return null
  if (Date.now() - staged.stagedAt <= STAGED_SOURCE_TTL_MS) return staged
  stagedSourceByProject.delete(projectId)
  return null
}

async function chooseSource(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: '选择要整理的普通成品 Word',
    properties: ['openFile'],
    filters: [{ name: '文档', extensions: ['docx', 'doc'] }],
  }
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

function consumeStagedSource(address: SessionAddressV1): { sourcePath: string } | null {
  const staged = currentStagedSource(address.projectId)
  if (!staged) return null
  stagedSourceByProject.delete(address.projectId)
  return { sourcePath: staged.sourcePath }
}

export function hasStagedTemplateIntakeSourceForProjectV1(projectId: string): boolean {
  return currentStagedSource(projectId) != null
}

export async function chooseTemplateIntakeSourceForWorkspaceV1(
  workspaceRoot: string,
): Promise<{ cancelled: true } | { cancelled: false; fileDisplayName: string }> {
  const selectedPath = await chooseSource()
  if (!selectedPath) return { cancelled: true }
  if (!['.doc', '.docx'].includes(extname(selectedPath).toLowerCase())) {
    throw new Error('TEMPLATE_INTAKE_INPUT_INVALID')
  }
  const projectId = opaqueScopeIdDeriverV1.deriveProject(workspaceRoot).projectId
  stagedSourceByProject.set(projectId, { sourcePath: selectedPath, stagedAt: Date.now() })
  return { cancelled: false, fileDisplayName: basename(selectedPath) }
}

export function getDefaultWorkDocxTemplateIntakeServiceV1(): WorkDocxTemplateIntakeServiceV1 {
  defaultService ??= new WorkDocxTemplateIntakeServiceV1({
    lookup: sessionScopeResolverV1,
    dialogs: { chooseSource },
    handoffs: {
      consumeTemplateIntakeHandoff(address) {
        return consumeStagedSource(address)
          ?? getDefaultWorkDocxServiceV1().consumeTemplateIntakeHandoff(address)
      },
    },
    store: new WorkDocxTemplateIntakeStoreV1(
      join(
        app.getPath('userData'),
        'xiaogui',
        'template-intake',
        'v1',
        'template-intake.sqlite',
      ),
    ),
    reviewRenderer: getDefaultDocumentReviewRendererV1(),
    templateDraftV2Enabled: process.env.XIAOGUI_TEMPLATE_DRAFT_V2 !== '0',
  })
  return defaultService
}

export function closeDefaultWorkDocxTemplateIntakeServiceV1(): void {
  defaultService?.close()
  defaultService = null
  stagedSourceByProject.clear()
}
