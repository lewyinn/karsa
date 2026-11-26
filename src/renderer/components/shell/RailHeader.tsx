import { RailToggleButton } from '@/components/shell/RailToggleButton'
import { ShellBrandMark } from '@/components/shell/ShellBrandMark'
import { TrafficLightClearance } from '@/components/shell/TopRowChrome'
import { useTopRowPlatform } from '@/components/shell/top-row-context'
import { cn } from '@/lib/utils'
import { useRailCollapsed } from './rail/rail-density'
import { RAIL_LABEL_FADE_CLASS, RAIL_TRAVEL_CLASS } from './rail/rail-motion'
import { TRAFFIC_LIGHT_CLEARANCE_PX } from './traffic-light-inset'

/** Width of the Karsa mark (`ShellBrandMark`, `size-7`). */
const MARK_PX = 28

/**
 * macOS: how far the mark travels between its expanded x (after the
 * traffic-light clearance) and its collapsed x (centred on x = 28).
 */
const MAC_MARK_TRAVEL_PX = 28 - MARK_PX / 2 - TRAFFIC_LIGHT_CLEARANCE_PX

/**
 * Top row part of the Rail (Paper "Rail header"), 44px tall, in line with the
 * tab bar and the right panel header. Left to right:
 * - macOS: the traffic-light clearance, then the Karsa mark.
 * - Elsewhere: a 56px slot that centers the mark on the Rail icon column
 *   (x = 28), the x of every row icon below it.
 * Then drag space, then the 28px Rail toggle at the end, its glyph on the
 * right edge of the row actions below (24px from the Rail edge). On desktop
 * every part except the toggle is a window drag handle.
 *
 * Collapsed Rail: only the mark, centred on the icon column (x = 28), since
 * the macOS lights hide while collapsed; the expand toggle moves to the start
 * of the main area's top row (`TopRowStartSlot`).
 *
 * The mark is one element in both densities (same position in the tree), so
 * it never remounts or fades on a toggle. Elsewhere it does not move at all;
 * on macOS it travels between the two x values with the width.
 */
export function RailHeader(): React.JSX.Element {
  const platform = useTopRowPlatform()
  const collapsed = useRailCollapsed()
  const drag = platform.dragRegions ? true : undefined
  const lights = platform.trafficLights
  return (
    <div
      className={cn('flex h-11 shrink-0 items-center', collapsed && 'w-14')}
      data-testid="rail-header"
      data-tauri-drag-region={drag}
    >
      {!collapsed && lights && <TrafficLightClearance trafficLights />}
      <div
        className={cn(
          'flex shrink-0 items-center justify-center self-stretch',
          lights && !collapsed ? RAIL_TRAVEL_CLASS : 'w-14'
        )}
        style={
          lights && !collapsed
            ? ({ '--rail-travel-x': `${MAC_MARK_TRAVEL_PX}px` } as React.CSSProperties)
            : undefined
        }
        data-testid="rail-header-mark-slot"
        data-tauri-drag-region={drag}
      >
        <ShellBrandMark dragRegion={platform.dragRegions} />
      </div>
      {!collapsed && <div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region={drag} />}
      {/* Right-aligned: the 28px button's centre sits on x 218 of the 248px
          Rail, the lane of the `+` and status marks in the rows below. It
          fades out before the Rail collapses and fades in when it expands. */}
      {!collapsed && (
        <span className={cn('mr-4 flex shrink-0', RAIL_LABEL_FADE_CLASS)}>
          <RailToggleButton />
        </span>
      )}
    </div>
  )
}
