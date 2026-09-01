import type {
  CodingPermissionPromptV1,
  CodingPermissionUserChoiceV1,
} from '@shared/xiaogui-coding-extension-pack'

import { ExtensionDialogShell } from './extension-dialog-shell'

export interface CodingPermissionDialogProps {
  readonly prompt: CodingPermissionPromptV1
  readonly onChoose: (choice: CodingPermissionUserChoiceV1) => void
}

const OPERATION_LABELS: Record<CodingPermissionPromptV1['operation'], string> = {
  READ: '读取文件',
  WRITE: '修改文件',
  COMMAND: '运行命令',
  DATA_EGRESS: '数据外传',
}

export function CodingPermissionDialog({ prompt, onChoose }: CodingPermissionDialogProps) {
  return (
    <ExtensionDialogShell title="需要你的许可" onDismiss={() => onChoose('DENY')} wide>
      <div className="space-y-4 text-[13px]">
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="font-medium">{OPERATION_LABELS[prompt.operation]}</div>
          <p className="mt-1 text-muted-foreground">{prompt.summary}</p>
        </div>
        {prompt.relativePaths.length > 0 && (
          <div>
            <div className="mb-1 text-muted-foreground">本次任务内的相对路径</div>
            <div className="max-h-40 overflow-auto rounded-md border p-2 font-mono text-[12px]">
              {prompt.relativePaths.map((path) => <div key={path}>{path}</div>)}
            </div>
          </div>
        )}
        {prompt.commandSummary && (
          <div>
            <div className="mb-1 text-muted-foreground">命令摘要</div>
            <div className="rounded-md border p-2 font-mono text-[12px]">{prompt.commandSummary}</div>
          </div>
        )}
        {prompt.egressDestination && (
          <div>
            <div className="mb-1 text-muted-foreground">外部目标</div>
            <div className="rounded-md border p-2 text-[12px]">{prompt.egressDestination}</div>
          </div>
        )}
        {prompt.dataEgress === 'REQUESTED' && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-200">
            此操作会把任务数据发送到外部服务。
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            className="rounded-md border px-3 py-2 hover:bg-muted"
            onClick={() => onChoose('ALLOW_ONCE')}
          >
            允许一次
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-2 hover:bg-muted"
            onClick={() => onChoose('ALLOW_TASK_RULE')}
          >
            允许本次任务中的相同规则
          </button>
          <button
            type="button"
            className="rounded-md bg-destructive px-3 py-2 text-destructive-foreground"
            onClick={() => onChoose('DENY')}
          >
            拒绝
          </button>
        </div>
      </div>
    </ExtensionDialogShell>
  )
}
