/**
 * Karsa brand mark (Swiss Minimalist Monochrome K).
 *
 * Inline SVG inheriting `currentColor` so it stays crisp on both light and
 * dark themes across sidebar headers, onboarding, and setup screens.
 */
export function TermulMark({
  size = 22,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Karsa"
      className={className}
    >
      <path d="M14 12 H32 V41 L14 59 Z" fill="currentColor" />
      <path d="M32 72 V88 H16 Z" fill="currentColor" />
      <path d="M14 63 L65 12 H88 L14 86 Z" fill="currentColor" fillOpacity="0.72" />
      <path d="M52 52 L88 88 H64 L40 64 Z" fill="currentColor" />
    </svg>
  )
}
