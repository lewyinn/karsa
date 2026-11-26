import { Layers } from '@/components/icons'
import { cn } from '@/lib/utils'

interface CanvasChipProps {
  label: string
  /** Mentioned layer count; more than one is named in the tooltip. */
  count: number
  className?: string
}

/** A canvas mention: layers on the project's Karsa Canvas. */
export function CanvasChip({ label, count, className }: CanvasChipProps): React.JSX.Element {
  const title = count > 1 ? `${label} (${count} canvas layers)` : `${label} (canvas layer)`
  return (
    <span
      className={cn(
        'inline-flex h-[1.3em] max-w-full items-center gap-1 rounded-md border border-primary/35 bg-primary/10 px-1 align-baseline leading-none',
        'text-inherit font-medium text-primary',
        className
      )}
    >
      <Layers size={12} className="shrink-0" aria-hidden="true" />
      <span className="max-w-[40ch] truncate" title={title}>
        {label}
      </span>
    </span>
  )
}
