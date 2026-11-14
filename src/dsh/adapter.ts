// dsh-vcc: adapter between DSH session messages and the pi-shape messages the
// vendored pi-vcc core consumes.
//
// DSH stores messages as { role, content: ContentBlock[] } with blocks
// discriminated by `type` ('text' | 'reasoning' | 'image' | 'file' |
// 'tool-call'), and tool results carry `toolCallId` instead of a tool name.
// pi-vcc consumes pi-ai shapes: assistant content parts of type
// 'text' | 'toolCall' (arguments as an object) and toolResult messages that
// carry `toolName`. Everything the core reads is mapped here; the core itself
// is untouched.

const JSON_ARGS_FALLBACK = Object.freeze({})

/** Parse a DSH tool-call JSON-string arguments object; never throws. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return JSON_ARGS_FALLBACK as Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : JSON_ARGS_FALLBACK as Record<string, unknown>
  } catch {
    return JSON_ARGS_FALLBACK as Record<string, unknown>
  }
}

/** Extract plain text from DSH content blocks, skipping reasoning. */
export function textBlocksOf(content: unknown): string {
  const blocks = Array.isArray(content) ? content : []
  const parts: string[] = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

export interface AdapterOptions {
  /**
   * When true, reasoning blocks are surfaced as text parts. Recall search uses
   * this so `#N` can find decisions made in reasoning; the compile path keeps
   * them out.
   */
  includeReasoning?: boolean
}

/**
 * Convert one DSH message into a pi-shape message, or null when the message
 * has no representation the core can use (system/developer, empty assistant,
 * unknown role).
 *
 * @param toolNames - Map<toolCallId, toolName>. Populated as a side effect;
 *   pass the SAME map through a whole ordered walk so a tool result can be
 *   named from its call. A fresh map per message loses every name.
 */
export function toPiMessage(msg: any, toolNames: Map<string, string> = new Map(), opts: AdapterOptions = {}): any {
  if (!msg || typeof msg !== 'object') return null
  const { includeReasoning = false } = opts
  const role = msg.role

  if (role === 'user') {
    const content: any[] = []
    const text = textBlocksOf(msg.content)
    if (text) content.push({ type: 'text', text })
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === 'image') {
          const mime = block.attachment?.mime ?? block.attachment?.mimeType
          content.push({ type: 'image', mimeType: typeof mime === 'string' ? mime : 'image' })
        }
      }
    }
    if (content.length === 0) return null
    // dsh marks harness-injected user messages by `source.kind` (time-context,
    // runtime-context, skill-catalog, agent-instructions, user-approval...).
    // Only `user` is conversation; the rest is environment boilerplate that
    // must not become a "user request" in the summary. `injected` is the flag
    // the vendored normalize/extract pipeline already understands.
    const kind = msg.source?.kind
    const injected = typeof kind === 'string' && kind !== 'user'
    return {
      role: 'user',
      content,
      ...(msg.source ? { source: msg.source } : {}),
      ...(injected ? { injected: true } : {}),
    }
  }

  if (role === 'assistant') {
    if (!Array.isArray(msg.content) || msg.content.length === 0) return null
    const content: any[] = []
    for (const block of msg.content) {
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'reasoning' && typeof block.text === 'string' && includeReasoning) {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool-call') {
        content.push({
          type: 'toolCall',
          name: block.name ?? 'tool',
          arguments: parseToolArgs(block.arguments),
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
        })
        if (typeof block.id === 'string' && !toolNames.has(block.id)) {
          toolNames.set(block.id, block.name ?? 'tool')
        }
      }
      // 'image' / 'file' blocks in assistant content are intentionally dropped.
    }
    if (content.length === 0) return null
    return { role: 'assistant', content }
  }

  if (role === 'tool') {
    const name = typeof msg.toolCallId === 'string' ? toolNames.get(msg.toolCallId) : undefined
    // Mirror pi's toolResult shape: the name is required and may be unknown
    // when the matching assistant message is out of reach (kept as 'tool').
    return {
      role: 'toolResult',
      toolName: typeof name === 'string' ? name : 'tool',
      content: textBlocksOf(msg.content),
    }
  }

  // system / developer / anything unknown: no pi equivalent on this path.
  return null
}