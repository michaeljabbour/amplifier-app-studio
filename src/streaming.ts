import { stringValue, type LiveTailState, type SessionViewState, type UIEvent } from "./protocol";

function identity(event: UIEvent, fallback?: LiveTailState): LiveTailState {
  return {
    requestId: stringValue(event.request_id) || fallback?.requestId || "",
    blockIndex: typeof event.block_index === "number" ? event.block_index : fallback?.blockIndex ?? 0,
    blockType: stringValue(event.block_type, fallback?.blockType || "text"),
    text: "",
  };
}

function sameBlock(a: LiveTailState, b: LiveTailState): boolean {
  return a.requestId === b.requestId && a.blockIndex === b.blockIndex && a.blockType === b.blockType;
}

/** The provider stream is provisional; durable content and completion text take precedence. */
export function reduceStream(state: SessionViewState, event: UIEvent): SessionViewState {
  const target = identity(event, event.kind === "stream_block_start" ? undefined : state.liveTail);
  if (target.blockType !== "text" && target.blockType !== "thinking") return state;
  let streams = state.streamBlocks || [];
  // A retry/new request must not combine its text with the preceding request.
  if (event.kind === "stream_block_start" && target.requestId && streams.some((block) => block.requestId !== target.requestId)) streams = [];
  const index = streams.findIndex((block) => sameBlock(block, target));
  const previous = index >= 0 ? streams[index] : undefined;
  if (previous?.durable || (event.kind === "stream_block_end" && !previous)) return state;
  const sequence = typeof event.sequence === "number" ? event.sequence : undefined;
  const eventId = stringValue(event.event_id) || undefined;
  // Older runtimes normalize an absent sequence to zero on every delta. Do
  // not mistake those distinct events for retransmissions of the first token.
  if (event.kind === "stream_block_delta" && previous) {
    if (eventId && eventId === previous.eventId) return state;
    if (sequence !== undefined && previous.sequence !== undefined
      && (sequence > 0 || previous.sequence > 0) && sequence <= previous.sequence) return state;
  }
  if (event.kind === "stream_block_start" && previous) return state;
  const block: LiveTailState = event.kind === "stream_block_end"
    ? { ...previous!, ended: true }
    : event.kind === "stream_block_delta"
      ? { ...target, text: `${previous?.text || ""}${stringValue(event.text)}`, sequence, eventId }
      : target;
  const streamBlocks = index >= 0
    ? streams.map((item, i) => i === index ? block : item)
    : [...streams, block];
  const liveTail = event.kind === "stream_block_end" && state.liveTail && !sameBlock(state.liveTail, target)
    ? state.liveTail
    : block;
  return {
    ...state, streamBlocks, liveTail,
    activity: liveTail.ended ? "Reviewing response" : liveTail.blockType === "thinking" ? "Thinking" : "Writing response",
  };
}

/** Durable blocks arrive in provider output order; their text may have been redacted. */
export function consumeStream(state: SessionViewState, blockType: string): SessionViewState {
  const index = state.streamBlocks?.findIndex((block) => !block.durable && block.blockType === blockType) ?? -1;
  if (index < 0) return state;
  const consumed = state.streamBlocks![index];
  return {
    ...state,
    streamBlocks: state.streamBlocks!.map((block, i) => i === index ? { ...block, text: "", durable: true } : block),
    liveTail: state.liveTail && sameBlock(state.liveTail, consumed) ? undefined : state.liveTail,
  };
}
