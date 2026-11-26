/**
 * Width the native macOS traffic lights need from the window edge: they sit
 * at x = 22 and end at x = 74, then a 4px gap to the Karsa mark's 28px box
 * (Paper S2.0). x = 22 mirrors the Rail toggle on the right, whose glyph ends
 * 23px from the Rail edge.
 *
 * Vertically the lights are centred on the 44px top row (y = 22), the line
 * of the Karsa mark and the Rail toggle. `trafficLightPosition.y` in
 * `tauri.conf.json` / `tauri.macos.conf.json` is 24 for that: tao makes
 * it the title bar height minus the button height, not the button top, so
 * the value was tuned by eye on macOS 26, not derived.
 *
 * Only the expanded Rail header makes this room (`TrafficLightClearance`).
 * The lights hide while the Rail is collapsed (`ShellRail`), so the main
 * area never steps aside for them.
 */
export const TRAFFIC_LIGHT_CLEARANCE_PX = 78
