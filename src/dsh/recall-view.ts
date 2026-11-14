// dsh-vcc: the RecallView seam over a DSH session.
//
// Upstream pi-vcc opens its view on the session JSONL file and pi's branch
// manager. DSH has neither: the durable log is event-based and the live path
// is `session.surface`. This module supplies the same interface — load(full),
// widen(), currentTurn() — so `runRecall` and the whole search/format layer
// stay upstream code.

import type { RecallScope } from '../core/recall-scope.ts'
import type { RecallView } from '../core/recall-run.ts'
import type { LoadedMessages } from '../core/load-messages.ts'
import { loadMessages, surfaceEvents } from './session-source.ts'
import { isCompileArtifactMessage } from './engine-util.ts'

/** Open a recall view over one session and scope. */
export function openRecallView(session: any, scope: RecallScope): RecallView {
  const cache = new Map<boolean, LoadedMessages>()
  let wide: RecallView | undefined
  let turn: Set<number> | undefined

  const view: RecallView = {
    // DSH has no session file; the id is only used as a label by callers that
    // still expect the field.
    sessionFile: String(session?.id ?? ''),
    scope,
    load(full: boolean): LoadedMessages {
      let loaded = cache.get(full)
      if (!loaded) {
        loaded = loadMessages(session, scope, full)
        cache.set(full, loaded)
      }
      return loaded
    },
    widen(): RecallView {
      if (scope === 'all') return view
      return (wide ??= openRecallView(session, 'all'))
    },
    currentTurn(): Set<number> {
      return (turn ??= findCurrentTurn(session))
    },
  }
  return view
}

/**
 * Walk the live surface back to the last user message. The tool runs from an
 * assistant step, so a turn is in progress only when something follows that
 * user message; a checkpoint in between means the start of the turn may have
 * left the context.
 */
function findCurrentTurn(session: any): Set<number> {
  const none = new Set<number>()
  const events = surfaceEvents(session)

  let startSeq: number | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!event) continue
    if (event.type === 'compaction/summary') return none
    if (event.type !== 'user/message') continue
    let msg: any
    try {
      msg = session.deriveEventMessage(event)
    } catch {
      msg = undefined
    }
    if (!msg) continue
    // A checkpoint replacement is not the turn's user message.
    if (isCompileArtifactMessage(msg)) return none
    startSeq = Number(event.seq)
    break
  }
  if (startSeq === undefined) return none

  const { rendered } = loadMessages(session, 'lineage', false)
  const pos = rendered.findIndex((entry: any) => entry.index === startSeq)
  if (pos < 0) return none
  return pos < rendered.length - 1
    ? new Set(rendered.slice(pos).map((entry: any) => entry.index))
    : none
}