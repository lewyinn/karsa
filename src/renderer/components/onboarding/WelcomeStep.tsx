import { TermulMark } from '@/components/TermulMark'
import { Button } from '@/components/ui/button'
import { SEGMENTED_TRACK_CLASS, segmentClass } from '@/components/ui/panel-styles'
import { useUpdateAppSetting } from '@/hooks/use-app-settings'
import { cn } from '@/lib/utils'
import { useAppearanceMode } from '@/stores/app-settings-store'
import { ONBOARDING_TITLE_CLASS, TOUCH_TARGET_CLASS, useStepTitleFocus } from './OnboardingFrame'

const OUTLINE = [
  'Check the agents on this computer',
  'Pick a project folder',
  'Send your first message'
] as const

const APPEARANCES = [
  { mode: 'dark', label: 'Dark' },
  { mode: 'light', label: 'Light' }
] as const

function AppearanceTrack(): React.JSX.Element {
  const appearance = useAppearanceMode()
  const update = useUpdateAppSetting<'appearanceMode'>()
  return (
    <div
      className={cn(SEGMENTED_TRACK_CLASS, 'h-8 pointer-coarse:h-12')}
      role="radiogroup"
      aria-label="Appearance"
    >
      {APPEARANCES.map(({ mode, label }) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={appearance === mode}
          onClick={() => void update('appearanceMode', mode)}
          className={cn(segmentClass(appearance === mode), 'h-7 px-3 pointer-coarse:h-11')}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function WelcomeStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  const titleRef = useStepTitleFocus()
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-[420px] flex-col items-center gap-8 text-center">
        <div className="flex flex-col items-center gap-5">
          <TermulMark size={56} className="text-secondary-foreground" />
          <div className="flex flex-col gap-2">
            <h1 ref={titleRef} tabIndex={-1} className={ONBOARDING_TITLE_CLASS}>
              Welcome to Karsa
            </h1>
            <p className="text-sm text-muted-foreground">
              Run Claude Code, Codex and other coding agents side by side, in your own projects.
              Setup takes about a minute.
            </p>
          </div>
        </div>
        <ol className="flex w-full flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card text-left">
          {OUTLINE.map((item, i) => (
            <li
              key={item}
              className="flex min-h-10 items-center gap-3 px-3 py-2 text-xs text-foreground"
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-3xs tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              {item}
            </li>
          ))}
        </ol>
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Appearance</span>
            <AppearanceTrack />
          </div>
          <Button size="sm" className={TOUCH_TARGET_CLASS} onClick={onNext}>
            Get started
          </Button>
        </div>
      </div>
    </div>
  )
}
