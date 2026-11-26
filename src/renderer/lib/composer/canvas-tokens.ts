/**
 * Canvas mention pills: layers on the project's Karsa Canvas that the user
 * mentioned from the composer's @ menu.
 *
 * ## Display-string token
 *
 * `<label>\u001F<id>[,<id>…]`. The ids are figcraft node ids
 * (u64), kept as decimal text because a JS number would round them. The
 * label is what the pill shows: a layer name, or a summary of a multi-layer
 * selection. The token never carries the project: a send resolves the ids in
 * the chat's own project.
 *
 * ## Wire
 *
 * Each pill becomes `(canvas: <label> [troupe-canvas:<ids>])` where the user
 * placed it, so the agent sees the ids it can pass to the canvas tools, and a
 * restored chat can rebuild the pill from the label. The layer details ride
 * in a separate `<troupe-canvas>` envelope block (see `canvas-mention.ts`).
 */

export const CANVAS_TOKEN_START = ''
export const CANVAS_TOKEN_END = ''
export const CANVAS_TOKEN_SEP = '\u001F'

/** Longest pill label; a longer layer name is cut with an ellipsis. */
export const MAX_CANVAS_LABEL_CHARS = 60

export interface CanvasRef {
  label: string
  /** Node ids as decimal text, in pick order, without duplicates. */
  ids: string[]
}

export type CanvasSegment = { kind: 'text'; text: string } | { kind: 'canvas'; ref: CanvasRef }

const ID_RE = /^\d{1,20}$/
// Sentinels, the unit separator and brackets (they would end the wire label).
const CONTROL_RE = new RegExp(`[\\uE000-\\uE00F${CANVAS_TOKEN_SEP}[\\]]`, 'g')

/** A pill-safe one-line label: no sentinels, brackets or line breaks, capped. */
export function canvasLabelText(label: string): string {
  const flat = label.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > MAX_CANVAS_LABEL_CHARS
    ? `${chars.slice(0, MAX_CANVAS_LABEL_CHARS - 1).join('')}…`
    : flat
}

/** Valid ids only, deduplicated, in order. */
export function normalizeCanvasIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => ID_RE.test(id)))]
}

/** Stable key for one ref: its ids. Two pills naming the same layers are one mention. */
export function canvasRefKey(ref: CanvasRef): string {
  return ref.ids.join(',')
}

export function canvasToken(ref: CanvasRef): string {
  const label = canvasLabelText(ref.label) || 'Canvas layer'
  return `${CANVAS_TOKEN_START}${label}${CANVAS_TOKEN_SEP}${normalizeCanvasIds(ref.ids).join(',')}${CANVAS_TOKEN_END}`
}

function decode(inner: string): CanvasRef | null {
  const sep = inner.lastIndexOf(CANVAS_TOKEN_SEP)
  if (sep <= 0) return null
  const label = inner.slice(0, sep)
  const rawIds = inner.slice(sep + 1).split(',')
  const ids = normalizeCanvasIds(rawIds)
  if (ids.length === 0 || ids.length !== rawIds.length) return null
  return { label, ids }
}

/** Split a display string into text runs and canvas pills. Malformed tokens stay text. */
export function parseCanvasSegments(value: string): CanvasSegment[] {
  if (!value.includes(CANVAS_TOKEN_START))
    return value.length > 0 ? [{ kind: 'text', text: value }] : []
  const segments: CanvasSegment[] = []
  let text = ''
  let i = 0
  while (i < value.length) {
    const start = value.indexOf(CANVAS_TOKEN_START, i)
    if (start === -1) break
    const end = value.indexOf(CANVAS_TOKEN_END, start + 1)
    if (end === -1) break
    text += value.slice(i, start)
    const ref = decode(value.slice(start + 1, end))
    if (ref === null) {
      text += value.slice(start, end + 1)
    } else {
      if (text.length > 0) segments.push({ kind: 'text', text })
      text = ''
      segments.push({ kind: 'canvas', ref })
    }
    i = end + 1
  }
  text += value.slice(i)
  if (text.length > 0) segments.push({ kind: 'text', text })
  return segments
}

export function hasCanvasTokens(value: string): boolean {
  return (
    value.includes(CANVAS_TOKEN_START) &&
    parseCanvasSegments(value).some((segment) => segment.kind === 'canvas')
  )
}

/** Unique refs in pill order. */
export function extractCanvasRefs(value: string): CanvasRef[] {
  const seen = new Set<string>()
  const refs: CanvasRef[] = []
  for (const segment of parseCanvasSegments(value)) {
    if (segment.kind !== 'canvas') continue
    const key = canvasRefKey(segment.ref)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(segment.ref)
  }
  return refs
}

/** Splice a pill in place of the `deleteBefore` chars before `caret`, plus a trailing space. */
export function insertCanvasToken(
  value: string,
  caret: number,
  ref: CanvasRef,
  deleteBefore = 0
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(caret - deleteBefore, value.length))
  const end = Math.max(start, Math.min(caret, value.length))
  const before = value.slice(0, start)
  const token = canvasToken(ref)
  return { value: `${before}${token} ${value.slice(end)}`, caret: before.length + token.length + 1 }
}

export function replaceCanvasTokensInline(
  value: string,
  label: (ref: CanvasRef) => string = (ref) => ref.label
): string {
  if (!value.includes(CANVAS_TOKEN_START)) return value
  return parseCanvasSegments(value)
    .map((segment) => (segment.kind === 'canvas' ? label(segment.ref) : segment.text))
    .join('')
}

const CANVAS_GAP_NOTES = {
  closed: ', details unavailable: the canvas is not open',
  missing: ', details unavailable: layer not found',
  omitted: ', details omitted: context limit'
} as const

/** Why a mentioned layer's details are not in the send. */
export type CanvasGap = keyof typeof CANVAS_GAP_NOTES

export function canvasWireLabel(ref: CanvasRef, gap: CanvasGap | null): string {
  const note = gap ? CANVAS_GAP_NOTES[gap] : ''
  return `(canvas: ${ref.label}${note} [troupe-canvas:${canvasRefKey(ref)}])`
}

// The tempered label stops a typed `(canvas: ` earlier on the line from
// swallowing a real label; the id suffix ties it to layers, never typed text.
const LABEL_RE =
  /\(canvas: ((?:(?!\(canvas: )[^\n])+?)(, details (?:unavailable: the canvas is not open|unavailable: layer not found|omitted: context limit))? \[troupe-canvas:(\d{1,20}(?:,\d{1,20})*)\]\)/g

/** The inverse of {@link canvasWireLabel} for a restored chat: each label becomes its pill. */
export function restoreCanvasLabels(text: string): string {
  if (!text.includes('[troupe-canvas:')) return text
  return text.replace(LABEL_RE, (label, name: string, _note, ids: string) => {
    const ref = { label: name, ids: ids.split(',') }
    return decode(`${name}${CANVAS_TOKEN_SEP}${ids}`) ? canvasToken(ref) : label
  })
}

// ----- Context envelope ------------------------------------------------------

const CLOSE_TAG = '</troupe-canvas>'
const OPEN_RE = /^<troupe-canvas ids="(\d{1,20}(?:,\d{1,20})*)" label="[^"]*">\n/
const ESCAPES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }
const escapeAttr = (value: string): string => value.replace(/[&"<>]/g, (c) => ESCAPES[c] ?? c)

const ENVELOPE_INTRO =
  'Layers the user mentioned on the Karsa Canvas, read when the message was sent. ' +
  'The ids work with the canvas tools: get_node for every property, select, screenshot and export.'

export function canvasEnvelope(ref: CanvasRef, body: string): string {
  const safeBody = body.replaceAll(CLOSE_TAG, '<\\/troupe-canvas>')
  return `<troupe-canvas ids="${canvasRefKey(ref)}" label="${escapeAttr(ref.label)}">\n${ENVELOPE_INTRO}\n${safeBody}\n${CLOSE_TAG}`
}

/** True for a wire block that is a canvas envelope (dropped when restoring a chat's display). */
export function isCanvasEnvelope(text: string): boolean {
  return OPEN_RE.test(text) && text.endsWith(`\n${CLOSE_TAG}`)
}
