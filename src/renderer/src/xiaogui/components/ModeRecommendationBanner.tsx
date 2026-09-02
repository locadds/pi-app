import type { ModeRecommendationV1 } from '@shared/xiaogui-mode-recommendation'
import type { XiaoguiMode } from '@shared/xiaogui-prompt-contract'

const MODE_LABEL: Readonly<Record<XiaoguiMode, string>> = {
  WORK: '工作',
  DESIGN: '规划设计',
  CODING: '编程',
}

const MODE_CAPABILITY_HINT: Readonly<Record<XiaoguiMode, string>> = {
  WORK: '切换后可使用文档整理与交付能力。',
  DESIGN: '切换后可使用规划设计与空间分析能力。',
  CODING: '切换后可使用代码检查、修改和测试能力。',
}

export function ModeRecommendationBanner({
  recommendation,
  switching,
  onSwitch,
  onDismiss,
}: {
  readonly recommendation: ModeRecommendationV1
  readonly switching: boolean
  readonly onSwitch: () => void
  readonly onDismiss: () => void
}) {
  const currentLabel = MODE_LABEL[recommendation.currentMode]
  const recommendedLabel = MODE_LABEL[recommendation.recommendedMode]

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2 text-[11px]"
    >
      <span className="min-w-0 flex-1 text-foreground-secondary">
        这项任务更适合「{recommendedLabel}」模式，
        {MODE_CAPABILITY_HINT[recommendation.recommendedMode]}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={switching}
          onClick={onSwitch}
          className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground disabled:opacity-50"
        >
          {switching ? '正在切换…' : '切换并保留输入'}
        </button>
        <button
          type="button"
          disabled={switching}
          onClick={onDismiss}
          className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
        >
          仍在{currentLabel}模式（忽略）
        </button>
      </div>
    </div>
  )
}
