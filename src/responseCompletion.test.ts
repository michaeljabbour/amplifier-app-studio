import { describe, expect, it } from "vitest";
import { createSessionState, markExited, reduceRecord, setThinkingExpanded } from "./reducer";
import type { SessionViewState } from "./protocol";

function start() {
  return event({ ...createSessionState("test", { projectDir: "/tmp" }), runtimeSessionId: "root", phase: "ready" }, "prompt_submit", { prompt: "Hello" });
}
function event(state: SessionViewState, kind: string, fields: Record<string, unknown> = {}) {
  return reduceRecord(state, { type: "runtime.event", event: { kind, session_id: "root", ...fields } });
}
function stream(state: SessionViewState, text = "Visible answer", type = "text") {
  state = event(state, "stream_block_start", { request_id: "request", block_index: 0, block_type: type });
  return event(state, "stream_block_delta", { request_id: "request", block_index: 0, block_type: type, event_id: "delta-0", sequence: 0, text });
}
const complete = (state: SessionViewState, response = "") => reduceRecord(state, { type: "turn.completed", response });
const answers = (state: SessionViewState) => state.blocks.filter((b) => b.kind === "answer");

describe("response completion recovery", () => {
  it("keeps streamed text visible at block end and preserves it if final text is missing", () => {
    let state = stream(start());
    state = event(state, "stream_block_end", { request_id: "request", block_index: 0, block_type: "text" });
    expect(state.liveTail?.text).toBe("Visible answer");
    state = event(state, "prompt_complete", { response: "" });
    state = complete(state);
    expect(answers(state)).toEqual([expect.objectContaining({ text: "Visible answer", final: false, incomplete: true })]);
    expect(state.responseIssue).toBe("partial");
    expect(state.busy).toBe(false);
  });

  it("explains thinking-only completion without passing reasoning off as an answer", () => {
    const state = complete(stream(start(), "Private reasoning", "thinking"));
    expect(answers(state)).toHaveLength(0);
    expect(state.responseIssue).toBe("empty");
  });

  it("uses durable text instead of duplicating its streamed version", () => {
    let state = stream(start());
    state = event(state, "content_block_end", { block_type: "text", block: { text: "Visible answer" } });
    expect(state.liveTail).toBeUndefined();
    state = complete(state);
    expect(answers(state)).toEqual([expect.objectContaining({ text: "Visible answer", final: true })]);
    expect(state.responseIssue).toBeUndefined();
  });

  it("keeps authoritative redacted content instead of the raw stream", () => {
    let state = stream(start(), "Value secret-fixture");
    state = event(state, "content_block_end", { block_type: "text", block: { text: "Value [REDACTED]" } });
    state = complete(state);
    expect(answers(state).map((b) => b.text)).toEqual(["Value [REDACTED]"]);
    expect(state.responseIssue).toBeUndefined();
  });

  it("does not mistake commentary before tools for a final answer", () => {
    let state = stream(start(), "I will inspect it");
    state = event(state, "content_block_end", { block_type: "text", block: { text: "I will inspect it" } });
    state = event(state, "tool_pre", { tool_name: "read_file", tool_call_id: "read", tool_input: {} });
    state = complete(state);
    expect(state.responseIssue).toBe("empty");
    expect(answers(state)[0].final).toBe(false);
  });

  it("renders identical answers in separate turns", () => {
    let state = complete(start(), "Done");
    state = event(state, "prompt_submit", { prompt: "Again" });
    state = complete(state, "Done");
    expect(answers(state)).toHaveLength(2);
  });

  it("does not duplicate partial output on repeated completion and clears recovery for the next turn", () => {
    let state = complete(stream(start()));
    state = complete(state);
    expect(answers(state)).toHaveLength(1);
    expect(state.responseIssue).toBe("partial");
    state = event(state, "prompt_submit", { prompt: "Please finish" });
    expect(state.responseIssue).toBeUndefined();
    state = complete(state, "Done");
    expect(answers(state).map((b) => b.text)).toEqual(["Visible answer", "Done"]);
  });

  it("does not append a missing-answer warning to an explicit interruption or error", () => {
    let interrupted = event(stream(start()), "cancel_completed");
    interrupted = complete(interrupted);
    expect(interrupted.responseIssue).toBeUndefined();
    let failed = reduceRecord(stream(start()), { type: "error", error: "Provider unavailable" });
    failed = complete(failed);
    expect(failed.responseIssue).toBeUndefined();
    expect(failed.error).toBe("Provider unavailable");
  });

  it("ignores a delayed end for another block and uses delta type when start is absent", () => {
    let state = stream(start(), "Thinking", "thinking");
    state = event(state, "stream_block_delta", { request_id: "request", block_index: 1, block_type: "text", sequence: 0, text: "Answer" });
    state = event(state, "stream_block_end", { request_id: "request", block_index: 0, block_type: "thinking" });
    expect(state.liveTail).toMatchObject({ blockType: "text", text: "Answer" });
    state = complete(state);
    expect(answers(state)[0].text).toBe("Answer");
  });

  it("does not append duplicate deltas carrying the same stream sequence", () => {
    let state = stream(start());
    state = event(state, "stream_block_delta", { request_id: "request", block_index: 0, block_type: "text", event_id: "delta-0", sequence: 0, text: "Visible answer" });
    expect(state.liveTail?.text).toBe("Visible answer");
  });

  it("does not allocate new state for a redundant native disclosure toggle", () => {
    const state = event(start(), "content_block_start", { block_type: "thinking" });
    const block = state.blocks.at(-1)!;
    expect(setThinkingExpanded(state, block.id, true)).toBe(state);
  });
  it("keeps an unconfirmed second text block even if the first was durable", () => {
    let state = stream(start(), "First paragraph");
    state = event(state, "content_block_end", { block_type: "text", block: { text: "First paragraph" } });
    state = event(state, "stream_block_delta", { request_id: "request", block_index: 1, block_type: "text", sequence: 0, text: "Second paragraph" });
    state = complete(state);
    expect(answers(state).map((b) => b.text)).toEqual(["First paragraph", "Second paragraph"]);
    expect(state.responseIssue).toBe("partial");
  });

  it("does not let a late stream delta resurrect content already replaced by durable text", () => {
    let state = stream(start(), "Value secret-fixture");
    state = event(state, "content_block_end", { block_type: "text", block: { text: "Value [REDACTED]" } });
    state = event(state, "stream_block_delta", { request_id: "request", block_index: 0, block_type: "text", sequence: 1, text: " late" });
    state = complete(state);
    expect(answers(state).map((b) => b.text)).toEqual(["Value [REDACTED]"]);
    expect(state.responseIssue).toBeUndefined();
  });

  it("places a final answer after tools even when it repeats earlier commentary", () => {
    let state = event(start(), "content_block_end", { block_type: "text", block: { text: "Done" } });
    state = event(state, "tool_pre", { tool_name: "read_file", tool_call_id: "read", tool_input: {} });
    state = complete(state, "Done");
    expect(answers(state)).toHaveLength(2);
    expect(state.blocks.at(-1)).toMatchObject({ kind: "answer", final: true });
  });

  it("reconciles a multi-block final response without showing the answer twice", () => {
    let state = event(start(), "content_block_end", { block_type: "text", block: { text: "First" } });
    state = event(state, "content_block_end", { block_type: "text", block: { text: "Second" } });
    state = complete(state, "First\n\nSecond");
    expect(answers(state)).toEqual([expect.objectContaining({ text: "First\n\nSecond", final: true })]);
  });

  it("does not label a durable answer final after interruption", () => {
    let state = event(start(), "content_block_end", { block_type: "text", block: { text: "Unfinished" } });
    state = event(state, "cancel_completed");
    state = complete(state);
    expect(answers(state)[0].final).toBe(false);
    expect(state.responseIssue).toBeUndefined();
  });

  it("preserves text if the process exits without turn.completed", () => {
    const state = markExited(stream(start()), 1, "Runtime exited");
    expect(answers(state)).toEqual([expect.objectContaining({ text: "Visible answer", incomplete: true, final: false })]);
    expect(state.phase).toBe("error");
    expect(state.streamBlocks).toBeUndefined();
  });

  it("keeps multi-block partial recovery stable on duplicate completion", () => {
    let state = event(start(), "content_block_end", { block_type: "text", block: { text: "First" } });
    state = stream(state, "Second");
    state = complete(complete(state));
    expect(answers(state).map((b) => b.text)).toEqual(["First", "Second"]);
    expect(state.responseIssue).toBe("partial");
    expect(answers(state).every((b) => !b.final)).toBe(true);
  });

  it("does not promote commentary preceding a plan-only tool call", () => {
    let state = event(start(), "content_block_end", { block_type: "text", block: { text: "Updating the plan" } });
    state = event(state, "tool_pre", { tool_name: "todo", tool_call_id: "plan", tool_input: { action: "write", todos: [{ content: "Inspect", status: "completed" }] } });
    state = complete(state);
    expect(state.responseIssue).toBe("empty");
    expect(answers(state)[0].final).toBe(false);
  });

  it("trusts a nonempty prompt completion even if the outer completion is empty", () => {
    let state = stream(start());
    state = event(state, "prompt_complete", { response: "Visible answer" });
    state = complete(state);
    expect(answers(state)).toEqual([expect.objectContaining({ text: "Visible answer", final: true })]);
    expect(state.responseIssue).toBeUndefined();
  });

  it("accepts legacy deltas whose absent sequence was normalized to zero", () => {
    let state = stream(start(), "One");
    state = event(state, "stream_block_delta", { request_id: "request", block_index: 0, block_type: "text", event_id: "legacy-2", sequence: 0, text: " two" });
    state = event(state, "stream_block_delta", { request_id: "request", block_index: 0, block_type: "text", event_id: "legacy-3", sequence: 0, text: " two" });
    expect(state.liveTail?.text).toBe("One two two");
  });

  it("rejects out-of-order sequenced deltas after the counter advances", () => {
    let state = stream(start(), "One");
    state = event(state, "stream_block_delta", { request_id: "request", block_index: 0, block_type: "text", sequence: 1, text: " two" });
    state = event(state, "stream_block_delta", { request_id: "request", block_index: 0, block_type: "text", sequence: 0, text: "One" });
    state = event(state, "stream_block_delta", { request_id: "request", block_index: 0, block_type: "text", sequence: 1, text: " two" });
    expect(state.liveTail?.text).toBe("One two");
  });

});
