/**
 * Read the project's Karsa Canvas for composer mentions: what the @ menu
 * lists (the current selection and the current page's top-level layers), and
 * the layer summaries a send carries for each canvas pill.
 *
 * Everything goes through the mounted editor's bridge
 * (`useCanvasStore.callCanvas`), so the desktop app, the shared-live remote
 * and the browser client behave the same: no canvas open, no canvas mention.
 * Node ids are u64: results are parsed with long integers kept as text, and
 * ids are written into params as raw digits, never through a JS number.
 */
import type { ContentBlock } from '@/lib/acp-api'
import { asJsonText } from '@/lib/canvas-bridge'
import {
  type CanvasGap,
  type CanvasRef,
  canvasEnvelope,
  canvasLabelText,
  canvasRefKey,
  normalizeCanvasIds
} from '@/lib/composer/canvas-tokens'
import { logFrontendError } from '@/lib/log-api'
import { useCanvasStore } from '@/stores/canvas-store'

/** One layer the @ menu can offer. */
export interface CanvasLayerMatch {
  id: string
  name: string
  type: string
  width: number | null
  height: number | null
}

export interface CanvasMentionTargets {
  pageName: string | null
  /** The selection at the time of the read; empty when nothing is selected. */
  selection: CanvasLayerMatch[]
  /** The current page's top-level layers. */
  layers: CanvasLayerMatch[]
}

export interface CanvasContexts {
  blocks: ContentBlock[]
  gaps: ReadonlyMap<string, CanvasGap>
}

/** Total layer-summary characters one send carries across all canvas pills. */
export const CANVAS_CONTEXT_CHARS = 12_000
/** Selected layers whose names are looked up for the menu row. */
const MAX_SELECTION_LOOKUPS = 20
/** Layers summarised per pill (a large selection names the rest only by id). */
const MAX_LAYERS_PER_REF = 12
/** Children listed under one layer before a `… N more` line. */
const MAX_CHILDREN_LISTED = 20
/** Child levels under each mentioned layer. */
const SUMMARY_DEPTH = 2
const MAX_TEXT_PREVIEW = 80

const MENU_FIELDS = ['name', 'type', 'width', 'height']
const SUMMARY_FIELDS = [
  'name',
  'type',
  'width',
  'height',
  'absoluteBounds',
  'characters',
  'mainComponentName',
  'visible'
]

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

const LONG_INT_RE = /"(?:[^"\\]|\\.)*"|-?\d{16,}(?![\d.eE])/g

/** `JSON.parse` that keeps integers of 16+ digits (u64 node ids) as strings. */
export function parseCanvasJson(text: string): Json {
  return JSON.parse(text.replace(LONG_INT_RE, (m) => (m.startsWith('"') ? m : `"${m}"`))) as Json
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function idOf(value: Json | undefined): string | null {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function numberOf(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOf(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function toLayer(node: Json | undefined): CanvasLayerMatch | null {
  if (!isObject(node)) return null
  const id = idOf(node.id)
  if (id === null) return null
  return {
    id,
    name: stringOf(node.name) ?? '',
    type: stringOf(node.type) ?? 'LAYER',
    width: numberOf(node.width),
    height: numberOf(node.height)
  }
}

async function call(projectId: string, method: string, params: string): Promise<Json> {
  const reply = await useCanvasStore.getState().callCanvas(projectId, method, asJsonText(params))
  if (!reply.ok) throw new CanvasCallError(reply.error.code, reply.error.message)
  return parseCanvasJson(reply.result)
}

class CanvasCallError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

function nodeParams(id: string, depth: number, fields: string[]): string {
  // `id` is validated digits, so it is written as a raw JSON number.
  return `{"id":${id},"depth":${depth},"fields":${JSON.stringify(fields)}}`
}

/** True when the project's canvas is mounted and ready for bridge calls. */
export function isCanvasReady(projectId: string | null | undefined): boolean {
  if (!projectId) return false
  return useCanvasStore.getState().sessions[projectId]?.phase.kind === 'ready'
}

/**
 * The @ menu's canvas panel: the selection and the current page's
 * top-level layers. Rejects when the canvas is closed or the read fails.
 */
export async function readCanvasMentionTargets(projectId: string): Promise<CanvasMentionTargets> {
  const document = await call(
    projectId,
    'document.inspect',
    JSON.stringify({ depth: 1, fields: MENU_FIELDS })
  )
  if (!isObject(document)) throw new Error('document.inspect returned no document')
  const pages = Array.isArray(document.pages) ? document.pages : []
  const currentId = idOf(document.currentPage)
  const page = pages.find((p) => isObject(p) && idOf(p.id) === currentId) ?? pages[0]
  const children = isObject(page) && Array.isArray(page.children) ? page.children : []
  const layers = children.map(toLayer).filter((l): l is CanvasLayerMatch => l !== null)
  const selectedIds = normalizeCanvasIds(
    (Array.isArray(document.selection) ? document.selection : [])
      .map(idOf)
      .filter((id): id is string => id !== null)
  )
  const byId = new Map(layers.map((l) => [l.id, l]))
  const selection = await Promise.all(
    selectedIds.map(async (id, i): Promise<CanvasLayerMatch> => {
      const known = byId.get(id)
      if (known || i >= MAX_SELECTION_LOOKUPS) {
        return known ?? { id, name: '', type: 'LAYER', width: null, height: null }
      }
      const node = await call(projectId, 'node.get', nodeParams(id, 0, MENU_FIELDS)).catch(
        () => null
      )
      return toLayer(node) ?? { id, name: '', type: 'LAYER', width: null, height: null }
    })
  )
  return {
    pageName: isObject(page) ? stringOf(page.name) : null,
    selection,
    layers
  }
}

/** The pill label for a selection: the layer's name, or a count with the first name. */
export function selectionLabel(selection: readonly CanvasLayerMatch[]): string {
  const first = selection[0]
  if (!first) return 'Canvas selection'
  const name = canvasLabelText(first.name) || first.type.toLowerCase()
  if (selection.length === 1) return name
  return `${name} +${selection.length - 1}`
}

export function layerSize(layer: Pick<CanvasLayerMatch, 'width' | 'height'>): string | null {
  if (layer.width === null || layer.height === null) return null
  return `${Math.round(layer.width)}×${Math.round(layer.height)}`
}

// ----- Send-time summaries ---------------------------------------------------

function textPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > MAX_TEXT_PREVIEW
    ? `${chars.slice(0, MAX_TEXT_PREVIEW - 1).join('')}…`
    : flat
}

function nodeLine(node: JsonObject, id: string): string {
  const parts = [
    `${stringOf(node.type) ?? 'LAYER'} ${JSON.stringify(stringOf(node.name) ?? '')} (id ${id})`
  ]
  const size = layerSize({ width: numberOf(node.width), height: numberOf(node.height) })
  const bounds = isObject(node.absoluteBounds) ? node.absoluteBounds : null
  const x = numberOf(bounds?.x)
  const y = numberOf(bounds?.y)
  if (size)
    parts.push(x !== null && y !== null ? `${size} at ${Math.round(x)},${Math.round(y)}` : size)
  const component = stringOf(node.mainComponentName)
  if (component) parts.push(`instance of ${JSON.stringify(component)}`)
  const characters = stringOf(node.characters)
  if (characters) parts.push(`text ${JSON.stringify(textPreview(characters))}`)
  if (node.visible === false) parts.push('hidden')
  const childCount = numberOf(node.childCount)
  if (childCount !== null && childCount > 0 && !Array.isArray(node.children)) {
    parts.push(`${childCount} children`)
  }
  return parts.join(' · ')
}

function outline(node: Json, depth: number, lines: string[]): void {
  if (!isObject(node)) return
  const id = idOf(node.id) ?? '?'
  lines.push(`${'  '.repeat(depth)}- ${nodeLine(node, id)}`)
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children.slice(0, MAX_CHILDREN_LISTED)) outline(child, depth + 1, lines)
  const total = Math.max(children.length, numberOf(node.childCount) ?? 0)
  if (children.length > 0 && total > MAX_CHILDREN_LISTED) {
    lines.push(`${'  '.repeat(depth + 1)}- … ${total - MAX_CHILDREN_LISTED} more`)
  }
}

async function summarise(projectId: string, ref: CanvasRef): Promise<string | null> {
  const lines: string[] = []
  let found = 0
  for (const id of ref.ids.slice(0, MAX_LAYERS_PER_REF)) {
    const node = await call(
      projectId,
      'node.get',
      nodeParams(id, SUMMARY_DEPTH, SUMMARY_FIELDS)
    ).catch((err: unknown) => {
      if (err instanceof CanvasCallError && err.code === 'CANVAS_CLOSED') throw err
      return null
    })
    if (!isObject(node)) {
      lines.push(`- id ${id}: not found (deleted or on another document)`)
      continue
    }
    found += 1
    outline(node, 0, lines)
  }
  const rest = ref.ids.length - MAX_LAYERS_PER_REF
  if (rest > 0) {
    lines.push(`- … ${rest} more selected: ${ref.ids.slice(MAX_LAYERS_PER_REF).join(', ')}`)
  }
  return found > 0 ? lines.join('\n') : null
}

/**
 * One envelope block per mentioned ref, read from the project's canvas now.
 * A ref that cannot be read gets a gap instead, which its inline label names.
 */
export async function resolveCanvasContexts(
  projectId: string | null | undefined,
  refs: readonly CanvasRef[]
): Promise<CanvasContexts> {
  const blocks: ContentBlock[] = []
  const gaps = new Map<string, CanvasGap>()
  if (refs.length === 0) return { blocks, gaps }
  if (!projectId || !isCanvasReady(projectId)) {
    for (const ref of refs) gaps.set(canvasRefKey(ref), 'closed')
    void logFrontendError({
      level: 'info',
      source: 'canvasMention',
      message: `${refs.length} canvas mention(s) sent while the canvas is not open`
    })
    return { blocks, gaps }
  }
  let chars = 0
  for (const ref of refs) {
    const key = canvasRefKey(ref)
    if (chars >= CANVAS_CONTEXT_CHARS) {
      gaps.set(key, 'omitted')
      continue
    }
    let body: string | null
    try {
      body = await summarise(projectId, ref)
    } catch (err) {
      gaps.set(key, 'closed')
      void logFrontendError({
        level: 'warn',
        source: 'canvasMention',
        message: `canvas mention read failed: ${err instanceof Error ? err.message : String(err)}`
      })
      continue
    }
    if (body === null) {
      gaps.set(key, 'missing')
      continue
    }
    const text = canvasEnvelope(ref, body)
    if (chars + text.length > CANVAS_CONTEXT_CHARS) {
      gaps.set(key, 'omitted')
      continue
    }
    chars += text.length
    blocks.push({ type: 'text', text })
  }
  if (gaps.size > 0) {
    void logFrontendError({
      level: 'info',
      source: 'canvasMention',
      message: `canvas mentions: ${blocks.length} resolved, ${gaps.size} without details (${[...new Set(gaps.values())].join(', ')})`
    })
  }
  return { blocks, gaps }
}
