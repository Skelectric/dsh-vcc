// dsh-vcc: the compile entry point for DSH messages.
//
// Mirrors the upstream hook's compileRanked call (src/hooks/before-compact.ts):
// the same size-relative brief budget, the same fileOps/trackCommands inputs,
// and the same fail-closed seq alignment for (#N) refs.

import { compileRanked } from '../core/summarize.ts'
import { DEFAULT_CHARS_PER_TOKEN } from '../core/token-estimate.ts'
import { loadSettings } from '../core/settings.ts'
import { toPiMessage } from './adapter.ts'
import { alignSourceIndices, isCompileArtifactMessage, previousSummaryText } from './engine-util.ts'

// Upstream's ranked brief budget: 1100 tokens floor, 2000 ceiling, 15 tokens
// per block, converted to chars through the calibrated chars-per-token.
const RANKED_BRIEF_BUDGET_TOKENS = 1100
const RANKED_BRIEF_CEILING_TOKENS = 2000
const RANKED_BRIEF_TOKENS_PER_BLOCK = 15

/** Messages of the live surface, in surface order. */
export function surfaceMessages(session: any): any[] {
  const messages: any[] = []
  for (const seq of session?.surface?.nodes ?? []) {
    const event = session.eventAt(seq)
    if (!event) continue
    let msg: any
    try {
      msg = session.deriveEventMessage(event)
    } catch {
      msg = undefined
    }
    if (msg) messages.push(msg)
  }
  return messages
}

/**
 * Compile one message region into the deterministic summary.
 *
 * Prior checkpoints and runtime-context snapshots are skipped: they are
 * compaction artifacts, not conversation. The previous summary enters the
 * merge structurally through `previousSummaryText`.
 */
export function compileMessages(session: any, messages: readonly any[]): string {
  const sourceIndices = alignSourceIndices(session, messages)
  // One map for the whole walk: tool calls register their id so the following
  // tool result keeps its tool name.
  const toolNames = new Map<string, string>()
  const pairs: { pi: any; seq: number | undefined }[] = []

  for (let i = 0; i < messages.length; i++) {
    if (isCompileArtifactMessage(messages[i])) continue
    // Harness-injected user messages (time-context, runtime-context,
    // skill-catalog, agent-instructions, approvals) are environment, not
    // conversation: they would otherwise fill [Early Session Requests].
    if (messages[i]?.role === 'user' && messages[i]?.source?.kind !== undefined && messages[i].source.kind !== 'user') continue
    const pi = toPiMessage(messages[i], toolNames, { includeReasoning: false })
    if (pi) pairs.push({ pi, seq: sourceIndices[i] })
  }

  const settings = loadSettings()
  const charsPerToken = DEFAULT_CHARS_PER_TOKEN

  return compileRanked({
    messages: pairs.map((pair) => pair.pi),
    sourceIndices: pairs.map((pair) => pair.seq),
    previousSummary: previousSummaryText(session),
    trackCommands: settings.trackCommands,
    ranking: {
      maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * charsPerToken),
      maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * charsPerToken),
      briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * charsPerToken),
    },
  })
}