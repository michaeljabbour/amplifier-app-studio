import {
  asEvent,
  DEFAULT_EFFORT_LEVELS,
  isRecord,
  JSONL_SCHEMA_VERSION,
  type LaneEventState,
  type LaneState,
  type LaneToolState,
  type ComposerImage,
  numberValue,
  type ProtocolRecord,
  safeJson,
  type SessionViewState,
  stringList,
  stringValue,
  type TranscriptBlock,
  type UIEvent,
} from "./protocol";

type NewTranscriptBlock = TranscriptBlock extends infer Block
  ? Block extends { id: string }
    ? Omit<Block, "id">
    : never
  : never;

export function createSessionState(
  guiId: string,
  input: {
    projectDir: string;
    bundle?: string;
    model?: string;
    provider?: string;
    mode?: string;
    resumeId?: string;
    resumeName?: string;
    capabilityId?: string;
    capabilityName?: string;
  },
): SessionViewState {
  return {
    guiId,
    capabilityId: input.capabilityId,
    capabilityName: input.capabilityName,
    projectDir: input.projectDir,
    requestedBundle: input.bundle,
    requestedModel: input.model,
    requestedProvider: input.provider,
    resumeId: input.resumeId,
    title: input.resumeName || input.capabilityName || (input.resumeId ? `Resume ${input.resumeId.slice(0, 8)}` : "New session"),
    bundle: input.bundle || "default bundle",
    model: "starting…",
    mode: input.mode || "auto",
    phase: "starting",
    bootLabel: input.resumeId ? "Restoring session" : "Launching runtime",
    busy: false,
    composerDraft: "",
    composerImages: [],
    autopilot: false,
    autopilotPending: false,
    activity: "Starting turn",
    replaying: Boolean(input.resumeId),
    restoreProgress: input.resumeId ? { history: false, status: false } : undefined,
    context: { tokens: 0, window: 0, percent: 0, costUsd: "0" },
    effortLevels: [...DEFAULT_EFFORT_LEVELS],
    blocks: [],
    lanes: {},
    pendingDelegateBriefs: {},
    alerts: [],
    outputs: [],
    queuedSteers: 0,
    nextBlock: 1,
    logs: [],
  };
}

export function reduceRecord(state: SessionViewState, record: ProtocolRecord): SessionViewState {
  let next = checkEnvelope(state, record);
  const type = stringValue(record.type);

  switch (type) {
    case "boot.progress":
      return {
        ...next,
        phase: "starting",
        bootLabel: bootMessage(stringValue(record.action), stringValue(record.detail)),
      };
    case "session.started":
      return {
        ...next,
        runtimeSessionId: stringValue(record.session_id),
        title: next.resumeId || next.capabilityName ? next.title : `Session ${stringValue(record.session_id).slice(0, 8)}`,
        bundle: stringValue(record.bundle, next.bundle),
        model: stringValue(record.model, next.model),
        phase: next.restoreProgress ? "starting" : "ready",
        bootLabel: next.restoreProgress ? "Restoring conversation history" : "Runtime ready",
        error: undefined,
      };
    case "session.attached":
      return {
        ...next,
        runtimeSessionId: stringValue(record.session_id),
        phase: next.restoreProgress ? "starting" : "ready",
        bootLabel: next.restoreProgress ? "Restoring conversation history" : "Attached to live runtime",
      };
    case "session.status":
      return markRestoreStatus(reduceSessionStatus(next, record));
    case "runtime.event": {
      const event = asEvent(record.event);
      return event ? reduceEvent(next, event, record.replay === true) : next;
    }
    case "approval.required":
      return markLaneAwaitingApproval({
        ...next,
        busy: true,
        activity: "Waiting for approval",
        pendingApproval: {
          ticketId: stringValue(record.ticket_id),
          prompt: stringValue(record.prompt, "Amplifier needs approval"),
          options: stringList(record.options),
          sessionId: stringValue(record.session_id) || undefined,
          parentId: stringValue(record.parent_id) || undefined,
          toolCallId: stringValue(record.tool_call_id) || undefined,
        },
      }, {
        sessionId: stringValue(record.session_id),
        toolCallId: stringValue(record.tool_call_id),
        prompt: stringValue(record.prompt),
      });
    case "context.state":
      return {
        ...next,
        context: {
          tokens: numberValue(record.context_tokens),
          window: numberValue(record.context_window),
          percent: numberValue(record.context_pct),
          costUsd: String(record.cost_usd ?? next.context.costUsd),
        },
      };
    case "effort.state": {
      const effort = typeof record.effort === "string" ? record.effort : next.effort;
      const levels = stringList(record.levels);
      const reconciled = {
        ...next,
        effort,
        effortLevels: levels.length ? levels : next.effortLevels,
        effortPending: undefined,
      };
      return record.ok === false
        ? appendBlock(reconciled, {
            kind: "notice",
            level: "error",
            text: stringValue(record.detail, "Amplifier could not change the effort level"),
          })
        : reconciled;
    }
    case "goal.state": {
      const ok = record.ok !== false;
      const action = stringValue(record.action, "status");
      const active = ok && record.active === true;
      const condition = stringValue(record.condition) || next.goal?.condition;
      const maxTurns = numberValue(record.max_turns);
      const goal = active
        ? {
            state: next.goal?.state === "continuing" ? "continuing" : "armed",
            condition,
            turn: next.goal?.turn || 0,
            continuations: next.goal?.continuations || 0,
            cap: maxTurns > 0 ? maxTurns : next.goal?.cap,
            reason: next.goal?.reason,
            summary: next.goal?.summary,
            stallDetail: next.goal?.stallDetail,
            updatedAtMs: Date.now(),
          }
        : action === "cleared" && next.goal
          ? { ...next.goal, state: "cleared", updatedAtMs: Date.now() }
          : next.goal;
      const acknowledged = {
        ...next,
        autopilot: active,
        autopilotPending: false,
        goal,
        activity: active
          ? (next.busy ? "Autopilot armed for this run" : "Autopilot running")
          : action === "cleared"
            ? (next.busy ? "Finishing current step · Autopilot off" : "Autopilot off")
            : next.activity,
      };
      return ok
        ? acknowledged
        : appendBlock(acknowledged, {
            kind: "notice",
            level: "error",
            text: stringValue(record.detail, "Amplifier could not change the autonomous goal"),
          });
    }
    case "goal.result": {
      const ok = record.ok !== false;
      const finished = {
        ...next,
        busy: false,
        autopilot: false,
        autopilotPending: false,
        pendingPrompt: undefined,
        liveTail: undefined,
        queuedSteers: 0,
        turnStartedAtMs: undefined,
        activity: ok ? "Autonomous goal stopped" : "Autonomous goal failed",
      };
      return ok
        ? finished
        : appendBlock(finished, {
            kind: "notice",
            level: "error",
            text: stringValue(record.detail, "Amplifier's autonomous goal stopped with an error"),
          });
    }
    case "history.begin":
      return {
        ...next,
        replaying: true,
        phase: next.restoreProgress && next.phase !== "degraded" ? "starting" : next.phase,
        bootLabel: "Replaying durable history",
      };
    case "history.end":
      return markRestoreProgress(next, "history");
    case "turn.completed": {
      const response = stringValue(record.response).trim();
      next = finalizeAnswer(next, response);
      if (next.queuedSteers > 0) {
        next = appendBlock(next, {
          kind: "notice",
          level: "warning",
          text: `${next.queuedSteers} queued steer${next.queuedSteers === 1 ? "" : "s"} discarded at turn end`,
        });
      }
      return {
        ...next,
        busy: false,
        pendingPrompt: undefined,
        autopilot: false,
        autopilotPending: false,
        activity: "Idle",
        liveTail: undefined,
        openThinkingId: undefined,
        queuedSteers: 0,
        turnStartedAtMs: undefined,
      };
    }
    case "error": {
      const message = stringValue(record.error, "Unknown runtime error");
      next = appendBlock(next, { kind: "notice", level: "error", text: message });
      return {
        ...next,
        busy: false,
        pendingPrompt: undefined,
        autopilot: false,
        autopilotPending: false,
        liveTail: undefined,
        error: message,
        phase: next.runtimeSessionId ? next.phase : "error",
      };
    }
    case "control.conflict":
      return appendBlock(next, {
        kind: "notice",
        level: "warning",
        text: `Write refused: ${stringValue(record.reason, "session is controlled elsewhere")}`,
      });
    default:
      return next;
  }
}

export function queueLocalSteer(state: SessionViewState): SessionViewState {
  return { ...state, queuedSteers: Math.min(32, state.queuedSteers + 1) };
}

export function setComposerDraft(state: SessionViewState, draft: string): SessionViewState {
  return { ...state, composerDraft: draft };
}

export function setComposerImages(state: SessionViewState, images: ComposerImage[]): SessionViewState {
  return { ...state, composerImages: images };
}

export function markSteerSubmitted(state: SessionViewState, text: string): SessionViewState {
  const steer = text.trim();
  if (!steer) return state;
  const next = appendBlock(state, { kind: "user", text: steer, mode: "steer" });
  return {
    ...next,
    queuedSteers: Math.min(32, state.queuedSteers + 1),
    activity: "Course correction queued for Amplifier",
  };
}

export function markSteerSendFailed(
  state: SessionViewState,
  message: string,
  optimisticSteerId?: string,
): SessionViewState {
  const withoutUndeliveredSteer = optimisticSteerId
    ? { ...state, blocks: state.blocks.filter((block) => block.id !== optimisticSteerId) }
    : state;
  const next = appendBlock(withoutUndeliveredSteer, { kind: "notice", level: "error", text: message });
  return {
    ...next,
    queuedSteers: Math.max(0, state.queuedSteers - 1),
    activity: "Course correction was not delivered",
  };
}

export function markPromptSubmitted(
  state: SessionViewState,
  text: string,
  images: ComposerImage[] = [],
): SessionViewState {
  const prompt = text.trim();
  if (!prompt) return state;
  const next = appendBlock(state, {
    kind: "user",
    text: prompt,
    mode: state.mode,
    images: images.length ? images : undefined,
  });
  return {
    ...next,
    pendingPrompt: { text: prompt, mode: state.mode },
    busy: true,
    activity: "Submitting prompt",
    turnStartedAtMs: Date.now(),
    error: undefined,
    goal: state.goal?.state === "continuing" || state.goal?.state === "armed" ? state.goal : undefined,
    liveTail: undefined,
    openThinkingId: undefined,
  };
}

export function markPromptSendFailed(state: SessionViewState, message: string): SessionViewState {
  const next = appendBlock(state, { kind: "notice", level: "error", text: message });
  return {
    ...next,
    pendingPrompt: undefined,
    busy: false,
    autopilotPending: false,
    activity: "Prompt was not sent",
    turnStartedAtMs: undefined,
  };
}

export function markAutopilotPending(state: SessionViewState): SessionViewState {
  return {
    ...state,
    autopilotPending: true,
    activity: state.autopilot ? "Turning Autopilot off" : "Asking Amplifier to manage this goal",
  };
}

export function markAutopilotSendFailed(state: SessionViewState, message: string): SessionViewState {
  return appendBlock({
    ...state,
    autopilotPending: false,
    activity: state.busy ? state.activity : "Autopilot change was not delivered",
  }, { kind: "notice", level: "error", text: message });
}

export function markEffortPending(state: SessionViewState, effort: string): SessionViewState {
  return { ...state, effortPending: effort };
}

export function resolveAttention(
  state: SessionViewState,
  expected: { approvalTicketId?: string; decisionId?: string },
): SessionViewState {
  const pendingApproval =
    expected.approvalTicketId && state.pendingApproval?.ticketId === expected.approvalTicketId
      ? undefined
      : state.pendingApproval;
  const pendingDecision =
    expected.decisionId && state.pendingDecision?.decisionId === expected.decisionId
      ? undefined
      : state.pendingDecision;
  return { ...state, pendingApproval, pendingDecision };
}

export function addLocalNotice(
  state: SessionViewState,
  text: string,
  level: "info" | "warning" | "error" | "success" = "info",
): SessionViewState {
  return appendBlock(state, { kind: "notice", level, text });
}

export function addProcessLog(state: SessionViewState, stream: string, message: string): SessionViewState {
  const logs = [...state.logs, `[${stream}] ${message}`].slice(-120);
  return { ...state, logs };
}

export function dismissAlert(state: SessionViewState, alertId: string): SessionViewState {
  return { ...state, alerts: state.alerts.filter((alert) => alert.id !== alertId) };
}

export function markClosing(state: SessionViewState): SessionViewState {
  return { ...state, phase: "closing", bootLabel: "Stopping runtime" };
}

export function markExited(
  state: SessionViewState,
  code: number | undefined,
  message: string,
): SessionViewState {
  let next = state;
  if (code !== 0 || state.phase !== "closing") {
    next = appendBlock(next, {
      kind: "notice",
      level: code === 0 ? "info" : "error",
      text: message,
    });
  }
  return {
    ...next,
    phase: code === 0 ? "exited" : "error",
    busy: false,
    pendingPrompt: undefined,
    autopilot: false,
    autopilotPending: false,
    activity: "Idle",
    liveTail: undefined,
    openThinkingId: undefined,
    turnStartedAtMs: undefined,
    pendingApproval: undefined,
    pendingDecision: undefined,
    exitCode: code,
    error: code === 0 ? undefined : message,
  };
}

export function markRestoreDegraded(state: SessionViewState, message: string): SessionViewState {
  if (!state.restoreProgress || (state.restoreProgress.history && state.restoreProgress.status)) return state;
  const missing = (["history", "status"] as const).filter((step) => !state.restoreProgress?.[step]);
  return {
    ...state,
    phase: "degraded",
    replaying: false,
    bootLabel: "Session restore needs attention",
    restoreIssue: {
      missing,
      message,
      attempt: state.restoreIssue?.attempt || 1,
    },
  };
}

export function retryRestore(state: SessionViewState): SessionViewState {
  if (!state.restoreProgress) return state;
  const retryHistory = !state.restoreProgress.history;
  return {
    ...state,
    phase: "starting",
    bootLabel: retryHistory ? "Retrying conversation history" : "Retrying session status",
    replaying: retryHistory,
    restoreIssue: {
      missing: (["history", "status"] as const).filter((step) => !state.restoreProgress?.[step]),
      message: "Retrying restoration",
      attempt: (state.restoreIssue?.attempt || 1) + 1,
    },
    ...(retryHistory ? {
      blocks: [],
      lanes: {},
      pendingDelegateBriefs: {},
      outputs: [],
      liveTail: undefined,
      openThinkingId: undefined,
      nextBlock: 1,
    } : {}),
  };
}

export function openRestoreAnyway(state: SessionViewState): SessionViewState {
  if (!state.restoreProgress) return state;
  const missing = (["history", "status"] as const).filter((step) => !state.restoreProgress?.[step]);
  const label = missing.map((step) => step === "history" ? "durable history" : "runtime status").join(" and ");
  const base = state.restoreProgress.statusBusy === false ? settleIdleRestoredLanes(state) : state;
  const next = appendBlock(base, {
    kind: "notice",
    level: "warning",
    text: `Opened without complete ${label}. Missing agent completions remain marked as detached.`,
  });
  return {
    ...next,
    phase: "ready",
    replaying: false,
    busy: state.restoreProgress.statusBusy ?? false,
    bootLabel: "Session opened with incomplete restore data",
    restoreProgress: undefined,
    restoreIssue: undefined,
  };
}

export function setThinkingExpanded(state: SessionViewState, blockId: string, expanded: boolean): SessionViewState {
  return {
    ...state,
    blocks: state.blocks.map((block) => block.id === blockId && block.kind === "thinking"
      ? { ...block, expanded }
      : block),
  };
}

function checkEnvelope(state: SessionViewState, record: ProtocolRecord): SessionViewState {
  let next = state;
  if (record.schema_version !== undefined && record.schema_version !== JSONL_SCHEMA_VERSION) {
    next = appendBlock(next, {
      kind: "notice",
      level: "error",
      text: `Unsupported protocol schema ${String(record.schema_version)}`,
    });
  }
  if (record.replay === true || typeof record.sequence !== "number") return next;
  if (next.lastSequence !== undefined && record.sequence !== next.lastSequence + 1) {
    next = appendBlock(next, {
      kind: "notice",
      level: "warning",
      text: `Protocol sequence gap: expected ${next.lastSequence + 1}, received ${record.sequence}`,
    });
  }
  return { ...next, lastSequence: record.sequence };
}

function reduceEvent(state: SessionViewState, event: UIEvent, replay: boolean): SessionViewState {
  let next = state;
  if (event.kind === "agent_spawned") {
    const laneId = stringValue(event.sub_session_id, stringValue(event.session_id));
    if (!laneId) return next;
    const agent = stringValue(event.agent, "delegate");
    const brief = next.pendingDelegateBriefs[agent];
    const pendingDelegateBriefs = { ...next.pendingDelegateBriefs };
    delete pendingDelegateBriefs[agent];
    return {
      ...next,
      pendingDelegateBriefs,
      lanes: {
        ...next.lanes,
        [laneId]: {
          id: laneId,
          agent,
          status: "running",
          activity: "Booting delegate",
          tail: "",
          tailKind: "text",
          thinking: "",
          tools: [],
          events: [{
            id: `${laneId}:spawned`,
            kind: "status",
            title: "Agent started",
            detail: "Delegate session created by the coordinator",
          }],
          parentId: stringValue(event.parent_session_id, stringValue(event.session_id)),
          instruction: brief?.instruction,
          model: brief?.model,
          startedAtMs: eventTimestampMs(event),
        },
      },
      activity: `Coordinating ${runningAgentCount(next) + 1} agent${runningAgentCount(next) === 0 ? "" : "s"}`,
    };
  }
  if (event.kind === "agent_resumed") {
    const laneId = stringValue(event.session_id);
    const lane = next.lanes[laneId];
    if (!laneId || !lane) return next;
    return {
      ...next,
      activity: "Resuming delegate",
      lanes: {
        ...next.lanes,
        [laneId]: { ...lane, status: "running", activity: "Resuming work" },
      },
    };
  }
  if (event.kind === "agent_completed") {
    const laneId = stringValue(event.sub_session_id, stringValue(event.session_id));
    const lane = next.lanes[laneId];
    if (!laneId) return next;
    return {
      ...next,
      lanes: {
        ...next.lanes,
        [laneId]: {
          id: laneId,
          agent: lane?.agent || stringValue(event.agent, "delegate"),
          status: event.success === false ? "attention" : "completed",
          activity: stringValue(event.result, event.success === false ? "failed" : "complete"),
          tail: lane?.tail || "",
          tailKind: lane?.tailKind || "text",
          thinking: lane?.thinking || "",
          tools: settleRunningLaneTools(lane?.tools || [], event.success === false ? "failed" : "completed"),
          events: appendLaneEvent(lane?.events || [], {
            id: `${laneId}:completed`,
            kind: "message",
            title: event.success === false ? "Agent stopped with an issue" : "Agent completed",
            detail: stringValue(event.result, event.success === false ? "No result was returned" : "Work returned to the coordinator"),
            status: event.success === false ? "failed" : "completed",
          }),
          parentId: lane?.parentId || stringValue(event.parent_session_id),
          instruction: lane?.instruction,
          model: lane?.model,
          startedAtMs: lane?.startedAtMs,
          completedAtMs: eventTimestampMs(event),
          costUsd: lane?.costUsd,
        },
      },
      activity: event.success === false
        ? `${stringValue(event.agent, lane?.agent || "Delegate")} needs attention`
        : "Reviewing delegate results",
    };
  }

  if (isChildEvent(next, event)) return reduceLaneEvent(next, event);

  switch (event.kind) {
    case "prompt_submit": {
      const mode = stringValue(event.mode, next.mode);
      const prompt = stringValue(event.prompt);
      if (next.pendingPrompt?.text !== prompt) {
        next = appendBlock(next, { kind: "user", text: prompt, mode });
      }
      return {
        ...next,
        pendingPrompt: undefined,
        mode,
        busy: !replay,
        activity: "Starting turn",
        turnStartedAtMs: replay ? next.turnStartedAtMs : eventTimeMs(event),
        error: undefined,
        goal: next.goal?.state === "continuing" ? next.goal : undefined,
        liveTail: undefined,
        openThinkingId: undefined,
      };
    }
    case "execution_start":
      return { ...next, busy: !replay || next.busy, activity: "Waiting for model" };
    case "stream_block_start":
      return {
        ...next,
        activity: stringValue(event.block_type) === "thinking" ? "Thinking" : "Writing response",
        liveTail: { blockType: stringValue(event.block_type, "text"), text: "" },
      };
    case "stream_block_delta":
      return {
        ...next,
        liveTail: {
          blockType: next.liveTail?.blockType || stringValue(event.block_type, "text"),
          text: `${next.liveTail?.text || ""}${stringValue(event.text)}`,
        },
      };
    case "stream_block_end":
      return { ...next, activity: "Reviewing response", liveTail: undefined };
    case "stream_aborted":
      next = appendBlock(next, {
        kind: "notice",
        level: "warning",
        text: `Stream aborted${event.error_message ? `: ${stringValue(event.error_message)}` : ""}`,
      });
      return { ...next, liveTail: undefined };
    case "content_block_start": {
      const blockType = stringValue(event.block_type, "text");
      if (blockType !== "thinking") {
        return { ...next, activity: blockType === "tool_call" ? "Preparing tool call" : "Writing response" };
      }
      const openThinkingId = `b${next.nextBlock}`;
      next = appendBlock(next, { kind: "thinking", text: "", expanded: !replay });
      return { ...next, activity: "Thinking", openThinkingId };
    }
    case "content_block_end": {
      const block = typeof event.block === "object" && event.block !== null ? (event.block as Record<string, unknown>) : {};
      const blockType = stringValue(event.block_type, "text");
      const text = stringValue(block[blockType === "thinking" ? "thinking" : "text"], stringValue(block.text));
      if (blockType === "thinking") return recordThinking(next, text);
      if (!text) return { ...next, activity: "Thinking" };
      return appendBlock(next, {
        kind: "answer",
        text,
        final: false,
      } as NewTranscriptBlock);
    }
    case "tool_pre": {
      if (isDelegateTool(event)) next = rememberDelegateBrief(next, event);
      next = appendBlock(next, {
        kind: "tool",
        toolName: stringValue(event.tool_name, "tool"),
        toolCallId: stringValue(event.tool_call_id),
        status: "running",
        summary: toolSummary(event),
        detail: safeJson(event.tool_input ?? {}),
      });
      return { ...next, activity: liveToolLabel(event) };
    }
    case "tool_post": {
      const status = toolResultFailed(event) ? "failed" : "completed";
      next = forgetPendingDelegateBrief(next, stringValue(event.tool_call_id));
      return {
        ...captureOutputs(settleTool(next, event, status), event),
        activity: "Reviewing tool result",
      };
    }
    case "tool_error":
      return { ...settleTool(forgetPendingDelegateBrief(next, stringValue(event.tool_call_id)), event, "failed"), activity: `Recovering from ${displayToolName(stringValue(event.tool_name, "tool"))} error` };
    case "prompt_complete":
      next = finalizeAnswer(next, stringValue(event.response).trim());
      return { ...next, busy: replay ? false : next.busy, activity: "Finishing turn", liveTail: undefined };
    case "provider_notice":
      return appendBlock(next, {
        kind: "notice",
        level: event.notice === "error" ? "error" : "warning",
        text: `Provider ${stringValue(event.notice, "notice")}: ${stringValue(event.message)}`,
      });
    case "notification": {
      if (event.level === "decision" && stringValue(event.decision_id)) {
        return {
          ...next,
          pendingDecision: {
            decisionId: stringValue(event.decision_id),
            question: stringValue(event.question, stringValue(event.message, "Decision required")),
            reason: stringValue(event.reason),
            choices: stringList(event.choices),
            custom: event.custom === true,
          },
        };
      }
      if (isInternalRuntimeNotice(event)) return next;
      const recovery = configurationRecovery(stringValue(event.message));
      if (recovery) {
        return {
          ...next,
          alerts: upsertAlert(next.alerts, {
            id: `bundle-recovery:${recovery.requested}`,
            level: "warning",
            title: "Session recovered with a different bundle",
            message: `The saved ${recovery.requested} bundle is unavailable. Amplifier continued with ${recovery.fallback}.`,
          }),
        };
      }
      return appendBlock(next, {
        kind: "notice",
        level: noticeLevel(event.level),
        text: stringValue(event.message),
      });
    }
    case "approval_granted":
      return {
        ...next,
        activity: "Continuing after approval",
        pendingApproval: approvalMatches(next, event) ? undefined : next.pendingApproval,
      };
    case "approval_denied":
      next = appendBlock(next, {
        kind: "notice",
        level: "warning",
        text: stringValue(event.continuation, `Denied: ${stringValue(event.command, stringValue(event.prompt))}`),
      });
      return {
        ...next,
        activity: "Continuing without blocked action",
        pendingApproval: approvalMatches(next, event) ? undefined : next.pendingApproval,
      };
    case "cancel_requested":
      return appendBlock(next, { kind: "notice", level: "info", text: "Interrupt requested…" });
    case "cancel_completed":
      return { ...next, activity: "Interrupted", liveTail: undefined };
    case "context_injected":
      return { ...next, queuedSteers: Math.max(0, next.queuedSteers - 1) };
    case "context_compacted":
      return appendBlock(next, {
        kind: "notice",
        level: "info",
        text: `Context compacted: ${numberValue(event.before_tokens).toLocaleString()} → ${numberValue(event.after_tokens).toLocaleString()} tokens`,
      });
    case "goal_progress": {
      const stateName = stringValue(event.state, "continuing");
      const turn = numberValue(event.turn);
      const capValue = numberValue(event.cap);
      const reason = stringValue(event.reason) || undefined;
      const summary = stringValue(event.summary) || undefined;
      const goal = {
        state: stateName,
        turn,
        continuations: numberValue(event.continuations),
        cap: capValue > 0 ? capValue : undefined,
        reason,
        summary,
        stallDetail: stringValue(event.stall_detail) || undefined,
        updatedAtMs: eventTimeMs(event),
      };
      const label = goalLabel(stateName);
      next = {
        ...next,
        goal,
        autopilot: stateName === "continuing",
        autopilotPending: false,
        activity: stateName === "continuing"
          ? `Goal · turn ${turn}${goal.cap ? `/${goal.cap}` : ""}${reason ? ` · ${truncate(reason, 56)}` : ""}`
          : label,
      };
      if (stateName === "continuing") return next;
      const detail = summary || reason;
      return detail
        ? appendBlock(next, { kind: "notice", level: goalNoticeLevel(stateName), text: `### ${label}\n\n${detail}` })
        : next;
    }
    default:
      return next;
  }
}

function isInternalRuntimeNotice(event: UIEvent): boolean {
  const message = stringValue(event.message);
  const source = stringValue(event.source);
  return (
    /^suppressed hooks:\s*/i.test(message)
    || event.level === "debug"
    || source === "event-canary"
    || (source.startsWith("hook:") && /^blocked\s*[·:]/i.test(message))
  );
}

function isDelegateTool(event: UIEvent): boolean {
  return stringValue(event.tool_name).toLowerCase().includes("delegate");
}

function rememberDelegateBrief(state: SessionViewState, event: UIEvent): SessionViewState {
  const input = objectValue(event.tool_input);
  const agent = stringValue(input.agent, stringValue(input.agent_name));
  const instruction = stringValue(input.instruction, stringValue(input.prompt, stringValue(input.task)));
  if (!agent || !instruction) return state;
  const modelValue = input.model ?? input.model_role;
  const model = typeof modelValue === "string"
    ? modelValue
    : Array.isArray(modelValue)
      ? modelValue.filter((item): item is string => typeof item === "string").join(" → ")
      : undefined;
  return {
    ...state,
    pendingDelegateBriefs: {
      ...state.pendingDelegateBriefs,
      [agent]: {
        instruction,
        model: model || undefined,
        toolCallId: stringValue(event.tool_call_id) || undefined,
      },
    },
  };
}

function forgetPendingDelegateBrief(state: SessionViewState, toolCallId: string): SessionViewState {
  if (!toolCallId) return state;
  const pendingDelegateBriefs = Object.fromEntries(
    Object.entries(state.pendingDelegateBriefs).filter(([, brief]) => brief.toolCallId !== toolCallId),
  );
  return Object.keys(pendingDelegateBriefs).length === Object.keys(state.pendingDelegateBriefs).length
    ? state
    : { ...state, pendingDelegateBriefs };
}

function configurationRecovery(message: string): { requested: string; fallback: string } | undefined {
  const match = message.match(/stored bundle ['"]([^'"]+)['"] not found\s*[—-]+\s*resumed under ['"]([^'"]+)['"] bundle instead/i);
  return match?.[1] && match[2] ? { requested: match[1], fallback: match[2] } : undefined;
}

function upsertAlert(
  alerts: SessionViewState["alerts"],
  alert: SessionViewState["alerts"][number],
): SessionViewState["alerts"] {
  return [...alerts.filter((item) => item.id !== alert.id), alert].slice(-8);
}

function appendLaneEvent(events: LaneEventState[], event: LaneEventState): LaneEventState[] {
  return [...events.filter((item) => item.id !== event.id), event].slice(-80);
}

function settleLaneEvent(
  events: LaneEventState[],
  id: string,
  status: "completed" | "failed",
  detail: string,
): LaneEventState[] {
  const index = findLastIndex(events, (event) => event.id === id);
  if (index < 0) return appendLaneEvent(events, {
    id,
    kind: "tool",
    title: `Operation ${status}`,
    detail,
    status,
  });
  const next = [...events];
  const current = next[index];
  if (current) next[index] = { ...current, detail, status };
  return next;
}

function captureOutputs(state: SessionViewState, event: UIEvent): SessionViewState {
  if (event.kind !== "tool_post") return state;
  const paths = collectOutputPaths(event.result);
  if (!paths.length) return state;
  const toolName = stringValue(event.tool_name);
  const source = toolName ? displayToolName(toolName) : undefined;
  const additions = paths.map((path) => ({
    id: path,
    kind: outputKind(path),
    title: path.split(/[\\/]/).at(-1) || path,
    path,
    source,
    laneId: stringValue(event.parent_id) ? stringValue(event.session_id) || undefined : undefined,
    toolCallId: stringValue(event.tool_call_id) || undefined,
    eventId: stringValue(event.event_id) || undefined,
    runtimeHost: stringValue(event.runtime_host) || undefined,
  }));
  const ids = new Set(additions.map((item) => item.id));
  return { ...state, outputs: [...state.outputs.filter((item) => !ids.has(item.id)), ...additions].slice(-80) };
}

function collectOutputPaths(value: unknown, key = "", depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === "string") {
    if (!/(?:file_?path|output_?path|artifact_?path|image_?path|path)$/i.test(key)) return [];
    return /^(?:\/|[A-Za-z]:\\|\.\.?\/)/.test(value) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectOutputPaths(item, key, depth + 1));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([nestedKey, item]) => collectOutputPaths(item, nestedKey, depth + 1));
}

function outputKind(path: string): "file" | "image" | "diagram" | "data" {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "svg"].includes(extension || "")) return "image";
  if (["dot", "gv", "mermaid", "mmd"].includes(extension || "")) return "diagram";
  if (["csv", "tsv", "json", "jsonl", "parquet"].includes(extension || "")) return "data";
  return "file";
}

function reduceLaneEvent(state: SessionViewState, event: UIEvent): SessionViewState {
  const laneId = stringValue(event.session_id);
  const previous = state.lanes[laneId] || {
    id: laneId,
    agent: laneId.slice(0, 8) || "delegate",
    status: "running" as const,
    activity: "working",
    tail: "",
    tailKind: "text" as const,
    thinking: "",
    tools: [],
    events: [],
    parentId: stringValue(event.parent_id),
  };
  let activity = previous.activity;
  let tail = previous.tail;
  let tailKind = previous.tailKind;
  let thinking = previous.thinking;
  let tools = previous.tools;
  let events = previous.events || [];
  let status = previous.status;
  let model = previous.model;
  let costUsd = previous.costUsd;
  switch (event.kind) {
    case "session_start":
      activity = "Starting delegate session";
      events = appendLaneEvent(events, {
        id: stringValue(event.event_id, `${laneId}:session-start`),
        kind: "status",
        title: "Session started",
        detail: "Preparing the delegate runtime",
      });
      break;
    case "execution_start":
      activity = "Waiting for model";
      break;
    case "provider_response_usage": {
      model = stringValue(event.model) || model;
      const reportedCost = typeof event.cost_usd === "number" || typeof event.cost_usd === "string"
        ? Number(event.cost_usd)
        : Number.NaN;
      if (Number.isFinite(reportedCost)) {
        const total = Number(costUsd || 0) + reportedCost;
        costUsd = total === 0 ? "0" : total.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
      }
      activity = "Reviewing model response";
      break;
    }
    case "stream_block_start":
      tailKind = stringValue(event.block_type) === "thinking" ? "thinking" : "text";
      activity = tailKind === "thinking" ? "Thinking" : "Writing response";
      tail = "";
      break;
    case "stream_block_delta":
      tailKind = stringValue(event.block_type, tailKind) === "thinking" ? "thinking" : "text";
      tail = `${tail}${stringValue(event.text)}`.slice(-1200);
      break;
    case "stream_block_end":
      activity = "reviewing response";
      break;
    case "tool_pre": {
      const id = stringValue(event.tool_call_id);
      const item = {
        id,
        name: stringValue(event.tool_name, "tool"),
        label: liveToolLabel(event),
        status: "running" as const,
      };
      tools = upsertLaneTool(tools, item);
      events = appendLaneEvent(events, {
        id: id || stringValue(event.event_id),
        kind: "tool",
        title: item.label,
        detail: safeJson(event.tool_input ?? {}),
        status: "running",
      });
      activity = item.label;
      status = "running";
      break;
    }
    case "tool_post": {
      const failed = toolResultFailed(event);
      tools = settleLaneTool(tools, event, failed ? "failed" : "completed");
      events = settleLaneEvent(events, stringValue(event.tool_call_id), failed ? "failed" : "completed", safeJson(event.result ?? {}));
      activity = failed ? `${displayToolName(stringValue(event.tool_name, "tool"))} failed` : "Reviewing tool result";
      if (failed) status = "attention";
      break;
    }
    case "tool_error":
      tools = settleLaneTool(tools, event, "failed");
      events = settleLaneEvent(events, stringValue(event.tool_call_id), "failed", `${stringValue(event.error_type)} ${stringValue(event.error_message)}`.trim());
      activity = `Recovering from ${displayToolName(stringValue(event.tool_name, "tool"))} error`;
      status = "attention";
      break;
    case "goal_progress": {
      const stateName = stringValue(event.state, "continuing");
      const turn = numberValue(event.turn);
      const cap = numberValue(event.cap);
      const reason = stringValue(event.summary, stringValue(event.reason));
      const label = stateName === "continuing"
        ? `Goal turn ${turn}${cap > 0 ? `/${cap}` : ""}`
        : goalLabel(stateName);
      activity = reason ? `${label} · ${truncate(reason, 64)}` : label;
      events = appendLaneEvent(events, {
        id: stringValue(event.event_id, `${laneId}:goal:${events.length}`),
        kind: "status",
        title: label,
        detail: reason || stringValue(event.stall_detail),
        status: stateName === "continuing" ? "running" : stateName.includes("achiev") ? "completed" : "failed",
      });
      if (stateName !== "continuing" && !stateName.includes("achiev")) status = "attention";
      break;
    }
    case "content_block_end": {
      const block = typeof event.block === "object" && event.block !== null ? (event.block as Record<string, unknown>) : {};
      const blockType = stringValue(event.block_type, "text");
      if (blockType === "thinking") {
        thinking = stringValue(block.thinking, stringValue(block.text, thinking)).slice(-4000);
        events = appendLaneEvent(events, {
          id: stringValue(event.event_id, `${laneId}:thinking:${events.length}`),
          kind: "thinking",
          title: "Reasoning",
          detail: thinking || "Reasoning was withheld by the provider",
        });
        tail = "";
        tailKind = "thinking";
        activity = "Thinking";
      } else {
        tail = stringValue(block.text, tail).slice(-1200);
        if (tail) events = appendLaneEvent(events, {
          id: stringValue(event.event_id, `${laneId}:message:${events.length}`),
          kind: "message",
          title: "Agent response",
          detail: tail,
        });
        tailKind = "text";
        activity = "Reporting findings";
      }
      break;
    }
    case "orchestrator_complete":
      activity = "Wrapping up";
      break;
    case "approval_required":
      activity = `Approval needed · ${truncate(stringValue(event.prompt, "tool approval"), 52)}`;
      status = "attention";
      break;
    case "approval_granted":
      activity = "Approval granted · continuing";
      status = "running";
      break;
    case "approval_denied":
      activity = `Blocked · ${truncate(stringValue(event.command, stringValue(event.prompt, "tool")), 52)}`;
      status = "attention";
      break;
  }
  return {
    ...captureOutputs(state, event),
    activity: summarizeParallelWork(state, laneId, { ...previous, activity, tail, tailKind, thinking, tools, events, status, model, costUsd }),
    lanes: {
      ...state.lanes,
      [laneId]: { ...previous, activity, tail, tailKind, thinking, tools, events, status, model, costUsd },
    },
  };
}

function reduceSessionStatus(state: SessionViewState, record: ProtocolRecord): SessionViewState {
  const turn = objectValue(record.turn);
  const session = objectValue(record.session);
  const pending = objectValue(record.pending);
  const approval = objectValue(pending.approval);
  const decisions = Array.isArray(pending.decisions)
    ? pending.decisions.filter(isRecord)
    : [];
  const firstDecision = decisions[0];
  const context = objectValue(record.context);
  const turnActive = turn.active === true;
  const stateName = stringValue(record.state);

  const pendingApproval = stringValue(approval.ticket_id)
      ? {
        ticketId: stringValue(approval.ticket_id),
        prompt: stringValue(approval.prompt, "Amplifier needs approval"),
        options: stringList(approval.options),
        sessionId: stringValue(approval.session_id) || undefined,
        parentId: stringValue(approval.parent_id) || undefined,
        toolCallId: stringValue(approval.tool_call_id) || undefined,
      }
    : undefined;
  const decisionId = stringValue(firstDecision?.decision_id);
  const pendingDecision = decisionId
    ? state.pendingDecision?.decisionId === decisionId
      ? state.pendingDecision
      : {
          decisionId,
          question: stringValue(firstDecision?.question, "Amplifier needs your input"),
          reason: "",
          choices: [],
          custom: false,
        }
    : undefined;

  const effort = stringValue(session.effort, state.effort);
  const next: SessionViewState = {
    ...state,
    busy: turnActive,
    activity: statusActivity(stateName, turnActive, state.activity),
    turnStartedAtMs: turnActive ? state.turnStartedAtMs ?? Date.now() : undefined,
    pendingApproval,
    pendingDecision,
    queuedSteers: numberValue(turn.queued_steers, state.queuedSteers),
    bundle: stringValue(session.bundle, state.bundle),
    model: stringValue(session.model, state.model),
    effort,
    effortPending: effort && effort === state.effortPending ? undefined : state.effortPending,
    context: {
      tokens: numberValue(context.context_tokens, state.context.tokens),
      window: numberValue(context.context_window, state.context.window),
      percent: numberValue(context.context_pct, state.context.percent),
      costUsd: String(context.cost_usd ?? state.context.costUsd),
    },
  };
  return pendingApproval ? markLaneAwaitingApproval(next, {
    sessionId: pendingApproval.sessionId,
    toolCallId: pendingApproval.toolCallId,
    prompt: pendingApproval.prompt,
  }) : next;
}

function markRestoreProgress(
  state: SessionViewState,
  step: keyof NonNullable<SessionViewState["restoreProgress"]>,
): SessionViewState {
  if (!state.restoreProgress) {
    return step === "history"
      ? { ...state, replaying: false, phase: "ready", bootLabel: "History restored" }
      : state;
  }

  const restoreProgress = { ...state.restoreProgress, [step]: true };
  const restored = restoreProgress.history && restoreProgress.status;
  const restoredState: SessionViewState = {
    ...state,
    restoreProgress,
    replaying: !restoreProgress.history,
    phase: restored ? "ready" : state.phase === "degraded" ? "degraded" : "starting",
    busy: restored && restoreProgress.statusBusy !== undefined
      ? restoreProgress.statusBusy
      : state.busy,
    bootLabel: restored
      ? "Session restored"
      : state.phase === "degraded"
        ? state.bootLabel
        : restoreProgress.history
          ? "Restoring model, context, and spend"
          : "Restoring conversation history",
    restoreIssue: restored ? undefined : state.restoreIssue,
  };
  return restored && restoreProgress.statusBusy === false
    ? settleIdleRestoredLanes(restoredState)
    : restoredState;
}

function markRestoreStatus(state: SessionViewState): SessionViewState {
  if (!state.restoreProgress) return state;
  return markRestoreProgress({
    ...state,
    restoreProgress: { ...state.restoreProgress, statusBusy: state.busy },
  }, "status");
}

function settleIdleRestoredLanes(state: SessionViewState): SessionViewState {
  return {
    ...state,
    lanes: Object.fromEntries(Object.entries(state.lanes).map(([laneId, lane]) => [
      laneId,
      lane.status === "running"
        ? {
            ...lane,
            status: "detached" as const,
            activity: "Completion was not recorded in durable history",
            tools: lane.tools.map((tool) => tool.status === "running" ? { ...tool, status: "unknown" as const } : tool),
            events: lane.events.map((event) => event.status === "running" ? { ...event, status: "unknown" as const } : event),
          }
        : lane,
    ])),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function statusActivity(stateName: string, turnActive: boolean, current: string): string {
  switch (stateName) {
    case "awaiting_approval": return "Waiting for approval";
    case "awaiting_decision": return "Waiting for your decision";
    case "paused": return "Session paused";
    case "busy": return current && current !== "Idle" ? current : "Working";
    case "idle": return "Idle";
    default: return turnActive ? current || "Working" : "Idle";
  }
}

function approvalMatches(state: SessionViewState, event: UIEvent): boolean {
  if (!state.pendingApproval) return false;
  const ticketId = stringValue(event.ticket_id);
  return Boolean(ticketId && ticketId === state.pendingApproval.ticketId);
}

function markLaneAwaitingApproval(
  state: SessionViewState,
  identity: { sessionId?: string; toolCallId?: string; prompt: string },
): SessionViewState {
  const lanes = Object.values(state.lanes);
  const matching = (identity.sessionId && state.lanes[identity.sessionId])
    || (identity.toolCallId
      ? lanes.find((lane) => lane.tools.some((tool) => tool.id === identity.toolCallId))
      : undefined);
  if (!matching) return state;
  return {
    ...state,
    lanes: {
      ...state.lanes,
      [matching.id]: {
        ...matching,
        status: "attention",
        activity: `Approval needed · ${truncate(identity.prompt || "tool approval", 52)}`,
      },
    },
  };
}

function recordThinking(state: SessionViewState, text: string): SessionViewState {
  if (!state.openThinkingId) {
    return { ...appendBlock(state, { kind: "thinking", text, expanded: false }), activity: "Thinking" };
  }
  const index = state.blocks.findIndex((block) => block.id === state.openThinkingId);
  if (index < 0) {
    return {
      ...appendBlock(state, { kind: "thinking", text, expanded: false }),
      activity: "Thinking",
      openThinkingId: undefined,
    };
  }
  const blocks = [...state.blocks];
  const previous = blocks[index];
  blocks[index] = {
    id: state.openThinkingId,
    kind: "thinking",
    text,
    expanded: previous?.kind === "thinking" ? previous.expanded : false,
  };
  return { ...state, blocks, activity: "Thinking", openThinkingId: undefined };
}

function upsertLaneTool(tools: LaneToolState[], item: LaneToolState): LaneToolState[] {
  const without = tools.filter((tool) => tool.id !== item.id);
  return [...without, item].slice(-6);
}

function settleLaneTool(
  tools: LaneToolState[],
  event: UIEvent,
  status: "completed" | "failed",
): LaneToolState[] {
  const id = stringValue(event.tool_call_id);
  const index = tools.findIndex((tool) => tool.id === id);
  if (index < 0) {
    return upsertLaneTool(tools, {
      id,
      name: stringValue(event.tool_name, "tool"),
      label: `${displayToolName(stringValue(event.tool_name, "tool"))} ${status}`,
      status,
    });
  }
  const next = [...tools];
  const item = next[index];
  if (item) next[index] = { ...item, status };
  return next;
}

function settleRunningLaneTools(
  tools: LaneToolState[],
  status: "completed" | "failed",
): LaneToolState[] {
  return tools.map((tool) => tool.status === "running" ? { ...tool, status } : tool);
}

function summarizeParallelWork(state: SessionViewState, laneId: string, lane: LaneState): string {
  const lanes = { ...state.lanes, [laneId]: lane };
  const running = Object.values(lanes).filter((item) => item.status === "running");
  const operations = running.reduce(
    (count, item) => count + item.tools.filter((tool) => tool.status === "running").length,
    0,
  );
  if (!running.length) return state.activity;
  const agentLabel = `${running.length} agent${running.length === 1 ? "" : "s"}`;
  return operations
    ? `Coordinating ${agentLabel} · ${operations} operation${operations === 1 ? "" : "s"}`
    : `Coordinating ${agentLabel}`;
}

function runningAgentCount(state: SessionViewState): number {
  return Object.values(state.lanes).filter((lane) => lane.status === "running").length;
}

function toolResultFailed(event: UIEvent): boolean {
  const result = objectValue(event.result);
  const status = stringValue(result.status).toLowerCase();
  return result.success === false || ["denied", "error", "failed"].includes(status) || Boolean(result.error);
}

function liveToolLabel(event: UIEvent): string {
  const tool = stringValue(event.tool_name, "tool");
  const input = objectValue(event.tool_input);
  const target = toolTarget(tool, input);
  const verbs: Record<string, string> = {
    bash: "Running",
    shell: "Running",
    read_file: "Reading",
    write_file: "Writing",
    edit_file: "Editing",
    apply_patch: "Editing",
    multi_edit: "Editing",
    grep: "Searching",
    glob: "Finding files",
    search: "Searching",
    web_fetch: "Fetching",
    web_search: "Searching web",
    load_skill: "Loading skill",
    delegate: "Delegating",
  };
  return truncate(`${verbs[tool] || `Using ${displayToolName(tool)}`} ${target}`.trim(), 84);
}

function toolTarget(tool: string, input: Record<string, unknown>): string {
  if (tool === "bash" || tool === "shell") return stringValue(input.command).replaceAll("\n", " ");
  for (const key of ["file_path", "path", "filename", "pattern", "query", "url", "skill", "name"]) {
    const value = stringValue(input[key]);
    if (value) return value;
  }
  return "";
}

function displayToolName(tool: string): string {
  return tool.replaceAll("_", " ");
}

function truncate(value: string, length: number): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length <= length ? clean : `${clean.slice(0, length - 1)}…`;
}

function eventTimeMs(event: UIEvent): number {
  const timestamp = numberValue(event.ts);
  return timestamp > 0 ? timestamp * 1000 : Date.now();
}

function eventTimestampMs(event: UIEvent): number | undefined {
  return typeof event.ts === "number" && Number.isFinite(event.ts) && event.ts > 0
    ? event.ts * 1000
    : undefined;
}

function settleTool(
  state: SessionViewState,
  event: UIEvent,
  status: "completed" | "failed",
): SessionViewState {
  const callId = stringValue(event.tool_call_id);
  const index = findLastIndex(
    state.blocks,
    (block) => block.kind === "tool" && block.toolCallId === callId,
  );
  const detail =
    status === "failed"
      ? `${stringValue(event.error_type)} ${stringValue(event.error_message)}`.trim()
      : safeJson(event.result ?? {});
  if (index < 0) {
    return appendBlock(state, {
      kind: "tool",
      toolName: stringValue(event.tool_name, "tool"),
      toolCallId: callId,
      status,
      summary: `${stringValue(event.tool_name, "tool")} ${status}`,
      detail,
    });
  }
  const block = state.blocks[index];
  if (block.kind !== "tool") return state;
  const blocks = [...state.blocks];
  blocks[index] = { ...block, status, summary: `${block.toolName} ${status}`, detail };
  return { ...state, blocks };
}

function finalizeAnswer(state: SessionViewState, response: string): SessionViewState {
  if (!response) return state;
  const index = findLastIndex(
    state.blocks,
    (block) => block.kind === "answer" && block.text.trim() === response,
  );
  if (index < 0) return appendBlock(state, { kind: "answer", text: response, final: true });
  const block = state.blocks[index];
  if (block.kind !== "answer" || block.final) return state;
  const blocks = [...state.blocks];
  blocks[index] = { ...block, final: true };
  return { ...state, blocks };
}

function appendBlock(state: SessionViewState, block: NewTranscriptBlock): SessionViewState {
  const complete = { ...block, id: `b${state.nextBlock}` } as TranscriptBlock;
  return { ...state, blocks: [...state.blocks, complete], nextBlock: state.nextBlock + 1 };
}

function isChildEvent(state: SessionViewState, event: UIEvent): boolean {
  const sessionId = stringValue(event.session_id);
  return Boolean(
    sessionId &&
      state.runtimeSessionId &&
      sessionId !== state.runtimeSessionId &&
      (event.parent_id || state.lanes[sessionId]),
  );
}

function toolSummary(event: UIEvent): string {
  const tool = stringValue(event.tool_name, "tool");
  const input = typeof event.tool_input === "object" && event.tool_input !== null ? (event.tool_input as Record<string, unknown>) : {};
  const target = stringValue(input.path, stringValue(input.command, stringValue(input.query)));
  return target ? `${tool} · ${target.slice(0, 120)}` : tool;
}

function noticeLevel(value: unknown): "info" | "warning" | "error" | "success" {
  if (value === "error") return "error";
  if (value === "warning" || value === "warn") return "warning";
  if (value === "success") return "success";
  return "info";
}

function goalLabel(state: string): string {
  const labels: Record<string, string> = {
    achieved: "Goal met",
    cap_hit: "Goal unconfirmed · turn cap reached",
    stalled: "Goal not met · stalled",
    cancelled: "Goal unconfirmed · cancelled",
    error: "Goal unconfirmed · evaluation failed",
  };
  return labels[state] || "Goal progress updated";
}

function goalNoticeLevel(state: string): "info" | "warning" | "error" | "success" {
  if (state === "achieved") return "success";
  if (state === "stalled" || state === "error") return "error";
  if (state === "cap_hit" || state === "cancelled") return "warning";
  return "info";
}

function bootMessage(action: string, detail: string): string {
  const actionText = action ? action.replaceAll("_", " ") : "Preparing";
  return detail ? `${capitalize(actionText)} · ${detail}` : capitalize(actionText);
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}
