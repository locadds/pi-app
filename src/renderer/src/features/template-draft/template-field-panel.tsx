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
  selectedFieldId,
  onSelect,
  onRename,
}: {
  fields: readonly TemplateFieldV2[]
  names: Readonly<Record<string, string>>
  selectedFieldId: string | null
  onSelect: (fieldId: string) => void
  onRename: (fieldId: string, name: string) => void
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
      {fields.map((field) => (
        <button
          key={field.fieldId}
          type="button"
          onClick={() => onSelect(field.fieldId)}
          className={cn(
            'w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/40',
            selectedFieldId === field.fieldId && 'border-primary bg-primary/5',
          )}
        >
          <div className="flex items-center gap-2">
            <input
              aria-label={`${field.displayName}字段名称`}
              value={names[field.fieldId] ?? field.displayName}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onRename(field.fieldId, event.target.value)}
              className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium outline-none focus:ring-0"
            />
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
      ))}
    </div>
  )
}

