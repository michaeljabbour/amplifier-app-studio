import { describe, expect, it } from "vitest";
import type { ProtocolRecord, SessionViewState } from "./protocol";
import { createSessionState, markAutopilotEngaged, markEffortPending, queueLocalSteer, reduceRecord, resolveAttention } from "./reducer";

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

  it("does not delay a new session after the runtime starts", () => {
    expect(started()).toMatchObject({ phase: "ready", replaying: false, restoreProgress: undefined });
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
      kind: "agent_spawned",
      agent: "foundation:explorer",
      sub_session_id: "child-1",
      parent_session_id: "runtime-1",
    }));
    state = reduceRecord(state, childRuntime(3, {
      kind: "tool_pre",
      tool_name: "bash",
      tool_call_id: "child-call-1",
      tool_input: { command: "ls -la" },
    }));
    state = reduceRecord(state, childRuntime(4, {
      kind: "tool_pre",
      tool_name: "bash",
      tool_call_id: "child-call-2",
      tool_input: { command: "find . -maxdepth 2" },
    }));
    state = reduceRecord(state, childRuntime(5, {
      kind: "content_block_end",
      block_type: "thinking",
      block: { thinking: "I should compare the manifests and entry points." },
    }));

    expect(state.lanes["child-1"]?.tools).toHaveLength(2);
    expect(state.lanes["child-1"]?.tools.every((tool) => tool.status === "running")).toBe(true);
    expect(state.lanes["child-1"]?.thinking).toContain("compare the manifests");
    expect(state.lanes["child-1"]?.events.some((event) => event.kind === "thinking")).toBe(true);
    expect(state.activity).toContain("2 operations");
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

  it("keeps active-session Autopilot scoped to its current turn", () => {
    let state = markAutopilotEngaged(started());
    expect(state.autopilot).toBe(true);
    state = reduceRecord(state, {
      schema_version: 1,
      type: "turn.completed",
      session_id: "runtime-1",
      response: "Done",
    });
    expect(state.autopilot).toBe(false);
  });

  it("keeps a thinking row when the provider withholds its text", () => {
    let state = started();
    state = reduceRecord(state, runtime(2, { kind: "content_block_start", block_type: "thinking" }));
    state = reduceRecord(state, runtime(3, { kind: "content_block_end", block_type: "thinking", block: {} }));
    expect(state.blocks.at(-1)).toMatchObject({ kind: "thinking", text: "" });
    expect(state.openThinkingId).toBeUndefined();
  });
});
