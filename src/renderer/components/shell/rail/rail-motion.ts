import { useEffect, useState } from 'react'

/**
 * Rail expand/collapse choreography (collapsible-sidebar pattern: CSS
 * `transition-behavior: allow-discrete` + `@starting-style`, no JS animation).
 *
 * - `collapsing`: the width shrinks (200ms) while the rows keep their expanded
 *   layout and every expanded-only part fades out (150ms) before it goes to
 *   `display: none`. Shared parts that sit at a different x in the two
 *   densities (a project's chat rows and icons, the macOS Karsa mark) travel
 *   to their collapsed x with the width ({@link RAIL_TRAVEL_CLASS}), so the
 *   layout switch that follows moves nothing.
 * - `settling`: the rows switch to the collapsed layout; collapsed-only parts
 *   (dividers, status dots, the stacked footer) fade in (120ms).
 * - `expanding`: the rows switch to the expanded layout at once; the shared
 *   parts travel back from their collapsed x and labels and meta fade in from
 *   `@starting-style` while the width grows (200ms).
 * - `idle`: no transition. A resize drag follows the pointer.
 *
 * Every moving part uses the one curve {@link RAIL_EASE} and the one 200ms
 * duration, so the width and the parts riding on it arrive together.
 *
 * `ShellRail` sets the phase as `data-rail-motion` on the `group/rail` nav;
 * the class constants below read it.
 */
export type RailMotionPhase = 'idle' | 'collapsing' | 'settling' | 'expanding'

/** Width transition of the Rail, in ms (open and close). */
export const RAIL_WIDTH_MS = 200
/** Fade-in of the collapsed-only parts once the width has landed, in ms. */
export const RAIL_SETTLE_MS = 120
/** The Rail's one motion curve: a strong ease-out (fast start, soft landing). */
export const RAIL_EASE = 'cubic-bezier(0.23, 1, 0.32, 1)'

const NEXT_PHASE: Record<RailMotionPhase, { next: RailMotionPhase; ms: number } | null> = {
  idle: null,
  collapsing: { next: 'settling', ms: RAIL_WIDTH_MS },
  settling: { next: 'idle', ms: RAIL_SETTLE_MS },
  expanding: { next: 'idle', ms: RAIL_WIDTH_MS }
}

/** Until this time (`performance.now()`), a density change does not animate. */
let skipMotionUntil = 0

/**
 * Makes the next expand/collapse switch at once. Call it from a keyboard
 * shortcut: keyboard actions must feel instant, so only a pointer toggle
 * animates. Idempotent across re-renders (a short window, not a one-shot
 * flag), so a StrictMode double render reads the same answer.
 * A pointer toggle calls {@link allowNextRailMotion} so it does not inherit
 * this window.
 */
export function skipNextRailMotion(): void {
  skipMotionUntil = performance.now() + 400
}

/** A pointer toggle animates, including one that follows a shortcut inside the skip window. */
export function allowNextRailMotion(): void {
  skipMotionUntil = 0
}

function railMotionSkipped(): boolean {
  return performance.now() < skipMotionUntil
}

/**
 * Phase and row density of the Rail for `expanded` (the persisted state).
 * The density stays `expanded` through `collapsing`, so the labels stay in
 * the DOM while they fade out. Under reduced motion the phase is always
 * `idle` and the state changes in one frame. A toggle in the middle of a
 * phase starts the new phase from the current values.
 */
export function useRailMotion(
  expanded: boolean,
  reducedMotion: boolean
): { phase: RailMotionPhase; density: 'expanded' | 'collapsed' } {
  const [state, setState] = useState<{ expanded: boolean; phase: RailMotionPhase }>({
    expanded,
    phase: 'idle'
  })
  let phase = state.phase
  if (state.expanded !== expanded) {
    // Derived state: set during render so the first frame of a toggle
    // already has the new phase (no frame with the old density).
    phase = reducedMotion || railMotionSkipped() ? 'idle' : expanded ? 'expanding' : 'collapsing'
    setState({ expanded, phase })
  }

  useEffect(() => {
    const step = NEXT_PHASE[phase]
    if (!step) return
    const id = window.setTimeout(() => {
      setState((current) => (current.phase === phase ? { ...current, phase: step.next } : current))
    }, step.ms)
    return () => window.clearTimeout(id)
  }, [phase])

  const density = expanded || phase === 'collapsing' ? 'expanded' : 'collapsed'
  return { phase, density }
}

/** Width transition of the Rail nav while it expands or collapses. */
export const RAIL_WIDTH_TRANSITION_CLASS =
  'transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none'

/**
 * A shared part that sits at a different x in the two densities. Set its
 * offset as `--rail-travel-x` (collapsed x minus expanded x, in px). While
 * collapsing it slides there with the width (`rail-travel-out`, held at the
 * end); while expanding it slides back from there (`rail-travel-in`). The
 * phase that follows switches the layout and drops the offset in the same
 * frame, so nothing jumps. Keyframes (in `index.css`), not transitions: the
 * part has no transform at rest.
 */
export const RAIL_TRAVEL_CLASS = [
  'group-data-[rail-motion=collapsing]/rail:animate-[rail-travel-out_200ms_cubic-bezier(0.23,1,0.32,1)_both]',
  'group-data-[rail-motion=expanding]/rail:animate-[rail-travel-in_200ms_cubic-bezier(0.23,1,0.32,1)]',
  'motion-reduce:animate-none'
].join(' ')

/**
 * A project's chat row (its fill is 22px in when expanded, a 30px square at
 * x = 13 when collapsed): it travels 17px left while its clip closes to the
 * 30px square, so a hovered fill or the open chat's keycap becomes the
 * collapsed square on the way (`rail-row-travel-out` / `-in`).
 */
export const RAIL_NESTED_ROW_TRAVEL_CLASS = [
  '[--rail-travel-x:-17px]',
  'group-data-[rail-motion=collapsing]/rail:animate-[rail-row-travel-out_200ms_cubic-bezier(0.23,1,0.32,1)_both]',
  'group-data-[rail-motion=expanding]/rail:animate-[rail-row-travel-in_200ms_cubic-bezier(0.23,1,0.32,1)]',
  'motion-reduce:animate-none'
].join(' ')

/** The icon in a project's chat row: 4px more than its row, so it lands on x = 28. */
export const RAIL_NESTED_ICON_TRAVEL_CLASS = `${RAIL_TRAVEL_CLASS} [--rail-travel-x:-4px]`

/**
 * Expanded-only text inside a row (label, title, trail, meta). It fades out
 * and then goes to `display: none` (the display change waits for the fade);
 * it fades in from `@starting-style` when the Rail expands. The row keeps its
 * fixed height and `nowrap`, so nothing reflows.
 */
export const RAIL_LABEL_FADE_CLASS = [
  'transition-[opacity,display] duration-150 ease-out transition-discrete',
  'group-data-[rail-motion=collapsing]/rail:hidden group-data-[rail-motion=collapsing]/rail:opacity-0',
  'group-data-[rail-motion=expanding]/rail:starting:opacity-0',
  'motion-reduce:transition-none'
].join(' ')

/**
 * A block whose layout differs between the densities (section header or
 * divider, chat list, worktree chip, footer). It keeps its box (no
 * `display: none`, so the rows under it do not jump), fades out while the
 * Rail collapses, and fades in when the other density mounts it.
 */
export const RAIL_BLOCK_FADE_CLASS = [
  'transition-opacity duration-[120ms] ease-out',
  'group-data-[rail-motion=collapsing]/rail:opacity-0',
  'group-data-[rail-motion=expanding]/rail:starting:opacity-0',
  'group-data-[rail-motion=settling]/rail:starting:opacity-0',
  'motion-reduce:transition-none'
].join(' ')

/**
 * A row on the collapsed Rail: a 30px wide fill at x = 13..43 (5px past the
 * list's 8px inset). With the 30px row height it is a square, and the icon
 * sits in its middle on the icon column (x = 28). That is where the expanded
 * row draws the icon, so it does not move on a toggle, and the middle of the
 * 56px collapsed Rail, so the column is symmetric (13px on each side).
 * A row must sit in the list's 8px inset (`px-2`) to land there.
 */
export const RAIL_COLLAPSED_ROW_CLASS = 'ml-[5px] w-7.5 justify-center px-0'
