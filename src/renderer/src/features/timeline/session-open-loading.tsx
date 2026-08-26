import { useId } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Cold open / first session visual only.
 * Session loading state, aria status and lifecycle remain owned by timeline.tsx.
 */
export function SessionOpenLoadingView() {
  const { t } = useTranslation()
  const maskId = `xiaogui-loader-cut-${useId().replaceAll(':', '')}`

  return (
    <div
      className="xiaogui-session-loading flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-8"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="chat-content-column flex w-full flex-col items-center gap-[22px]">
        <div className="xiaogui-loader-card" aria-hidden="true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 420 220"
            className="xiaogui-loader"
            focusable="false"
          >
            <g className="xiaogui-loader__small">
              <path
                d="M0 700L110 215H315L210 700ZM380 0H620V735Q620 1000 365 1000H200V805H380ZM685 215H890L1000 700H790Z"
                transform="translate(20 20) scale(0.18)"
              />
            </g>
            <g className="xiaogui-loader__gui">
              <mask id={maskId} x="0" y="0" width="420" height="220" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
                <rect width="420" height="220" fill="#fff" />
                <path
                  d="M344 37C344 84 340 119 312 143C291 161 274 178 259 199"
                  fill="none"
                  stroke="#000"
                  strokeWidth="13"
                  strokeLinecap="round"
                />
                <path d="M247 56h14M247 66h11M247 76h9M247 86h7" stroke="#000" strokeWidth="2.4" />
                <path d="M257 126l-18 49" stroke="#000" strokeWidth="2.1" strokeDasharray="1 6" strokeLinecap="round" />
              </mask>
              <g mask={`url(#${maskId})`}>
                <path
                  d="M50 708H420V575H50ZM31 476H432V339H31ZM171 845H308V530Q308 458 301.5 377Q295 296 276 213Q257 130 220 53.5Q183-23 122-85Q112-71 94-52Q76-33 56-15Q36 3 18 14Q72 64 102.5 129.5Q133 195 148 266Q163 337 167 405Q171 473 171 530ZM291 348Q302 339 319.5 320Q337 301 357.5 277.5Q378 254 398.5 230.5Q419 207 435 188.5Q451 170 458 161L360 57Q345 82 325 112Q305 142 283 173Q261 204 240 232Q219 260 202 281ZM457 812H945V279H800V688H595V279H457ZM655 310H782V70Q782 51 788 44Q794 37 806 37H839Q850 37 856 48.5Q862 60 865 91Q868 122 869 178Q892 161 924 147Q956 133 980 128Q975 52 962.5 8.5Q950-35 922-53.5Q894-72 840-72H778Q712-72 683.5-46Q655-20 655 53ZM631 639H765V498Q765 430 752 350Q739 270 704.5 189Q670 108 605.5 35Q541-38 438-93Q430-79 413.5-59Q397-39 379-19.5Q361 0 347 10Q444 60 501 121.5Q558 183 586 248.5Q614 314 622.5 379Q631 444 631 501Z"
                  transform="translate(216.63 182.15) scale(.18711 -.1919)"
                />
              </g>
            </g>
            <g className="xiaogui-loader__node">
              <circle cx="344" cy="87" r="7" />
              <path d="M344 74v26M331 87h26" />
              <circle cx="344" cy="87" r="5.6" />
            </g>
            <path
              className="xiaogui-loader__path"
              d="M344 37C344 84 340 119 312 143C291 161 274 178 259 199"
              fill="none"
              strokeWidth="13"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <p className="xiaogui-loader-caption text-[13px] text-foreground-secondary">
          {t('timeline:loadingSession')}
        </p>
      </div>
    </div>
  )
}
