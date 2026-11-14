// dsh-vcc: the vcc_recall tool on DSH's tool registry.
//
// The tool's contract, description, and paging hints are upstream pi-vcc's
// (src/tools/recall.ts); only the transport differs — DSH's defineTool instead
// of pi's registerTool, and a session-backed RecallView instead of a file.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeToolParams, parseToolRequest } from '../core/recall-request.ts'
import { runRecall, type RecallPagingHints } from '../core/recall-run.ts'
import { openRecallView } from './recall-view.ts'

export { invalidExpandIndices } from '../core/recall-run.ts'

const TOOL_PAGING_HINTS: RecallPagingHints = {
  outOfRange: (_query, _scope, totalPages, truncated) => truncated
    ? `Use a page between 1 and ${totalPages}.`
    : `Use a page between 1 and ${totalPages}, or refine your query.`,
  nextPage: (_query, scope, page) =>
    `\n--- Use page:${page}${scope === 'all' ? " with scope:'all'" : ''} for more results ---`,
  skipCurrentTurn: true,
  aroundHit: (n, scope) =>
    `\n--- Read around a hit: range:[${Math.max(0, n - 3)}, ${n + 3}]; full text: expand:[${n}]${scope === 'all' ? " (with scope:'all')" : ''} ---`,
}

const DESCRIPTION = [
  'Recall earlier parts of this session, including anything dropped by compaction.',
  'Use it before saying the context is gone.',
  '',
  'Pick one per call:',
  '- query: keyword search (regex works), 5 results per page.',
  '- range: [from, to]: entries #from..#to in order, 20 per page.',
  '- expand: [N, ...]: full text of those entries.',
  "- mode: 'touched': files worked on, with entry indices.",
  "- query '#N:path': file content from entry N ('#N:path:full' for all lines).",
  '',
  'Add to any of them:',
  '- page: next page of query, range or touched results.',
  "- scope: 'lineage' (default) reads the current conversation path; 'all' also",
  '  reads edited or retried branches.',
  '',
  '#N is the number shown in summary refs like (#12) and in recall results.',
  'Only the current session is searchable. One result is capped at 50 KB.',
].join('\n')

/** Register the vcc_recall tool. */
export function registerRecallTool(ctx: any): void {
  ctx.tools.register(defineTool({
    name: 'vcc_recall',
    description: DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        description: "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. '#N:path' instead shows a file's content from entry N.",
      },
      range: {
        type: 'array',
        items: { type: 'integer' },
        description: '[from, to]: every entry from #from to #to (inclusive) in order, 20 per page. #N is the number in summary refs like (#12) and in recall results.',
      },
      expand: {
        type: 'array',
        items: { type: 'integer' },
        description: '#N indices to return full content for (from summary refs like (#12) or recall results).',
      },
      page: {
        type: 'integer',
        description: 'Page number (1-based) for query, range or touched results. Default: 1.',
      },
      scope: {
        type: 'string',
        enum: ['lineage', 'all'],
        description: "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried.",
      },
      mode: {
        type: 'string',
        enum: ['hybrid', 'touched'],
        description: "hybrid (default) = normal recall; touched = files worked on, by path, with entry indices. The touched list misses files written via apply_patch (paths inside the diff) or bash redirects.",
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, text: string) => [{ type: 'text', text }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: true,
    async execute(args: any, exec: any) {
      const session = exec.agent?.session
      if (!session) {
        throw new Error('vcc_recall: no agent session available; this tool only works inside an agent conversation.')
      }
      const request = parseToolRequest(normalizeToolParams(args ?? {}) as any)
      const view = openRecallView(session, request.scope)
      return runRecall(request, view, TOOL_PAGING_HINTS)
    },
  }))
}