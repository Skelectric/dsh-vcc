// dsh-vcc: manual compaction range extension.
//
// dsh's `compactNow` selects the span with `retainTokens: 0`, which keeps the
// final surface node outside the span. On an idle session that node is the
// assistant reply to the last user message, so the compiled summary would stop
// at that user message and dsh would keep the reply verbatim after the
// checkpoint. pi-vcc's summary quotes the closing exchange, so the manual path
// extends the span through that node when it is a complete step boundary.

/**
 * The seq of the closing assistant message to compact through, or `undefined`
 * when the last surface node is not a finished assistant reply.
 *
 * A tool-call block means the step is still open (its result would follow), and
 * a span may not split a tool-call/result pair — dsh's own selection is used
 * unchanged in that case.
 * @param session - session whose live surface ends the conversation.
 * @returns the last node's seq when it is a closed assistant reply.
 */
export function closingMessageSeq(session: any): number | undefined {
  const nodes = session?.surface?.nodes ?? []
  const last = nodes[nodes.length - 1]
  if (typeof last !== 'number') return undefined
  const event = session.eventAt?.(last)
  if (event?.type !== 'assistant/message') return undefined
  const content = event?.data?.message?.content ?? []
  return content.some((block: any) => block?.type === 'tool-call') ? undefined : last
}
