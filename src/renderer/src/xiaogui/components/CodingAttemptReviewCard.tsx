import { useCodingAttemptStore } from '../stores/coding-attempt-store'

const VERIFICATION_TEXT = {
  PASSED: '通过',
  FAILED: '失败',
  UNKNOWN: '结果未知',
} as const

export function CodingAttemptReviewCard({
  attemptId,
  available,
}: {
  readonly attemptId: string
  readonly available: boolean
}) {
  const review = useCodingAttemptStore((state) => state.reviewsByAttempt[attemptId])
  const error = useCodingAttemptStore((state) => state.reviewErrorsByAttempt[attemptId])
  const loading = useCodingAttemptStore((state) => state.loadingReviewAttemptIds.includes(attemptId))
  const loadReview = useCodingAttemptStore((state) => state.loadReview)

  if (!available) return null

  if (!review) {
    return (
      <section className="mt-2 rounded-md border border-border/40 p-2 text-[11px]" aria-label="修改与验证">
        <div className="font-medium text-foreground">修改与验证</div>
        {error && (
          <div className="mt-1 text-destructive">暂时无法读取真实修改与验证，请稍后重试。</div>
        )}
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadReview(attemptId)}
          className="mt-2 rounded border border-border/60 px-2 py-1 text-foreground-secondary disabled:opacity-40"
        >
          {loading ? '读取中…' : error ? '重试读取审阅' : '查看真实修改'}
        </button>
      </section>
    )
  }

  return (
    <section className="mt-2 rounded-md border border-border/40 p-2 text-[11px]" aria-label="修改与验证">
      <div className="font-medium text-foreground">修改与验证</div>

      <div className="mt-2 text-[10px] text-muted-foreground">变更文件</div>
      {review.bundle.changedRelativePaths.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {review.bundle.changedRelativePaths.map((relativePath) => (
            <li key={relativePath} className="break-all font-mono text-[10px] text-foreground-secondary">{relativePath}</li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-[10px] text-muted-foreground">没有文件变更</div>
      )}

      <div className="mt-2 text-[10px] text-muted-foreground">验证结果</div>
      {review.bundle.verifications.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-1">
          {review.bundle.verifications.map((verification, index) => (
            <li key={`${verification.label}-${index}`} className="flex items-start justify-between gap-2">
              <span className="text-foreground-secondary">{verification.label}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {VERIFICATION_TEXT[verification.status]}
                {verification.exitCode !== null ? ` · 退出码 ${verification.exitCode}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-[10px] text-muted-foreground">暂无验证证据</div>
      )}

      {review.bundle.unresolvedIssues.length > 0 && (
        <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <div className="font-medium">未解决问题</div>
          <ul className="mt-1 list-disc pl-4">
            {review.bundle.unresolvedIssues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      )}

      {review.unifiedDiff && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] text-foreground-secondary">查看 Diff</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre rounded bg-muted p-2 font-mono text-[10px] text-foreground-secondary">
            {review.unifiedDiff}
          </pre>
        </details>
      )}
    </section>
  )
}
