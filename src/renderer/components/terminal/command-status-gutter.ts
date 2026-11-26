import type { IMarker, Terminal } from '@xterm/xterm'
import { logFrontendError } from '@/lib/log-api'

/**
 * Command status gutter: a green/red dot left of each finished command.
 *
 * SIGNALS (both written in-band by Karsa's integrated zsh and bash shells, so
 * ordering against the command output is exact on every surface that renders
 * the PTY stream: desktop, shared-live remote, and the browser client):
 * - `OSC 133;A;termul` marks where a prompt starts. The host prompt spacer may
 *   leave blank rows around it, so the command row is the first non-blank row
 *   at or below the mark.
 * - `OSC 133;D;<exit>;termul` follows a user command and precedes the next
 *   prompt mark. It closes the most recent prompt with that exit code.
 *
 * Empty Enter, Ctrl+C at the prompt, and Karsa's own completion probes emit no
 * `D`, so they get no dot. Plain `133;A`/`133;D` from user prompt frameworks are
 * ignored to avoid double dots.
 *
 * TRUST: the marks are not authenticated; any program output can forge one.
 * The dot is cosmetic only and must not drive behavior.
 *
 * LIMITATIONS (shared with command separators): snapshot restore carries no OSC
 * sequences, so restored scrollback has no dots; marks in the alternate screen
 * are ignored.
 */

const PROMPT_MARK = 'A;termul'
const FINISH_MARK = /^D;(-?\d{1,10});termul$/
/** How far below the prompt mark the command echo may sit (spacer rows). */
const MAX_LEADING_BLANK_ROWS = 2

interface GutterState {
  prompt: IMarker | null
}

const gutterStates = new WeakMap<Terminal, GutterState>()

export type CommandStatus = 'success' | 'failure'

export function commandStatusFromExitCode(exitCode: number): CommandStatus {
  return exitCode === 0 ? 'success' : 'failure'
}

export function commandStatusLabel(exitCode: number): string {
  return exitCode === 0
    ? 'Command succeeded (exit code 0)'
    : `Command failed (exit code ${exitCode})`
}

function isRowBlank(terminal: Terminal, row: number): boolean {
  const line = terminal.buffer.active.getLine(row)
  return !line || line.translateToString(true).trim() === ''
}

/**
 * First non-blank row at or below `markRow`, bounded by the cursor row.
 * `null` when every candidate is blank: the command erased its own echo (an
 * inline TUI such as `fzf --height` erasing from its row down leaves only the
 * blank spacer row), and a dot there would mark an empty row.
 */
function findCommandRow(terminal: Terminal, markRow: number, cursorRow: number): number | null {
  const lastCandidate = Math.min(cursorRow, markRow + MAX_LEADING_BLANK_ROWS)
  for (let row = markRow; row <= lastCandidate; row++) {
    if (!isRowBlank(terminal, row)) return row
  }
  return null
}

function isLive(marker: IMarker | null): marker is IMarker {
  return marker !== null && !marker.isDisposed && marker.line >= 0
}

function decorate(terminal: Terminal, prompt: IMarker, exitCode: number): void {
  const buffer = terminal.buffer.active
  const cursorRow = buffer.baseY + buffer.cursorY
  const commandRow = findCommandRow(terminal, prompt.line, cursorRow)
  if (commandRow === null) return
  const marker = terminal.registerMarker(commandRow - cursorRow)
  if (!marker) return

  const status = commandStatusFromExitCode(exitCode)
  const label = commandStatusLabel(exitCode)
  const decoration = terminal.registerDecoration({ marker, x: 0, width: 1, layer: 'top' })
  if (!decoration) {
    marker.dispose()
    return
  }
  // The decoration owns its own marker; dispose both when the row scrolls out.
  marker.onDispose(() => decoration.dispose())
  decoration.onRender((element) => {
    element.classList.add('termul-command-status', `termul-command-status--${status}`)
    element.setAttribute('role', 'img')
    element.setAttribute('aria-label', label)
    element.title = label
  })
}

/**
 * Attach the command status gutter to a terminal.
 * Idempotent per Terminal instance via a module-level WeakMap.
 */
export function attachCommandStatusGutter(terminal: Terminal): void {
  if (gutterStates.has(terminal)) return
  if (
    typeof terminal.parser?.registerOscHandler !== 'function' ||
    typeof terminal.registerMarker !== 'function' ||
    typeof terminal.registerDecoration !== 'function'
  ) {
    return
  }

  const state: GutterState = { prompt: null }
  gutterStates.set(terminal, state)

  terminal.parser.registerOscHandler(133, (data) => {
    if (terminal.buffer.active.type === 'alternate') return false

    if (data === PROMPT_MARK) {
      state.prompt?.dispose()
      const buffer = terminal.buffer.active
      const wrapOffset = buffer.cursorX >= terminal.cols ? 1 : 0
      state.prompt = terminal.registerMarker(wrapOffset) ?? null
      return false
    }

    const finish = FINISH_MARK.exec(data)
    if (!finish) return false
    const prompt = state.prompt
    state.prompt = null
    if (!isLive(prompt)) return false
    try {
      decorate(terminal, prompt, Number.parseInt(finish[1], 10))
    } catch (error) {
      void logFrontendError({
        level: 'warn',
        message: `Command status dot failed: ${error instanceof Error ? error.message : String(error)}`,
        source: 'command-status-gutter',
        stack: error instanceof Error ? error.stack : undefined
      })
    } finally {
      prompt.dispose()
    }
    return false
  })
}
