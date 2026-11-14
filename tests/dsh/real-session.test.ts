// dsh-vcc: compile and recall against a real dsh session log, with no model.
//
// The durable log is zstd-compressed JSONL. This reconstructs the live surface
// from `surfaceOp` (append, or replace over a seq range) exactly as dsh keeps
// it, then runs the same code path the engine runs at compaction time.
//
// Skips when the home has no sessions (CI), like upstream's real-sessions test.
import { describe, it, expect, beforeAll } from '../bun-test.js'
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { compileMessages } from '../../src/dsh/compile.ts'
import { loadMessages } from '../../src/dsh/session-source.ts'
import { openRecallView } from '../../src/dsh/recall-view.ts'
import { parseToolRequest } from '../../src/core/recall-request.ts'
import { runRecall } from '../../src/core/recall-run.ts'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(HOME, 'sessions')

/** Newest session log anywhere under the sessions tree. */
function newestSessionLog(root: string): string | undefined {
  if (!existsSync(root)) return undefined
  let best: { path: string; mtime: number } | undefined
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        // A live session holds session.lock; its log is mid-stream and may be
        // multi-frame, so only completed sessions are used here.
        if (existsSync(join(path, 'session.lock'))) continue
        walk(path)
      } else if (name === 'session.v4.jsonl.zstd' && (best === undefined || st.mtimeMs > best.mtime)) {
        best = { path, mtime: st.mtimeMs }
      }
    }
  }
  walk(root)
  return best?.path
}

/** Decompress every zstd frame in the log (dsh appends one frame per batch;
 *  Node's one-shot decompressor stops after the first). */
function decompressFrames(buf: Buffer): string {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets: number[] = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
      offsets.push(i)
    }
  }
  const parts: string[] = []
  for (let i = 0; i < offsets.length; i++) {
    const frame = buf.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buf.length)
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
    } catch {
      // A truncated trailing frame (a session still flushing) is skipped.
    }
  }
  return parts.join('')
}

/** Rebuild the live surface from durable events (append / replace ops). */
function fakeSessionFromLog(path: string) {
  const text = decompressFrames(readFileSync(path))
  const events = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  const bySeq = new Map<number, any>()
  let surface: number[] = []
  for (const event of events) {
    if (typeof event.seq !== 'number') continue
    bySeq.set(event.seq, event)
    const op = event.surfaceOp
    if (op === undefined || op === null) continue
    if (typeof op === 'object') {
      surface = surface.filter((seq) => seq < op.startSeq || seq > op.endSeq)
      surface.push(event.seq)
    } else {
      surface.push(event.seq)
    }
  }
  return {
    id: 'real-session',
    surface: { nodes: surface },
    eventAt: (seq: number) => bySeq.get(seq),
    snapshotEvents: () => events,
    // User messages store the message fields directly on `data`; assistant
    // messages and tool results nest them under `data.message`.
    deriveEventMessage: (event: any) => event?.data?.message ?? (event?.data?.role ? event.data : undefined),
  }
}

let session: any
let summary: string

beforeAll(() => {
  const log = newestSessionLog(SESSIONS)
  if (log === undefined) return
  session = fakeSessionFromLog(log)
  summary = compileMessages(session, session.surface.nodes.map((seq: number) => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean))
})

describe('real session', () => {
  it('compiles a real transcript into a structured summary', () => {
    if (session === undefined) return
    expect(summary.length).toBeGreaterThan(0)
    expect(summary).toMatch(/^\[[A-Z][^\]\n]*\]/)
  })

  it('emits only refs that resolve on the live surface', () => {
    if (session === undefined) return
    const available = new Set(loadMessages(session, 'lineage', false).rendered.map((e: any) => e.index))
    const refs = [...summary.matchAll(/\(#(\d+)\)/g)].map((m) => Number(m[1]))
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.filter((n) => !available.has(n))).toEqual([])
  })

  it('names tool results from their calls', () => {
    if (session === undefined) return
    const { rawMessages } = loadMessages(session, 'lineage', false)
    const named = rawMessages.filter((m: any) => m.role === 'toolResult' && m.toolName !== 'tool')
    expect(named.length).toBeGreaterThan(0)
  })

  it('recalls from the same index space', () => {
    if (session === undefined) return
    const request = parseToolRequest({ query: 'compaction' })
    const view = openRecallView(session, request.scope)
    const out = runRecall(request, view, {
      outOfRange: () => '',
      nextPage: () => '',
      skipCurrentTurn: false,
    } as any)
    expect(out.length).toBeGreaterThan(0)
  })

  it('keeps the summary far smaller than the transcript', () => {
    if (session === undefined) return
    const inputChars = loadMessages(session, 'lineage', false).rawMessages
      .map((m: any) => JSON.stringify(m)).join('').length
    expect(summary.length).toBeLessThan(inputChars)
  })
})