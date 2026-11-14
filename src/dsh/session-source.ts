// dsh-vcc: session-backed message source — the DSH replacement for pi-vcc's
// load-messages / global-indices / lineage modules.
//
// pi-vcc numbers `type == "message"` entries in session-file order and shares
// that counting rule between the compiler and recall. DSH sessions number
// every event by `seq`, and any durable message projects back to the event
// that produced it (`session.deriveEventMessage`). The global index used by
// vcc_recall and by the `(#N)` refs the compiler emits is therefore the EVENT
// SEQ: stable across compaction, unambiguous, and identical for both sides.
//
//   scope 'lineage' (default) → surface events only (the live conversation
//   path, equivalent to pi's active lineage);
//   scope 'all'               → every event in the log, including shadowed
//   branches replaced by compaction or retries.

import { renderMessage } from '../core/render-entries.ts'
import { toPiMessage } from './adapter.ts'
import type { LoadedMessages } from '../core/load-messages.ts'

export const SURFACE_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
  'system/message',
  'developer/message',
])

/** Events of the live surface, in surface order. */
export function surfaceEvents(session: any): any[] {
  const events: any[] = []
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return events
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event) events.push(event)
  }
  return events
}

/** Raw log events in seq order (surface and shadowed), from a snapshot. */
export function snapshotEvents(session: any): any[] {
  return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
}

/**
 * Collect the messages of one scope as pi-shape raw messages plus rendered
 * entries, indexed by event seq.
 *
 * @param full - render entries with full content (no clipping); the expand
 *   path uses it so `#N` returns untruncated content.
 * @returns `rawMessages[i]` is the pi-shape message whose index is
 *   `rendered[i].index` (the event seq).
 */
export function loadMessages(session: any, scope: 'lineage' | 'all' = 'lineage', full = false): LoadedMessages {
  const events = scope === 'all' ? snapshotEvents(session) : surfaceEvents(session)
  // One map for the whole walk: assistant tool calls register their id here so
  // the following tool result can be named (a fresh map per message loses it).
  const toolNames = new Map<string, string>()
  const rendered: any[] = []
  const rawMessages: any[] = []

  for (const event of events) {
    if (!event || !SURFACE_EVENT_TYPES.has(event.type)) continue
    let msg: any
    try {
      msg = session.deriveEventMessage(event)
    } catch {
      msg = undefined
    }
    if (!msg) continue
    const pi = toPiMessage(msg, toolNames, { includeReasoning: true })
    if (!pi) continue
    const seq = Number(event.seq)
    if (!Number.isInteger(seq)) continue
    rawMessages.push(pi)
    rendered.push(renderMessage(pi, seq, Boolean(full)))
  }

  return { rendered, rawMessages }
}

/** Seq indices present in one scope. */
export function indicesOf(session: any, scope: 'lineage' | 'all'): Set<number> {
  return new Set(loadMessages(session, scope, false).rendered.map((entry: any) => entry.index))
}