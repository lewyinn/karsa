import type { AntigravityUsageWindow } from '@shared/types/antigravity-accounts.types'
import { UsageBar } from '@/components/settings/provider/account-status'
import {
  antigravityBarWindow,
  antigravityWindowLabel,
  formatUsageReset,
  usageTone
} from '@/lib/antigravity-usage-format'
import { cn } from '@/lib/utils'
import { PERCENT_TEXT } from './account-status'

function valueText(window: AntigravityUsageWindow): string {
  const reset = formatUsageReset(window.resetsAt)
  return reset
    ? `${Math.round(window.percent)}% used, ${reset}`
    : `${Math.round(window.percent)}% used`
}

/** One bar per model quota of an Antigravity Account, most used first. */
export function AntigravityUsageMeters({
  windows
}: {
  windows: readonly AntigravityUsageWindow[]
}): React.JSX.Element | null {
  if (windows.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {windows.map((window) => {
        const label = antigravityWindowLabel(window)
        const reset = formatUsageReset(window.resetsAt)
        const tone = usageTone(window.percent)
        return (
          <div key={window.modelId} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5 text-2xs">
              <span
                className={cn(
                  'min-w-0 truncate font-medium',
                  tone === 'critical' ? 'text-destructive' : 'text-secondary-foreground'
                )}
              >
                {tone === 'critical' ? `${label} limit reached` : label}
              </span>
              <span
                className={cn('ml-auto shrink-0 font-semibold tabular-nums', PERCENT_TEXT[tone])}
              >
                {Math.round(window.percent)}% used
              </span>
              {reset && <span className="shrink-0 text-muted-foreground">{reset}</span>}
            </div>
            <UsageBar
              window={antigravityBarWindow(window)}
              label={`${label} usage`}
              valueText={valueText(window)}
            />
          </div>
        )
      })}
    </div>
  )
}
