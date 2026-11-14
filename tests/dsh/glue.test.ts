// dsh-vcc: integration tests for the DSH glue, against a fake event-backed
// session. No dsh runtime is needed: the session contract used by the engine
// and recall is surface/eventAt/deriveEventMessage/snapshotEvents.
import { describe, it, expect } from '../bun-test.js'
import { compileMessages, surfaceMessages } from '../../src/dsh/compile.ts'
import { loadMessages } from '../../src/dsh/session-source.ts'
import { openRecallView } from '../../src/dsh/recall-view.ts'
import { parseToolRequest } from '../../src/core/recall-request.ts'
import { runRecall } from '../../src/core/recall-run.ts'
import { closingMessageSeq } from '../../src/dsh/manual-range.ts'

const HINTS = {
  outOfRange: (_q: string, _s: string, totalPages: number) => `Use a page between 1 and ${totalPages}.`,
  nextPage: (_q: string, _s: string, page: number) => `\n--- page:${page} ---`,
  skipCurrentTurn: true,
}

/** Fake dsh session: events carry seqs, messages project from them. */
function fakeSession(entries: { seq: number; type: string; message: any }[]) {
  const bySeq = new Map(entries.map((e) => [e.seq, e]))
  const byMessage = new Map(entries.map((e) => [e.message, e.message]))
  return {
    id: 'test-session',
    surface: { nodes: entries.map((e) => e.seq) },
    eventAt: (seq: number) => bySeq.get(seq),
    snapshotEvents: () => [...entries],
    deriveEventMessage: (event: any) => event?.message,
    _byMessage: byMessage,
    _entries: entries,
  }
}

/** Fake session in dsh's real event shape: `data.message` per event. */
function surfaceSession(entries: { seq: number; type: string; message: any }[]) {
  const bySeq = new Map(entries.map((e) => [e.seq, { ...e, data: { message: e.message } }]))
  return {
    surface: { nodes: entries.map((e) => e.seq) },
    eventAt: (seq: number) => bySeq.get(seq),
  }
}

const user = (text: string, extra: any = {}) => ({ role: 'user', content: [{ type: 'text', text }], ...extra })
const assistant = (text: string, calls: any[] = []) => ({
  role: 'assistant',
  content: [{ type: 'text', text }, ...calls],
})
const call = (id: string, name: string, args: any) => ({
  type: 'tool-call', id, name, arguments: JSON.stringify(args),
})
const toolResult = (id: string, text: string) => ({
  role: 'tool', toolCallId: id, content: [{ type: 'text', text }],
})

function sample() {
  return fakeSession([
    { seq: 1, type: 'user/message', message: user('Fix the redis cache eviction bug in auth.ts. Goal: p99 under 50ms.') },
    { seq: 2, type: 'assistant/message', message: assistant('I will inspect auth.ts.', [call('c1', 'read', { path: 'src/auth.ts' })]) },
    { seq: 3, type: 'tool/result', message: toolResult('c1', 'export function login() { /* 200 lines */ }') },
    { seq: 4, type: 'assistant/message', message: assistant('The eviction used a stale TTL. I will change 300 to 60.') },
    { seq: 5, type: 'user/message', message: user('Also prefer tabs over spaces.') },
  ])
}

describe('dsh glue', () => {
  it('compiles a session into sections with seq-backed refs', () => {
    const session = sample()
    const summary = compileMessages(session, surfaceMessages(session))
    expect(summary).toContain('[Early Session Requests]')
    expect(summary).toContain('redis cache eviction')
    expect(summary).toContain('(#2)')
    expect(summary).toContain('(#4)')
  })

  it('keeps tool names on tool results (one map per walk)', () => {
    const session = sample()
    const { rawMessages } = loadMessages(session, 'lineage', false)
    const results = rawMessages.filter((m: any) => m.role === 'toolResult')
    expect(results).toHaveLength(1)
    expect(results[0].toolName).toBe('read')
  })

  it('keeps harness-injected user messages out of the summary', () => {
    const session = fakeSession([
      { seq: 1, type: 'user/message', message: user('Fix the redis bug.') },
      {
        seq: 2,
        type: 'user/message',
        message: user('Time sampled while preparing turn 1: 2026-01-01T00:00:00Z', {
          source: { kind: 'time-context', form: 'snapshot' },
        }),
      },
      {
        seq: 3,
        type: 'user/message',
        message: user('Current runtime context. This snapshot supersedes earlier snapshots.', {
          source: { kind: 'runtime-context', form: 'snapshot' },
        }),
      },
      { seq: 4, type: 'assistant/message', message: assistant('On it.') },
    ])
    const summary = compileMessages(session, surfaceMessages(session))
    expect(summary).toContain('Fix the redis bug.')
    expect(summary).not.toContain('Time sampled while preparing')
    expect(summary).not.toContain('Current runtime context')
  })

  it('serves search through the upstream recall pipeline', () => {
    const session = sample()
    const request = parseToolRequest({ query: 'redis' })
    const view = openRecallView(session, request.scope)
    const out = runRecall(request, view, HINTS as any)
    expect(out).toContain('redis')
  })

  it('expands an entry with its full text', () => {
    const session = sample()
    const request = parseToolRequest({ expand: [3] })
    const view = openRecallView(session, request.scope)
    const out = runRecall(request, view, HINTS as any)
    expect(out).toContain('export function login')
  })

  it('extends a manual compaction span through the closing assistant reply', () => {
    // Idle session: the last node is the assistant reply to the final user message.
    const session = surfaceSession([
      { seq: 1, type: 'user/message', message: user('Fix the redis bug.') },
      { seq: 2, type: 'assistant/message', message: assistant('Done: TTL is now 60s.') },
    ])
    expect(closingMessageSeq(session)).toBe(2)
  })

  it('keeps the dsh span when the last node is an open tool step or a user message', () => {
    const openStep = surfaceSession([
      { seq: 1, type: 'user/message', message: user('Fix the redis bug.') },
      { seq: 2, type: 'assistant/message', message: assistant('Reading auth.ts.', [call('c1', 'read', { path: 'src/auth.ts' })]) },
    ])
    expect(closingMessageSeq(openStep)).toBeUndefined()

    const trailingUser = surfaceSession([
      { seq: 1, type: 'user/message', message: user('Fix the redis bug.') },
      { seq: 2, type: 'assistant/message', message: assistant('Done.') },
      { seq: 3, type: 'user/message', message: user('Thanks.') },
    ])
    expect(closingMessageSeq(trailingUser)).toBeUndefined()

    expect(closingMessageSeq(surfaceSession([]))).toBeUndefined()
  })

  it('reads shadowed branches only with scope:all', () => {
    const session = sample()
    // A retried branch: seq 6 exists in the log but not on the live surface.
    const shadowed = user('This draft reply was edited away.')
    ;(session as any).snapshotEvents = () => [
      ...(session as any)._entries,
      { seq: 6, type: 'user/message', message: shadowed },
    ]
    const lineage = openRecallView(session, 'lineage')
    const all = openRecallView(session, 'all')
    expect(lineage.load(false).rendered).toHaveLength(5)
    expect(all.load(false).rendered).toHaveLength(6)
  })
})