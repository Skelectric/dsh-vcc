// dsh-vcc: /vcc and /vcc-recall human commands.
//
// /vcc           — preview the deterministic summary the engine would write for
//                  the current session (no mutation, no compaction run).
// /vcc-recall …  — the vcc_recall tool as a command (same algorithm).

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { parseCommandRequest } from '../core/recall-request.ts'
import { runRecall } from '../core/recall-run.ts'
import { openRecallView } from './recall-view.ts'
import { compileMessages, surfaceMessages } from './compile.ts'

const PREVIEW_MAX_CHARS = 30_000

const COMMAND_PAGING_HINTS = {
  outOfRange: (_query: string, _scope: string, totalPages: number, truncated: boolean) => truncated
    ? `Use a page between 1 and ${totalPages}.`
    : `Use a page between 1 and ${totalPages}, or refine your query.`,
  nextPage: (_query: string, scope: string, page: number) =>
    `\n--- Use /vcc-recall page:${page}${scope === 'all' ? " with scope:'all'" : ''} for more results ---`,
}

/** Register /vcc and /vcc-recall on every human-command adapter. */
export function registerVccCommands(ctx: any): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-vcc/command-vcc'),
    name: 'vcc',
    description: 'Preview the deterministic VCC compaction summary for the current session',
    async handler(invocation: any) {
      const session = invocation.agent?.session
      if (!session) return { kind: 'error', text: 'No session available.' }
      if ((invocation.rawInput ?? '').trim().length > 0) {
        return { kind: 'error', text: 'Usage: /vcc (no arguments) — previews the summary the next compaction would write.' }
      }
      const text = compileMessages(session, surfaceMessages(session))
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { kind: 'success', text: 'Nothing compactable in this session yet.' }
      }
      const clipped = text.length > PREVIEW_MAX_CHARS
        ? `${text.slice(0, PREVIEW_MAX_CHARS)}\n… (preview clipped at ${PREVIEW_MAX_CHARS} chars)`
        : text
      return { kind: 'success', text: clipped }
    },
  })

  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-vcc/command-vcc-recall'),
    name: 'vcc-recall',
    description: 'Recall earlier parts of this session (the vcc_recall tool as a command)',
    async handler(invocation: any) {
      const session = invocation.agent?.session
      if (!session) return { kind: 'error', text: 'No session available.' }
      try {
        const request = parseCommandRequest(invocation.rawInput ?? '')
        const view = openRecallView(session, request.scope)
        return { kind: 'success', text: runRecall(request, view, COMMAND_PAGING_HINTS as any) }
      } catch (error) {
        return { kind: 'error', text: `vcc-recall failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}