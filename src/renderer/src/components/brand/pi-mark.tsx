import { memo } from 'react'
import { cn } from '@renderer/lib/utils'

/** 与 resources/icon.svg 一致：朱砂底 + 白色“规”。保留导出名以兼容既有引用。 */
function PiMarkImpl({ className, size = 16 }: { className?: string; size?: number; inverted?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <rect width="1024" height="1024" rx="256" ry="256" fill="#c0392b" />
      <text
        x="512"
        y="715"
        textAnchor="middle"
        fill="#ffffff"
        style={{
          fontFamily: "'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
          fontSize: 620,
          fontWeight: 700,
        }}
      >
        规
      </text>
    </svg>
  )
}

export const PiMark = memo(PiMarkImpl)
