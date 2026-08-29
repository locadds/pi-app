import type { TemplateFieldV2 } from '@shared/xiaogui-template-field-graph-v2'
import { cn } from '@renderer/lib/utils'

const VALUE_TYPE_LABELS: Record<TemplateFieldV2['valueType'], string> = {
  TEXT: '文字',
  DATE: '日期',
  NUMBER: '数字',
  MONEY: '金额',
  ORGANIZATION: '单位',
  PERSON: '人员',
  LOCATION: '地点',
  IMAGE: '图片',
  TABLE: '表格',
}

export function TemplateFieldPanel({
  fields,
  names,
  values,
  syncingFieldId,
  syncResults,
  selectedFieldId,
  onSelect,
  onRename,
  onValueChange,
  onApplyValue,
  onFocusNext,
}: {
  fields: readonly TemplateFieldV2[]
  names: Readonly<Record<string, string>>
  values: Readonly<Record<string, string>>
  syncingFieldId: string | null
  syncResults: Readonly<Record<string, { updated: number; failed: number }>>
  selectedFieldId: string | null
  onSelect: (fieldId: string) => void
  onRename: (fieldId: string, name: string) => void
  onValueChange: (fieldId: string, value: string) => void
  onApplyValue: (fieldId: string) => void
  onFocusNext: (fieldId: string) => void
}) {
  if (!fields.length) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-[12px] leading-6 text-muted-foreground">
        暂未形成可复用的业务字段。原文会保持不变，不会因为没有识别结果而被整篇标黄。
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {fields.map((field) => {
        const selected = selectedFieldId === field.fieldId
        const result = syncResults[field.fieldId]
        return (
          <div
            key={field.fieldId}
            className={cn(
              'w-full rounded-lg border text-left transition-colors hover:bg-muted/20',
              selected && 'border-primary bg-primary/5',
            )}
          >
            <button type="button" onClick={() => onSelect(field.fieldId)} className="w-full p-3 text-left">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {names[field.fieldId] ?? field.displayName}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {VALUE_TYPE_LABELS[field.valueType]}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
                示例：{field.sampleValue || '暂无示例'}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                文档中共 {field.occurrenceIds.length} 处；修改一次会同步这些位置
              </p>
            </button>

            {selected ? (
              <div className="space-y-3 border-t border-border/70 p-3">
                <label className="block text-[10px] text-muted-foreground">
                  字段名称
                  <input
                    aria-label={`${field.displayName}字段名称`}
                    value={names[field.fieldId] ?? field.displayName}
                    onChange={(event) => onRename(field.fieldId, event.target.value)}
                    className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-primary"
                  />
                </label>
                <label className="block text-[10px] text-muted-foreground">
                  试填新内容（只写入本机工作副本）
                  <textarea
                    aria-label={`${field.displayName}试填内容`}
                    rows={2}
                    value={values[field.fieldId] ?? field.sampleValue ?? ''}
                    onChange={(event) => onValueChange(field.fieldId, event.target.value)}
                    className="mt-1 w-full resize-y rounded-md border bg-background px-2 py-1.5 text-[12px] leading-5 text-foreground outline-none focus:border-primary"
                    placeholder="输入一次，全文相同字段同步更新"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onFocusNext(field.fieldId)}
                    className="rounded-md border px-2.5 py-1.5 text-[11px] hover:bg-muted"
                  >
                    定位下一处
                  </button>
                  <button
                    type="button"
                    disabled={syncingFieldId !== null || !(values[field.fieldId] ?? field.sampleValue ?? '').trim()}
                    onClick={() => onApplyValue(field.fieldId)}
                    className="rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground disabled:opacity-40"
                  >
                    {syncingFieldId === field.fieldId ? '正在同步…' : `同步到全文 ${field.occurrenceIds.length} 处`}
                  </button>
                </div>
                {result ? (
                  <p className={cn('text-[10px]', result.failed ? 'text-amber-700' : 'text-emerald-700')}>
                    {result.failed
                      ? `同步未完成：成功 ${result.updated} 处，失败 ${result.failed} 处；未按成功处理。`
                      : `已同步 ${result.updated} 处并保存工作副本，原始文档未修改。`}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
