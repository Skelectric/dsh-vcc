// dsh-vcc: deterministic, no-LLM conversation compaction for DeepSeek Harness.
//
// The engine subclasses dsh's BasicCompactionEngine and replaces `summarize()`
// with the pi-vcc compile pipeline. It also overrides `compactNow()` to widen
// the manual span. The rest of the backend — threshold and overflow triggers,
// region selection for automatic compaction, the maxTokens shrink gate, retry
// backoff, durable session mutation, and the tool-result pruner — stays dsh's,
// unchanged.
//
// The same row registers the vcc_recall tool and the /vcc commands, so one
// installed plugin provides compaction and recall together.

import { appendFileSync } from 'node:fs'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { ManualCompactionError, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { compactSurfaceRegion, selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import { compileMessages, surfaceMessages } from './dsh/compile.ts'
import { closingMessageSeq } from './dsh/manual-range.ts'
import { registerRecallTool } from './dsh/recall-tool.ts'
import { registerVccCommands } from './dsh/commands.ts'

if (process.env.DSH_VCC_MOUNT_MARKER) {
  try { appendFileSync(process.env.DSH_VCC_MOUNT_MARKER, 'imported\n') } catch { /* diagnostic only */ }
}

const PROVIDER = 'dsh-vcc'
const MODEL = 'deterministic'

/** Deterministic VCC compaction engine. */
export default class DshVccCompactionEngine extends BasicCompactionEngine {
  // The tool and command registries are needed to expose vcc_recall and /vcc
  // from the same row; both are optional so the engine still mounts in a
  // composition without them.
  static inject = [...BasicCompactionEngine.inject, 'tools', 'commands']

  // The engine accepts exactly the basic backend's configuration: thresholds,
  // retention, shrink gate, and retry policy are dsh's policy, not ours.
  static Config = BasicCompactionEngine.Config

  constructor(ctx: any, config: any = {}) {
    super(ctx, config)
    if (ctx.tools) ctx.effect(() => registerRecallTool(ctx), 'dsh-vcc recall tool')
    if (ctx.commands) ctx.effect(() => registerVccCommands(ctx), 'dsh-vcc commands')
    // Mount diagnostic: a preset child that fails to activate is silent at boot
    // (only the roster's `broken` field reports it), so an explicit marker makes
    // a headless smoke test able to assert the engine actually mounted.
    if (process.env.DSH_VCC_MOUNT_MARKER) {
      try { appendFileSync(process.env.DSH_VCC_MOUNT_MARKER, `mounted ${ctx.fiber?.entry?.options?.id ?? '?'}\n`) } catch { /* diagnostic only */ }
    }
  }

  /**
   * The subclass customization hook of BasicCompactionEngine.
   *
   * `input.messages` is the exact contiguous surface run dsh selected for
   * compaction. The summary is produced purely algorithmically — no LLM, no
   * network — while the shrink gate, retries, and region selection the parent
   * already performed stay as they are.
   */
  protected async summarize(input: any, agent: any, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted?.()
    const session = agent?.session
    if (!session) {
      throw new Error('dsh-vcc: no session available for compaction')
    }

    const text = compileMessages(session, input.messages ?? [])
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('dsh-vcc: deterministic compilation produced no summary content')
    }

    // Deterministic result shape: rawOutput mirrors the summary (no stream).
    const summary = [{ type: 'text', text }]
    return {
      summary,
      rawOutput: summary,
      provider: PROVIDER,
      model: MODEL,
      // Informational; the parent's shrink gate re-checks the real size.
      maxTokens: text.length,
    }
  }

  /**
   * pi-vcc fidelity for the manual path.
   *
   * dsh's `compactNow` selects with `retainTokens: 0`, so the span stops at the
   * last user message and the assistant reply is retained verbatim after the
   * checkpoint — the compiled summary never quotes it. pi-vcc's summary does,
   * so this override extends the span through the closing assistant message
   * when it is a complete step boundary, and otherwise defers to dsh's own
   * selection (an open tool step or a trailing user message).
   *
   * The transaction is dsh's: same owner, stability, flush, and error mapping.
   * `regionDependencies()` is private on the parent but present at runtime.
   */
  override compactNow(agent: any, signal: AbortSignal, sourceCommandId?: any): Promise<any> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal: AbortSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const session = agent.session
          const range = selectCompactableRange(session, this.ctx.tokenMeter.measure(session), 0)
          if (range === null) return null
          const closing = closingMessageSeq(session)
          const end = closing !== undefined && toolPairingBalancedAfter(session, closing)
            ? closing
            : range.end
          return await compactSurfaceRegion(
            (this as any).regionDependencies(),
            session,
            range.start,
            end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error })
    }
  }

  /** @internal exposed for /vcc: compile the whole live surface. */
  compileSurface(session: any): string {
    return compileMessages(session, surfaceMessages(session))
  }
}