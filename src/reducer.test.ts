import { describe, expect, it } from "vitest";
import type { ProtocolRecord, SessionViewState } from "./protocol";
import { createSessionState, markAutopilotPending, markAutopilotSendFailed, markEffortPending, markPromptSendFailed, markPromptSubmitted, markRestoreDegraded, markSteerSendFailed, markSteerSubmitted, openRestoreAnyway, queueLocalSteer, reduceRecord, resolveAttention, retryRestore, setComposerDraft, setThinkingExpanded } from "./reducer";

function fresh(): SessionViewState {
  return createSessionState("gui-1", { projectDir: "/tmp/project", mode: "chat" });
}

function started(state = fresh()): SessionViewState {
  return reduceRecord(state, {
    schema_version: 1,
    sequence: 1,
    timestamp: "2026-08-10T00:00:00Z",
    type: "session.started",
    session_id: "runtime-1",
    bundle: "tui",
    model: "test/model",
  });
}

function runtime(sequence: number, event: Record<string, unknown>, replay = false): ProtocolRecord {
  return {
    schema_version: 1,
    sequence,
    timestamp: "2026-08-10T00:00:00Z",
    type: "runtime.event",
    replay,
    event: { event_id: `ev-${sequence}`, session_id: "runtime-1", parent_id: null, ...event },
  };
}

function childRuntime(sequence: number, event: Record<string, unknown>): ProtocolRecord {
  return {
    ...runtime(sequence, event),
    event: {
      event_id: `ev-${sequence}`,
      session_id: "child-1",
      parent_id: "runtime-1",
      ...event,
    },
  };
}

describe("session reducer", () => {
  it("folds the real Amplifier model-tool-result loop and highlights its current phase", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, { kind: "prompt_submit", prompt: "Fix it", mode: "auto" }));
    expect(state.turnLoop.phase).toBe("prompt");
    state = reduceRecord(state, runtime(3, { kind: "execution_start" }));
    state = reduceRecord(state, runtime(4, { kind: "content_block_start", block_type: "thinking", block_index: 0 }));
    expect(state.turnLoop).toMatchObject({ phase: "model", modelPasses: 1, iteration: 1 });

    state = reduceRecord(state, runtime(5, {
      kind: "tool_pre",
      tool_name: "bash",
      tool_call_id: "tool-1",
      tool_input: { command: "npm test" },
    }));
    expect(state.turnLoop).toMatchObject({ phase: "tools", toolCalls: 1 });
    expect(Object.keys(state.turnLoop.activeTools)).toEqual(["tool-1"]);

    state = reduceRecord(state, runtime(6, {
      kind: "tool_post",
      tool_name: "bash",
      tool_call_id: "tool-1",
      result: { status: "ok" },
    }));
    expect(state.turnLoop).toMatchObject({ phase: "model", toolResults: 1, awaitingModelPass: true });
    state = reduceRecord(state, runtime(7, { kind: "content_block_start", block_type: "text", block_index: 0 }));
    expect(state.turnLoop).toMatchObject({ phase: "model", modelPasses: 2, iteration: 2, awaitingModelPass: false });

    state = reduceRecord(state, runtime(8, { kind: "execution_end" }));
    expect(state.turnLoop.phase).toBe("response");
    state = reduceRecord(state, runtime(9, { kind: "orchestrator_complete", status: "success" }));
    state = reduceRecord(state, runtime(10, { kind: "prompt_complete", response: "Done" }));
    expect(state.turnLoop).toMatchObject({
      phase: "complete",
      modelPasses: 2,
      toolCalls: 1,
      toolResults: 1,
      detail: "Turn complete",
    });
    expect(state.turnLoop.transitions.map((transition) => transition.label)).toEqual(expect.arrayContaining([
      "Prompt accepted",
      "Model pass 1",
      "bash",
      "Result returned",
      "Model pass 2",
      "Final response",
      "Turn complete",
    ]));
  });

  it("tracks child agents as the delegate branch of the coordinator loop", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, { kind: "prompt_submit", prompt: "Survey it" }));
    state = reduceRecord(state, runtime(3, { kind: "execution_start" }));
    state = reduceRecord(state, runtime(4, {
      kind: "tool_pre",
      tool_name: "delegate",
      tool_call_id: "delegate-1",
      tool_input: { agent: "foundation:explorer", instruction: "Survey the repo" },
    }));
    state = reduceRecord(state, runtime(5, {
      kind: "agent_spawned",
      sub_session_id: "child-1",
      parent_session_id: "runtime-1",
      agent: "foundation:explorer",
    }));
    expect(state.turnLoop).toMatchObject({ phase: "delegates", delegates: 1 });
    state = reduceRecord(state, runtime(6, {
      kind: "agent_completed",
      sub_session_id: "child-1",
      agent: "foundation:explorer",
      success: true,
    }));
    state = reduceRecord(state, runtime(7, {
      kind: "tool_post",
      tool_name: "delegate",
      tool_call_id: "delegate-1",
      result: { status: "ok" },
    }));
    expect(state.turnLoop).toMatchObject({
      phase: "model",
      delegates: 1,
      completedDelegates: 1,
      toolResults: 1,
      awaitingModelPass: true,
    });
  });

  it("treats reused runtime event ids after resume as new when their timestamps differ", () => {
    let state = started();
    state = reduceRecord(state, {
      ...runtime(2, { kind: "prompt_submit", prompt: "First", ts: 10 }),
      event: { event_id: "ev2", session_id: "runtime-1", parent_id: null, kind: "prompt_submit", prompt: "First", ts: 10 },
    });
    state = reduceRecord(state, runtime(3, { kind: "execution_start", ts: 11 }));
    expect(state.turnLoop.modelPasses).toBe(1);

    state = reduceRecord(state, {
      ...runtime(4, { kind: "prompt_submit", prompt: "Second", ts: 20 }),
      event: { event_id: "ev2", session_id: "runtime-1", parent_id: null, kind: "prompt_submit", prompt: "Second", ts: 20 },
    });
    expect(state.turnLoop).toMatchObject({ phase: "prompt", modelPasses: 0, toolCalls: 0 });
    expect(state.turnLoop.transitions.map((transition) => transition.label)).toEqual(["Prompt accepted"]);
  });

  it("folds durable pipeline events before child-lane routing and ignores replay duplicates", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, {
      kind: "pipeline_started",
      graph_name: "Resolve",
      goal: "Verify the release",
      node_count: 2,
      edge_count: 1,
      dot_source: "digraph { inspect -> verify }",
    }));
    const startRecord = childRuntime(3, {
      kind: "pipeline_progress",
      phase: "node_started",
      node_id: "inspect",
      handler_type: "codergen",
      attempt: 1,
      execution_index: 1,
      node_session_id: "child-1",
    });
    state = reduceRecord(state, startRecord);
    state = reduceRecord(state, runtime(4, {
      kind: "pipeline_progress",
      phase: "node_completed",
      node_id: "inspect",
      handler_type: "codergen",
      status: "success",
      attempt: 1,
      execution_index: 1,
      duration_ms: 125,
    }));
    state = reduceRecord(state, runtime(5, {
      kind: "pipeline_progress",
      phase: "edge_selected",
      from_node: "inspect",
      to_node: "verify",
      edge_label: "tests required",
    }));

    expect(state.pipeline).toMatchObject({
      graphName: "Resolve",
      status: "running",
      nodes: { inspect: { status: "completed", durationMs: 125, handlerType: "codergen" } },
    });
    expect(Object.values(state.pipeline?.edges || {})).toEqual([
      expect.objectContaining({ from: "inspect", to: "verify", selected: true }),
    ]);
    expect(state.lanes["child-1"]).toBeUndefined();

    const beforeReplay = state;
    state = reduceRecord(state, { ...startRecord, replay: true });
    expect(state).toBe(beforeReplay);
    expect(state.pipeline?.nodes.inspect.status).toBe("completed");
  });

  it("defaults to Amplifier auto mode unless the user explicitly overrides it", () => {
    expect(createSessionState("gui-default", { projectDir: "/tmp/project" }).mode).toBe("auto");
    expect(createSessionState("gui-chat", { projectDir: "/tmp/project", mode: "chat" }).mode).toBe("chat");
  });

  it("keeps a resumed session non-interactive until history and status are restored", () => {
    let state = createSessionState("gui-resume", {
      projectDir: "/tmp/project",
      resumeId: "stored-session-1",
      resumeName: "Stored work",
    });

    expect(state).toMatchObject({
      phase: "starting",
      replaying: true,
      restoreProgress: { history: false, status: false },
    });

    state = reduceRecord(state, {
      schema_version: 1,
      type: "session.attached",
      session_id: "stored-session-1",
    });
    expect(state.phase).toBe("starting");

    state = reduceRecord(state, { schema_version: 1, type: "history.begin", since: 0 });
    state = reduceRecord(state, { schema_version: 1, type: "history.end", cursor: 43 });
    expect(state).toMatchObject({
      phase: "starting",
      replaying: false,
      bootLabel: "Restoring model, context, and spend",
      restoreProgress: { history: true, status: false },
    });

    state = reduceRecord(state, {
      schema_version: 1,
      type: "session.status",
      state: "idle",
      turn: { active: false },
      session: { bundle: "tui", model: "claude-opus-5", effort: "high" },
      context: { context_tokens: 90_000, context_window: 100_000, context_pct: 90, cost_usd: "114.13" },
      pending: { decisions: [] },
    });
    expect(state).toMatchObject({
      phase: "ready",
      replaying: false,
      bootLabel: "Session restored",
      model: "claude-opus-5",
      effort: "high",
      context: { percent: 90, costUsd: "114.13" },
      restoreProgress: { history: true, status: true },
    });
  });

  it("moves an incomplete restore into a bounded degraded state with retry and open-anyway recovery", () => {
    let state = createSessionState("gui-resume", {
      projectDir: "/tmp/project",
      resumeId: "stored-session-1",
    });
    state = reduceRecord(state, { schema_version: 1, type: "session.attached", session_id: "runtime-1" });
    state = reduceRecord(state, { schema_version: 1, type: "history.end", cursor: 12 });
    state = markRestoreDegraded(state, "Restore timed out");
    expect(state).toMatchObject({
      phase: "degraded",
      replaying: false,
      restoreIssue: { missing: ["status"], message: "Restore timed out", attempt: 1 },
    });

    state = retryRestore(state);
    expect(state).toMatchObject({
      phase: "starting",
      bootLabel: "Retrying session status",
      restoreIssue: { attempt: 2 },
    });

    state = openRestoreAnyway(state);
    expect(state.phase).toBe("ready");
    expect(state.restoreProgress).toBeUndefined();
    expect(state.blocks.at(-1)).toMatchObject({ kind: "notice", level: "warning" });
  });

  it("keeps replayed agents inspectable without calling them live after an idle restore", () => {
    let state = createSessionState("gui-resume", {
      projectDir: "/tmp/project",
      resumeId: "stored-session-1",
    });
    state = reduceRecord(state, { schema_version: 1, type: "session.attached", session_id: "runtime-1" });
    state = reduceRecord(state, { schema_version: 1, type: "history.begin", since: 0 });
    state = reduceRecord(state, runtime(42, {
      kind: "agent_spawned",
      sub_session_id: "child-1",
      parent_session_id: "runtime-1",
      agent: "foundation:explorer",
    }, true));
    state = reduceRecord(state, {
      ...runtime(43, {
        kind: "tool_pre",
        tool_name: "bash",
        tool_call_id: "unfinished-call",
        tool_input: { command: "git status" },
      }, true),
      event: {
        event_id: "ev-43",
        session_id: "child-1",
        parent_id: "runtime-1",
        kind: "tool_pre",
        tool_name: "bash",
        tool_call_id: "unfinished-call",
        tool_input: { command: "git status" },
      },
    });
    state = reduceRecord(state, { schema_version: 1, type: "history.end", cursor: 42 });
    state = reduceRecord(state, {
      schema_version: 1,
      type: "session.status",
      state: "idle",
      turn: { active: false },
      session: {},
      context: {},
      pending: { decisions: [] },
    });

    expect(state.busy).toBe(false);
    expect(state.lanes["child-1"]).toMatchObject({
      status: "detached",
      activity: "Completion was not recorded in durable history",
      tools: [expect.objectContaining({ id: "unfinished-call", status: "unknown" })],
    });
  });

  it("preserves live replayed agents when authoritative status says the turn is active", () => {
    let state = createSessionState("gui-resume", {
      projectDir: "/tmp/project",
      resumeId: "stored-session-1",
    });
    state = reduceRecord(state, { schema_version: 1, type: "session.attached", session_id: "runtime-1" });
    state = reduceRecord(state, { schema_version: 1, type: "history.begin", since: 0 });
    state = reduceRecord(state, runtime(42, {
      kind: "agent_spawned",
      sub_session_id: "child-1",
      parent_session_id: "runtime-1",
      agent: "foundation:explorer",
    }, true));
    state = reduceRecord(state, { schema_version: 1, type: "history.end", cursor: 42 });
    state = reduceRecord(state, {
      schema_version: 1,
      type: "session.status",
      state: "busy",
      turn: { active: true },
      session: {},
      context: {},
      pending: { decisions: [] },
    });

    expect(state.busy).toBe(true);
    expect(state.lanes["child-1"].status).toBe("running");
  });

  it("does not delay a new session after the runtime starts", () => {
    expect(started()).toMatchObject({ phase: "ready", replaying: false, restoreProgress: undefined });
  });

  it("shows a submitted prompt immediately and reconciles the runtime echo", () => {
    let state = markPromptSubmitted(started(), "continue the work");
    expect(state).toMatchObject({
      busy: true,
      activity: "Submitting prompt",
      pendingPrompt: { text: "continue the work", mode: "chat" },
    });
    expect(state.blocks).toEqual([
      expect.objectContaining({ kind: "user", text: "continue the work", mode: "chat" }),
    ]);

    state = reduceRecord(state, runtime(2, {
      kind: "prompt_submit",
      prompt: "continue the work",
      mode: "chat",
    }));
    expect(state.pendingPrompt).toBeUndefined();
    expect(state.blocks.filter((block) => block.kind === "user")).toHaveLength(1);
    expect(state.activity).toBe("Starting turn");
  });

  it("keeps submitted image attachments with the optimistic user message", () => {
    const image = {
      id: "image-1",
      name: "diagram.png",
      mediaType: "image/png" as const,
      data: "iVBORw0KGgo=",
      size: 8,
    };
    const state = markPromptSubmitted(started(), "Review this diagram", [image]);

    expect(state.blocks.at(-1)).toMatchObject({
      kind: "user",
      text: "Review this diagram",
      images: [image],
    });
  });

  it("makes a prompt transport failure visible and returns control", () => {
    const state = markPromptSendFailed(markPromptSubmitted(started(), "continue"), "Runtime is closed");
    expect(state).toMatchObject({ busy: false, activity: "Prompt was not sent", pendingPrompt: undefined });
    expect(state.blocks.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "Runtime is closed" });
  });

  it("keeps a session-scoped composer draft across attention and send failures", () => {
    let state = setComposerDraft(started(), "Do not lose this draft");
    state = reduceRecord(state, {
      schema_version: 1,
      type: "approval.required",
      ticket_id: "approval-1",
      prompt: "Run command?",
      options: ["Allow once", "Deny"],
    });
    expect(state.composerDraft).toBe("Do not lose this draft");
    state = markPromptSendFailed(markPromptSubmitted(state, state.composerDraft), "Connection closed");
    expect(state.composerDraft).toBe("Do not lose this draft");
  });

  it("keeps effort pending until the runtime acknowledges the exact state", () => {
    let state = markEffortPending(started(), "high");
    expect(state.effortPending).toBe("high");
    state = reduceRecord(state, {
      schema_version: 1,
      type: "effort.state",
      effort: "high",
      levels: ["none", "low", "high"],
      ok: true,
    });
    expect(state.effort).toBe("high");
    expect(state.effortLevels).toEqual(["none", "low", "high"]);
    expect(state.effortPending).toBeUndefined();
  });

  it("keeps stream deltas in the live tail and Channel B text in durable history", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, { kind: "prompt_submit", prompt: "hello", mode: "chat" }));
    state = reduceRecord(state, runtime(3, { kind: "stream_block_start", block_type: "text" }));
    state = reduceRecord(state, runtime(4, { kind: "stream_block_delta", block_type: "text", text: "Hel" }));
    state = reduceRecord(state, runtime(5, { kind: "stream_block_delta", block_type: "text", text: "lo" }));

    expect(state.liveTail?.text).toBe("Hello");
    expect(state.blocks.filter((block) => block.kind === "answer")).toHaveLength(0);

    state = reduceRecord(state, runtime(6, { kind: "stream_block_end", block_type: "text" }));
    state = reduceRecord(
      state,
      runtime(7, { kind: "content_block_end", block_type: "text", block: { text: "Hello" } }),
    );
    expect(state.liveTail).toBeUndefined();
    expect(state.blocks.at(-1)).toMatchObject({ kind: "answer", text: "Hello", final: false });

    state = reduceRecord(state, { schema_version: 1, type: "turn.completed", response: "Hello" });
    expect(state.blocks.at(-1)).toMatchObject({ kind: "answer", final: true });
    expect(state.busy).toBe(false);
  });

  it("correlates tool completion by tool_call_id", () => {
    let state = started();
    state = reduceRecord(
      state,
      runtime(2, {
        kind: "tool_pre",
        tool_name: "read_file",
        tool_call_id: "call-7",
        tool_input: { path: "README.md" },
      }),
    );
    state = reduceRecord(
      state,
      runtime(3, {
        kind: "tool_post",
        tool_name: "read_file",
        tool_call_id: "call-7",
        result: { status: "ok" },
      }),
    );
    expect(state.blocks.at(-1)).toMatchObject({
      kind: "tool",
      toolCallId: "call-7",
      status: "completed",
    });
  });

  it("treats replay sequences as ledger cursors and settles replayed turns", () => {
    let state = started();
    state = reduceRecord(state, { schema_version: 1, type: "history.begin", since: 0 });
    state = reduceRecord(
      state,
      runtime(42, { kind: "prompt_submit", prompt: "old prompt", mode: "build" }, true),
    );
    state = reduceRecord(
      state,
      runtime(43, { kind: "prompt_complete", response: "old answer" }, true),
    );
    state = reduceRecord(state, { schema_version: 1, type: "history.end", cursor: 43 });

    expect(state.lastSequence).toBe(1);
    expect(state.busy).toBe(false);
    expect(state.replaying).toBe(false);
    expect(state.blocks.some((block) => block.kind === "notice" && block.text.includes("sequence gap"))).toBe(false);
  });

  it("surfaces sequence gaps without dropping the record", () => {
    let state = started();
    state = reduceRecord(state, runtime(4, { kind: "notification", message: "still visible" }));
    const notices = state.blocks.filter((block) => block.kind === "notice");
    expect(notices.map((block) => block.text)).toContain("Protocol sequence gap: expected 2, received 4");
    expect(notices.map((block) => block.text)).toContain("still visible");
    expect(state.lastSequence).toBe(4);
  });

  it("hides internal hook-suppression telemetry from the transcript", () => {
    let state = started();
    state = reduceRecord(
      state,
      runtime(2, {
        kind: "notification",
        message: "suppressed hooks: hooks-streaming-ui, hooks-todo-display",
      }),
    );
    expect(state.blocks).toHaveLength(0);
    expect(state.lastSequence).toBe(2);

    state = reduceRecord(state, runtime(3, { kind: "notification", message: "Filesystem access is guarded" }));
    expect(state.blocks.at(-1)).toMatchObject({ kind: "notice", text: "Filesystem access is guarded" });

    state = reduceRecord(state, runtime(4, {
      kind: "notification",
      level: "debug",
      source: "event-canary",
      message: "unbridged event kind · skills:discovered",
    }));
    state = reduceRecord(state, runtime(5, {
      kind: "notification",
      source: "hook:bash",
      message: "blocked · ls -la",
    }));
    expect(state.blocks.filter((block) => block.kind === "notice")).toHaveLength(1);
  });

  it("routes recoverable bundle fallback notices to setup alerts instead of the conversation", () => {
    const state = reduceRecord(started(), runtime(2, {
      kind: "notification",
      level: "info",
      message: "stored bundle 'bundle:anchors' not found — resumed under 'tui' bundle instead",
    }));
    expect(state.blocks).toHaveLength(0);
    expect(state.alerts).toEqual([expect.objectContaining({
      title: "Session recovered with a different bundle",
      message: expect.stringContaining("bundle:anchors"),
    })]);
  });

  it("bounds steering and reports unconsumed items at turn end", () => {
    let state = { ...started(), busy: true };
    for (let index = 0; index < 40; index += 1) state = queueLocalSteer(state);
    expect(state.queuedSteers).toBe(32);
    state = reduceRecord(state, { schema_version: 1, type: "turn.completed", response: "done" });
    expect(state.queuedSteers).toBe(0);
    expect(state.blocks.some((block) => block.kind === "notice" && block.text.includes("32 queued steers"))).toBe(true);
  });

  it("echoes a submitted steer immediately while Amplifier keeps working", () => {
    const state = markSteerSubmitted({ ...started(), busy: true }, "Use the smaller fix");
    expect(state.blocks.at(-1)).toMatchObject({ kind: "user", mode: "steer", text: "Use the smaller fix" });
    expect(state.queuedSteers).toBe(1);
    expect(state.busy).toBe(true);
  });

  it("removes an optimistic steer when the transport does not deliver it", () => {
    const submitted = markSteerSubmitted({ ...started(), busy: true }, "Use the smaller fix");
    const steerId = submitted.blocks.at(-1)?.id;
    const failed = markSteerSendFailed(submitted, "bridge disconnected", steerId);
    expect(failed.blocks.some((block) => block.id === steerId)).toBe(false);
    expect(failed.blocks.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "bridge disconnected" });
    expect(failed.queuedSteers).toBe(0);
    expect(failed.activity).toBe("Course correction was not delivered");
  });

  it("captures approval tickets from the broker record", () => {
    const state = reduceRecord(started(), {
      schema_version: 1,
      type: "approval.required",
      ticket_id: "approval-3",
      prompt: "Run command?",
      options: ["Allow once", "Allow always", "Deny"],
    });
    expect(state.pendingApproval).toEqual({
      ticketId: "approval-3",
      prompt: "Run command?",
      options: ["Allow once", "Allow always", "Deny"],
    });
  });

  it("attributes approval attention only from runtime identity fields", () => {
    let state = reduceRecord(started(), runtime(2, {
      kind: "agent_spawned",
      child_session_id: "child-1",
      agent: "builder",
    }));
    state = reduceRecord(state, childRuntime(3, {
      kind: "tool_pre",
      tool_name: "bash",
      tool_call_id: "call-7",
      tool_input: { command: "cargo test" },
    }));
    state = reduceRecord(state, {
      schema_version: 1,
      type: "approval.required",
      ticket_id: "approval-7",
      session_id: "child-1",
      parent_id: "runtime-1",
      tool_call_id: "call-7",
      prompt: "Run cargo test?",
      options: ["Allow once", "Deny"],
    });
    expect(state.pendingApproval).toMatchObject({
      ticketId: "approval-7",
      sessionId: "child-1",
      parentId: "runtime-1",
      toolCallId: "call-7",
    });
    expect(state.lanes["child-1"]?.status).toBe("attention");
  });

  it("does not clear a newer approval when an older response finishes", () => {
    let state = reduceRecord(started(), {
      schema_version: 1,
      type: "approval.required",
      ticket_id: "approval-1",
      prompt: "Run first command?",
      options: ["Allow once", "Deny"],
    });
    state = reduceRecord(state, {
      schema_version: 1,
      type: "approval.required",
      ticket_id: "approval-2",
      prompt: "Run second command?",
      options: ["Allow once", "Deny"],
    });
    state = resolveAttention(state, { approvalTicketId: "approval-1" });
    expect(state.pendingApproval?.ticketId).toBe("approval-2");

    state = reduceRecord(state, runtime(2, {
      kind: "approval_denied",
      prompt: "Run first command?",
      continuation: "continuing without first command",
    }));
    expect(state.pendingApproval?.ticketId).toBe("approval-2");
  });

  it("reconciles missed approvals from session.status", () => {
    const state = reduceRecord(started(), {
      schema_version: 1,
      type: "session.status",
      state: "awaiting_approval",
      turn: { active: true, queued_steers: 1 },
      session: { bundle: "bundle:anchors", model: "claude-opus-5", effort: "max" },
      pending: {
        approval: {
          ticket_id: "approval-9",
          prompt: "Run deployment?",
          options: ["Allow once", "Allow always", "Deny"],
        },
        decisions: [],
      },
      context: { context_tokens: 1200, context_window: 8000, context_pct: 15, cost_usd: "0.12" },
    });
    expect(state).toMatchObject({
      busy: true,
      activity: "Waiting for approval",
      queuedSteers: 1,
      model: "claude-opus-5",
      effort: "max",
      pendingApproval: { ticketId: "approval-9" },
      context: { tokens: 1200, window: 8000, percent: 15, costUsd: "0.12" },
    });
  });

  it("tracks every parallel child tool and durable child thinking", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, {
      kind: "tool_pre",
      tool_name: "delegate",
      tool_call_id: "delegate-call",
      tool_input: {
        agent: "foundation:explorer",
        instruction: "Survey the repository and report its architecture.",
        model_role: "fast",
      },
    }));
    state = reduceRecord(state, runtime(3, {
      kind: "agent_spawned",
      agent: "foundation:explorer",
      sub_session_id: "child-1",
      parent_session_id: "runtime-1",
      ts: 10,
    }));
    state = reduceRecord(state, childRuntime(4, {
      kind: "tool_pre",
      tool_name: "bash",
      tool_call_id: "child-call-1",
      tool_input: { command: "ls -la" },
    }));
    state = reduceRecord(state, childRuntime(5, {
      kind: "tool_pre",
      tool_name: "bash",
      tool_call_id: "child-call-2",
      tool_input: { command: "find . -maxdepth 2" },
    }));
    state = reduceRecord(state, childRuntime(6, {
      kind: "content_block_end",
      block_type: "thinking",
      block: { thinking: "I should compare the manifests and entry points." },
    }));
    state = reduceRecord(state, childRuntime(7, {
      kind: "provider_response_usage",
      model: "claude-haiku",
      input_tokens: 100,
      output_tokens: 20,
      cost_usd: "0.0012",
    }));

    expect(state.lanes["child-1"]?.tools).toHaveLength(2);
    expect(state.lanes["child-1"]?.tools.every((tool) => tool.status === "running")).toBe(true);
    expect(state.lanes["child-1"]?.thinking).toContain("compare the manifests");
    expect(state.lanes["child-1"]?.events.some((event) => event.kind === "thinking")).toBe(true);
    expect(state.lanes["child-1"]).toMatchObject({
      instruction: "Survey the repository and report its architecture.",
      model: "claude-haiku",
      costUsd: "0.0012",
      costBasis: "reported",
      startedAtMs: 10_000,
    });
    expect(state.activity).toContain("2 operations");
  });

  it("captures proposed root plan steps before a rejected todo action settles", () => {
    let state = reduceRecord(started(), runtime(2, {
      kind: "tool_pre",
      tool_name: "todo",
      tool_call_id: "root-plan-1",
      tool_input: {
        operation: "update",
        todos: [
          { content: "Inspect the runtime", activeForm: "Inspecting the runtime", status: "in_progress" },
          { content: "Verify the UI", status: "pending" },
        ],
      },
    }));

    expect(state.plans.coordinator).toMatchObject({
      ownerId: "runtime-1",
      ownerKind: "coordinator",
      toolCallId: "root-plan-1",
      updateStatus: "pending",
      items: [
        { content: "Inspect the runtime", activeForm: "Inspecting the runtime", status: "in_progress" },
        { content: "Verify the UI", status: "pending" },
      ],
    });
    expect(state.blocks.some((block) => block.kind === "tool" && block.toolCallId === "root-plan-1")).toBe(false);

    state = reduceRecord(state, runtime(3, {
      kind: "tool_post",
      tool_name: "todo",
      tool_call_id: "root-plan-1",
      result: { status: "rejected" },
    }));
    expect(state.plans.coordinator).toMatchObject({
      updateStatus: "degraded",
      message: "Plan update was denied. The proposed steps are retained for visibility.",
      items: [{ content: "Inspect the runtime" }, { content: "Verify the UI" }],
    });
  });

  it("replaces plans per owner and ignores late outcomes from superseded updates", () => {
    let state = reduceRecord(started(), runtime(2, {
      kind: "tool_pre",
      tool_name: "todo",
      tool_call_id: "root-plan-old",
      tool_input: { todos: [{ content: "Old root step", status: "pending" }] },
    }));
    state = reduceRecord(state, runtime(3, {
      kind: "tool_pre",
      tool_name: "todo",
      tool_call_id: "root-plan-current",
      tool_input: { todos: [{ content: "Current root step", status: "completed" }] },
    }));
    state = reduceRecord(state, childRuntime(4, {
      kind: "tool_pre",
      tool_name: "todo",
      tool_call_id: "agent-plan",
      tool_input: { todos: [{ content: "Inspect child path", status: "in-progress" }] },
    }));

    expect(Object.keys(state.plans)).toEqual(["coordinator", "agent:child-1"]);
    expect(state.plans.coordinator.items).toEqual([{ content: "Current root step", activeForm: undefined, status: "completed" }]);
    expect(state.plans["agent:child-1"]).toMatchObject({
      ownerId: "child-1",
      ownerKind: "agent",
      items: [{ content: "Inspect child path", status: "in_progress" }],
    });

    state = reduceRecord(state, runtime(5, {
      kind: "tool_post",
      tool_name: "todo",
      tool_call_id: "root-plan-old",
      result: { status: "failed", error: "late failure" },
    }));
    expect(state.plans.coordinator.updateStatus).toBe("pending");
    state = reduceRecord(state, runtime(6, {
      kind: "tool_post",
      tool_name: "todo",
      tool_call_id: "root-plan-current",
      result: { status: "ok" },
    }));
    expect(state.plans.coordinator.updateStatus).toBe("applied");
  });

  it("reconstructs coordinator and agent plans from durable replay", () => {
    let state = createSessionState("gui-resume", { projectDir: "/tmp/project", resumeId: "stored-session" });
    state = reduceRecord(state, { schema_version: 1, type: "session.attached", session_id: "runtime-1" });
    state = reduceRecord(state, { schema_version: 1, type: "history.begin", since: 0 });
    state = reduceRecord(state, runtime(20, {
      kind: "tool_pre",
      tool_name: "todo",
      tool_call_id: "root-replay-plan",
      tool_input: { todos: [{ content: "Restore root plan", status: "completed" }] },
    }, true));
    state = reduceRecord(state, runtime(21, {
      kind: "tool_post",
      tool_name: "todo",
      tool_call_id: "root-replay-plan",
      result: { status: "ok" },
    }, true));
    state = reduceRecord(state, {
      ...childRuntime(22, {
        kind: "tool_pre",
        tool_name: "todo",
        tool_call_id: "child-replay-plan",
        tool_input: { todos: [{ content: "Restore agent plan", status: "pending" }] },
      }),
      replay: true,
    });
    state = reduceRecord(state, {
      ...childRuntime(23, {
        kind: "tool_post",
        tool_name: "todo",
        tool_call_id: "child-replay-plan",
        result: { status: "ok" },
      }),
      replay: true,
    });
    state = reduceRecord(state, { schema_version: 1, type: "history.end", cursor: 23 });

    expect(state.plans.coordinator.items[0]?.content).toBe("Restore root plan");
    expect(state.plans.coordinator.updateStatus).toBe("applied");
    expect(state.plans["agent:child-1"].items[0]?.content).toBe("Restore agent plan");
    expect(state.plans["agent:child-1"].ownerKind).toBe("agent");
    expect(state.plans["agent:child-1"].updateStatus).toBe("applied");
  });

  it("accepts update_plan payloads as structured plans", () => {
    let state = reduceRecord(started(), runtime(2, {
      kind: "tool_pre",
      tool_name: "functions.update_plan",
      tool_call_id: "root-update-plan",
      tool_input: {
        explanation: "Fix the reported defects",
        plan: [
          { step: "Inspect the runtime evidence", status: "completed" },
          { step: "Repair the UI", status: "in_progress" },
        ],
      },
    }));

    expect(state.plans.coordinator.items).toEqual([
      { content: "Inspect the runtime evidence", activeForm: undefined, status: "completed" },
      { content: "Repair the UI", activeForm: undefined, status: "in_progress" },
    ]);
    state = reduceRecord(state, runtime(3, {
      kind: "tool_post",
      tool_name: "functions.update_plan",
      tool_call_id: "root-update-plan",
      result: { status: "ok" },
    }));
    expect(state.plans.coordinator.updateStatus).toBe("applied");
  });

  it("estimates all-agent RunPod spend without treating LiteLLM zero as free", () => {
    let state = reduceRecord(fresh(), {
      schema_version: 1,
      sequence: 1,
      type: "session.started",
      session_id: "runtime-1",
      bundle: "tui",
      model: "moonshotai/Kimi-K3",
    });
    state = reduceRecord(state, runtime(2, {
      kind: "provider_response_usage",
      input_tokens: 4_000_000,
      output_tokens: 500_000,
      cache_read: 3_000_000,
      model: "",
      cost_usd: 0,
    }));
    state = reduceRecord(state, childRuntime(3, {
      kind: "provider_response_usage",
      input_tokens: 400_000,
      output_tokens: 100_000,
      cache_read: 350_000,
      model: "general",
      cost_usd: null,
    }));
    state = reduceRecord(state, {
      schema_version: 1,
      type: "context.state",
      context_tokens: 80_000,
      context_window: 524_288,
      context_pct: 15,
      cost_usd: "0",
      cost_estimated: true,
    });

    expect(state.context).toMatchObject({
      costUsd: "52.65",
      costBasis: "estimated",
      inputTokens: 4_400_000,
      outputTokens: 600_000,
      unpricedTokens: 0,
      usageResponses: 2,
      estimateModel: "moonshotai/Kimi-K3",
      estimateRatePerMillion: 10.53,
    });
    expect(state.lanes["child-1"]).toMatchObject({
      costUsd: "5.265",
      costBasis: "estimated",
    });
  });

  it("marks a priced total as partial when another model has no configured rate", () => {
    let state = reduceRecord(fresh(), {
      schema_version: 1,
      sequence: 1,
      type: "session.started",
      session_id: "runtime-1",
      bundle: "tui",
      model: "moonshotai/Kimi-K3",
    });
    state = reduceRecord(state, runtime(2, {
      kind: "provider_response_usage",
      input_tokens: 900_000,
      output_tokens: 100_000,
    }));
    state = reduceRecord(state, childRuntime(3, {
      kind: "provider_response_usage",
      input_tokens: 1_000,
      output_tokens: 100,
      model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    }));

    expect(state.context.costBasis).toBe("partial");
    expect(state.context.costUsd).toBe("10.53");
    expect(state.context.unpricedTokens).toBe(1_100);
  });

  it("captures concrete generated and edited paths as inspectable outputs", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, {
      kind: "tool_pre",
      tool_name: "write_file",
      tool_call_id: "output-call",
      tool_input: { path: "/tmp/flow.dot" },
    }));
    state = reduceRecord(state, runtime(3, {
      kind: "tool_post",
      tool_name: "write_file",
      tool_call_id: "output-call",
      result: { success: true, output: { file_path: "/tmp/flow.dot" } },
    }));
    expect(state.outputs).toEqual([expect.objectContaining({
      title: "flow.dot",
      kind: "diagram",
      path: "/tmp/flow.dot",
      toolCallId: "output-call",
      eventId: "ev-3",
    })]);

    state = reduceRecord(state, runtime(4, {
      kind: "tool_post",
      tool_name: "write_file",
      tool_call_id: "later-output-call",
      result: { success: true, output: { file_path: "/tmp/flow.dot" } },
    }));
    expect(state.outputs).toHaveLength(1);
    expect(state.outputs[0]?.id).toBe("/tmp/flow.dot");
  });

  it("attributes child outputs to the producing lane without inventing a runtime host", () => {
    let state = started();
    state = reduceRecord(state, childRuntime(2, {
      kind: "tool_post",
      tool_name: "write_file",
      tool_call_id: "child-output",
      result: { output_path: "/tmp/child.json" },
    }));
    expect(state.outputs[0]).toMatchObject({
      path: "/tmp/child.json",
      laneId: "child-1",
      toolCallId: "child-output",
      eventId: "ev-2",
    });
    expect(state.outputs[0]?.runtimeHost).toBeUndefined();
  });

  it("does not mislabel files returned by read, glob, search, or shell tools as outputs", () => {
    let state = started();
    for (const [index, toolName] of ["read_file", "glob", "grep", "bash"].entries()) {
      state = reduceRecord(state, runtime(index + 2, {
        kind: "tool_post",
        tool_name: toolName,
        tool_call_id: `reference-${index}`,
        result: {
          success: true,
          output: {
            file_path: "/tmp/existing/BACKLOG.md",
            matches: [{ path: "/tmp/existing/NOTES.md" }],
          },
        },
      }));
    }
    expect(state.outputs).toEqual([]);
  });

  it("surfaces autonomous goal state and a durable markdown completion notice", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, {
      kind: "goal_progress",
      state: "continuing",
      turn: 2,
      continuations: 1,
      cap: 5,
      reason: "Verifying the **mobile** build",
    }));
    expect(state.goal).toMatchObject({ state: "continuing", turn: 2, continuations: 1, cap: 5 });
    expect(state.activity).toContain("Goal · turn 2/5");

    state = reduceRecord(state, runtime(3, {
      kind: "goal_progress",
      state: "achieved",
      turn: 3,
      continuations: 2,
      cap: 5,
      summary: "The **desktop and mobile** builds passed.",
    }));
    expect(state.goal?.state).toBe("achieved");
    expect(state.blocks.at(-1)).toMatchObject({
      kind: "notice",
      text: expect.stringContaining("**desktop and mobile**"),
    });
  });

  it("uses runtime acknowledgements as the source of truth for Autopilot", () => {
    let state = markAutopilotPending(started());
    expect(state.autopilot).toBe(false);
    expect(state.autopilotPending).toBe(true);
    state = reduceRecord(state, {
      schema_version: 1,
      type: "goal.state",
      session_id: "runtime-1",
      ok: true,
      action: "set",
      active: true,
      condition: "Ship it",
      max_turns: 32,
    });
    expect(state.autopilot).toBe(true);
    expect(state.autopilotPending).toBe(false);
    expect(state.goal).toMatchObject({ state: "armed", condition: "Ship it", cap: 32 });
    state = reduceRecord(state, {
      schema_version: 1,
      type: "goal.state",
      session_id: "runtime-1",
      ok: true,
      action: "cleared",
      active: false,
    });
    expect(state.autopilot).toBe(false);
    expect(state.goal?.state).toBe("cleared");
  });

  it("releases a pending Autopilot control when the command cannot be sent", () => {
    const state = markAutopilotSendFailed(markAutopilotPending(started()), "Bridge unavailable");
    expect(state.autopilotPending).toBe(false);
    expect(state.blocks.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "Bridge unavailable" });
  });

  it("keeps a thinking row when the provider withholds its text", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, { kind: "content_block_start", block_type: "thinking" }));
    state = reduceRecord(state, runtime(3, { kind: "content_block_end", block_type: "thinking", block: {} }));
    expect(state.blocks.at(-1)).toMatchObject({ kind: "thinking", text: "" });
    expect(state.openThinkingId).toBeUndefined();
  });

  it("preserves the user's thinking disclosure state when streaming completes", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, { kind: "content_block_start", block_type: "thinking" }));
    const thinking = state.blocks.at(-1);
    expect(thinking).toMatchObject({ kind: "thinking", expanded: true });
    state = setThinkingExpanded(state, thinking?.id || "", false);
    state = reduceRecord(state, runtime(3, {
      kind: "content_block_end",
      block_type: "thinking",
      block: { thinking: "Checked the repository state" },
    }));
    expect(state.blocks.at(-1)).toMatchObject({
      kind: "thinking",
      text: "Checked the repository state",
      expanded: false,
    });
  });
});
