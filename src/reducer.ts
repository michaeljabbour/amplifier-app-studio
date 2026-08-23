import {
  asEvent,
  DEFAULT_EFFORT_LEVELS,
  isRecord,
  JSONL_SCHEMA_VERSION,
  type LaneEventState,
  type LaneState,
  type LaneToolState,
  type ComposerAttachment,
  type PlanItemState,
  type PipelineNodeState,
  type PipelineState,
  numberValue,
  type ProtocolRecord,
  safeJson,
  type SessionViewState,
  stringList,
  stringValue,
  type TurnLoopPhase,
  type TurnLoopState,
  type TranscriptBlock,
  type UIEvent,
} from "./protocol";
import { estimateRunPodCost, mergeCostBasis, type CostBasis } from "./costEstimate";
import { splitDocumentAttachments } from "./attachments";

type NewTranscriptBlock = TranscriptBlock extends infer Block
  ? Block extends { id: string }
    ? Omit<Block, "id">
    : never
  : never;

export function createSessionState(
  guiId: string,
  input: {
    projectDir: string;
    hostId?: string;
    hostName?: string;
    hostUrl?: string;
    bundle?: string;
    model?: string;
    provider?: string;
    mode?: string;
    resumeId?: string;
    resumeName?: string;
    expectedHistoryMessages?: number;
    expectedHistoryEvents?: number;
    capabilityId?: string;
    capabilityName?: string;
  },
): SessionViewState {
  return {
    guiId,
    hostId: input.hostId,
    hostName: input.hostName,
    hostUrl: input.hostUrl,
    capabilityId: input.capabilityId,
    capabilityName: input.capabilityName,
    projectDir: input.projectDir,
    requestedBundle: input.bundle,
    requestedModel: input.model,
    requestedProvider: input.provider,
    resumeId: input.resumeId,
    expectedHistoryMessages: input.expectedHistoryMessages,
    expectedHistoryEvents: input.expectedHistoryEvents,
    title: usableSessionTitle(input.resumeName)
      || input.capabilityName
      || (input.resumeId ? "Restoring saved work" : "New session"),
    bundle: input.bundle || "default bundle",
    model: "starting…",
    mode: input.mode || "auto",
    phase: "starting",
    bootLabel: input.resumeId ? "Restoring session" : "Launching runtime",
    busy: false,
    composerDraft: "",
    composerAttachments: [],
    autopilot: false,
    autopilotPending: false,
    activity: "Starting turn",
    replaying: Boolean(input.resumeId),
    replayedTranscriptMessageIds: new Set(),
    acceptedReplayTranscriptMessages: 0,
    acceptedReplayEvents: 0,
    restoreProgress: input.resumeId ? { history: false, status: false } : undefined,
    context: emptyContext(),
    effortLevels: [...DEFAULT_EFFORT_LEVELS],
    blocks: [],
    lanes: {},
    pendingDelegateBriefs: {},
    plans: {},
    turnLoop: emptyTurnLoop(),
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
        title: next.resumeId || next.capabilityName || next.title !== "New session"
          ? next.title
          : "Ready for your first prompt",
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
    case "runtime.capabilities": {
      const protocol = isRecord(record.protocol) ? record.protocol : {};
      const rawOperations = isRecord(record.operations) ? record.operations : {};
      const operations: Record<string, string> = {};
      for (const [name, value] of Object.entries(rawOperations)) {
        if (isRecord(value) && typeof value.permission === "string") operations[name] = value.permission;
      }
      return {
        ...next,
        runtimeCapabilities: {
          protocolVersion: numberValue(protocol.version),
          features: stringList(record.features),
          operations,
        },
      };
    }
    case "runtime.event": {
      const event = asEvent(record.event);
      if (!event) return next;
      if (record.replay === true) {
        next = { ...next, acceptedReplayEvents: (next.acceptedReplayEvents || 0) + 1 };
      }
      return reduceEvent(next, event, record.replay === true);
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
          expiresAtMs: expiryFromRecord(record),
          defaultChoice: stringValue(record.default_choice) || undefined,
        },
      }, {
        sessionId: stringValue(record.session_id),
        toolCallId: stringValue(record.tool_call_id),
        prompt: stringValue(record.prompt),
      });
    case "approval.result": {
      if (record.ok !== false) return next;
      const ticketId = stringValue(record.ticket_id);
      const error = stringValue(record.error, "Amplifier did not accept that approval response");
      const pendingApproval = next.pendingApproval?.ticketId === ticketId
        ? { ...next.pendingApproval, submissionError: error }
        : next.pendingApproval;
      return appendBlock({ ...next, pendingApproval }, {
        kind: "notice",
        level: "error",
        text: `Approval not accepted: ${error}`,
      });
    }
    case "decision.result": {
      if (record.ok !== false) return next;
      const decisionId = stringValue(record.decision_id);
      const error = stringValue(record.error, "Amplifier did not accept that decision");
      const pendingDecision = next.pendingDecision?.decisionId === decisionId
        ? { ...next.pendingDecision, submissionError: error }
        : next.pendingDecision;
      return appendBlock({ ...next, pendingDecision }, {
        kind: "notice",
        level: "error",
        text: `Decision not accepted: ${error}`,
      });
    }
    case "context.state":
      return {
        ...next,
        context: contextFromRecord(next.context, record),
      };
    case "effort.state": {
      const effort = typeof record.effort === "string" ? record.effort : next.effort;
      const levels = stringList(record.levels);
      const reconciled = {
        ...next,
        effort,
        effortLevels: levels.length ? levels : next.effortLevels,
        effortPending: undefined,
        effortConfirmedAtMs: record.ok === false ? next.effortConfirmedAtMs : Date.now(),
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
        restoreSource: historySource(record.source),
        acceptedReplayTranscriptMessages: 0,
        acceptedReplayEvents: 0,
        restoredEventCount: undefined,
        indexedHistoryRecords: undefined,
        archivedMetadata: undefined,
        phase: next.restoreProgress && next.phase !== "degraded" ? "starting" : next.phase,
        bootLabel: "Replaying durable history",
      };
    case "history.metadata": {
      if (record.replay !== true || !isRecord(record.metadata)) return next;
      const metadata = record.metadata;
      const permission = isRecord(metadata.permission_profile) ? metadata.permission_profile : undefined;
      const outcomes = Array.isArray(metadata.outcome_ledger)
        ? metadata.outcome_ledger.filter(isRecord).map((outcome) => ({
            turnId: optionalString(outcome.turn_id),
            checkpointId: optionalString(outcome.checkpoint_id),
            costUsd: optionalMoney(outcome.cost),
            elapsedSeconds: optionalFiniteNumber(outcome.elapsed_seconds),
            tokens: optionalFiniteNumber(outcome.tokens),
            cachedPercent: optionalFiniteNumber(outcome.cached_percent),
            interrupted: typeof outcome.interrupted === "boolean" ? outcome.interrupted : undefined,
            yields: Array.isArray(outcome.yields)
              ? outcome.yields.filter(isRecord).map((item) => ({
                  kind: stringValue(item.kind),
                  label: stringValue(item.label),
                })).filter((item) => item.kind || item.label)
              : [],
          }))
        : [];
      return {
        ...next,
        title: stringValue(metadata.name, next.title),
        bundle: stringValue(metadata.bundle, next.bundle),
        model: stringValue(metadata.model, next.model),
        mode: stringValue(metadata.active_mode, stringValue(metadata.ui_mode, next.mode)),
        archivedMetadata: {
          description: optionalString(metadata.description),
          createdAt: optionalString(metadata.created),
          updatedAt: optionalString(metadata.updated),
          turnCount: optionalFiniteNumber(metadata.turn_count),
          totalCostUsd: optionalMoney(metadata.session_cost_usd),
          permissionPosture: optionalString(metadata.permission_posture),
          permissionProfile: permission ? {
            name: optionalString(permission.name),
            auto: stringList(permission.auto),
            ask: stringList(permission.ask),
            block: stringList(permission.block),
            classifierGated: typeof permission.classifier_gated === "boolean"
              ? permission.classifier_gated
              : undefined,
          } : undefined,
          outcomes,
        },
      };
    }
    case "transcript.message": {
      const text = stringValue(record.text).trim();
      if (!text || record.replay !== true) return next;
      const messageId = stringValue(record.message_id).trim();
      if (messageId && next.replayedTranscriptMessageIds?.has(messageId)) return next;
      // Carried by reference and mutated rather than rebuilt: see the note on the field. The
      // enclosing state object is still replaced, so reactivity is unaffected.
      const replayedTranscriptMessageIds = next.replayedTranscriptMessageIds ?? new Set<string>();
      if (messageId) replayedTranscriptMessageIds.add(messageId);
      const acceptedReplayTranscriptMessages = (next.acceptedReplayTranscriptMessages || 0) + 1;
      if (record.role === "user") {
        return appendBlock({ ...next, replayedTranscriptMessageIds, acceptedReplayTranscriptMessages }, { kind: "user", text, mode: next.mode });
      }
      if (record.role === "assistant") {
        return appendBlock({ ...next, replayedTranscriptMessageIds, acceptedReplayTranscriptMessages }, { kind: "answer", text, final: true });
      }
      return next;
    }
    case "history.end": {
      // The next live record will not follow the pre-replay sequence; re-baseline on it.
      next = { ...next, sequenceResyncPending: true };
      const expectedMessages = Math.max(0, next.expectedHistoryMessages || 0);
      const expectedEvents = Math.max(0, next.expectedHistoryEvents || 0);
      const replayedEvents = Math.max(0, numberValue(record.count));
      const hasReportedEventCount = typeof record.count === "number" && Number.isFinite(record.count);
      const replayedTranscript = Math.max(0, numberValue(record.transcript_count));
      const acceptedTranscript = Math.max(0, next.acceptedReplayTranscriptMessages || 0);
      const acceptedEvents = Math.max(0, next.acceptedReplayEvents || 0);
      const indexedRecords = Math.max(0, numberValue(record.indexed_record_count, replayedEvents));
      const hasVisibleConversation = next.blocks.some((block) => block.kind === "user" || block.kind === "answer");
      if (
        next.restoreProgress
        && expectedMessages > 0
        && !hasVisibleConversation
      ) {
        const delivery = replayedEvents || replayedTranscript
          ? `The runtime reported ${replayedEvents} durable event${replayedEvents === 1 ? "" : "s"} and ${replayedTranscript} transcript message${replayedTranscript === 1 ? "" : "s"}, but delivered no visible conversation.`
          : "The active session owner returned no replayable history.";
        return markRestoreDegraded(
          next,
          `Amplifier found ${expectedMessages} saved transcript record${expectedMessages === 1 ? "" : "s"}. ${delivery} It may still be running an older runtime. Restart the Studio window or runtime that owns this session, then retry the restore.`,
        );
      }
      if (
        next.restoreProgress
        && replayedTranscript > 0
        && acceptedTranscript !== replayedTranscript
      ) {
        return markRestoreDegraded(
          next,
          `The runtime reported ${replayedTranscript} transcript message${replayedTranscript === 1 ? "" : "s"}, but Studio accepted ${acceptedTranscript}. The conversation replay is incomplete; retry the restore before continuing.`,
        );
      }
      if (
        next.restoreProgress
        && record.source !== "transcript"
        && hasReportedEventCount
        && acceptedEvents !== replayedEvents
      ) {
        return markRestoreDegraded(
          next,
          `The runtime reported ${replayedEvents} durable event${replayedEvents === 1 ? "" : "s"}, but Studio accepted ${acceptedEvents}. The visual history replay is incomplete; retry the restore before continuing.`,
        );
      }
      if (
        next.restoreProgress
        && record.source !== "transcript"
        && expectedEvents > 0
        && indexedRecords < expectedEvents
      ) {
        return markRestoreDegraded(
          next,
          `Studio indexed ${expectedEvents} durable record${expectedEvents === 1 ? "" : "s"} before resume, but the runtime found ${indexedRecords}. The visual history is incomplete; restart the compute host and retry the restore.`,
        );
      }
      const archivedCost = optionalMoney(next.archivedMetadata?.totalCostUsd);
      // The persisted session total is the runtime's authoritative accounting
      // checkpoint. Replayed usage events are still valuable for token/model
      // attribution, but older logs may contain only a subset of priced model
      // responses. Seed the live meter from the saved total; later live usage
      // events add to it normally.
      const context = archivedCost && Number(archivedCost) > 0
        ? { ...next.context, costUsd: archivedCost, costBasis: "reported" as const }
        : next.context;
      return markRestoreProgress({
        ...next,
        context,
        restoreSource: historySource(record.source, next.restoreSource),
        restoredTranscriptMessages: replayedTranscript > 0
          ? replayedTranscript
          : next.restoredTranscriptMessages,
        restoredEventCount: replayedEvents,
        indexedHistoryRecords: indexedRecords,
      }, "history");
    }
    case "steer.deferred": {
      const count = Math.max(1, numberValue(record.count, 1));
      return appendBlock({ ...next, busy: true, activity: "Continuing with your course correction" }, {
        kind: "notice",
        level: "info",
        text: count === 1
          ? "Your course correction arrived after the last model boundary. Amplifier is continuing with it as a follow-up turn."
          : `${count} course corrections arrived after the last model boundary. Amplifier is continuing with them as follow-up turns.`,
      });
    }
    case "turn.completed": {
      const response = stringValue(record.response).trim();
      next = finalizeAnswer(next, response);
      if (next.queuedSteers > 0) {
        next = appendBlock(next, {
          kind: "notice",
          level: "warning",
          text: `${next.queuedSteers} course correction${next.queuedSteers === 1 ? " was" : "s were"} not confirmed by the runtime. The text remains in chat so you can retry it.`,
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

export function setComposerAttachments(state: SessionViewState, attachments: ComposerAttachment[]): SessionViewState {
  return { ...state, composerAttachments: attachments };
}

export function markSteerSubmitted(
  state: SessionViewState,
  text: string,
  attachments: ComposerAttachment[] = [],
): SessionViewState {
  const steer = text.trim();
  if (!steer) return state;
  const next = appendBlock(state, {
    kind: "user",
    text: steer,
    mode: "steer",
    attachments: attachments.length ? attachments : undefined,
  });
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
  attachments: ComposerAttachment[] = [],
  runtimeText = text,
): SessionViewState {
  const prompt = text.trim();
  if (!prompt) return state;
  const next = appendBlock(state, {
    kind: "user",
    text: prompt,
    mode: state.mode,
    attachments: attachments.length ? attachments : undefined,
  });
  return {
    ...next,
    pendingPrompt: { text: prompt, runtimeText, mode: state.mode },
    busy: true,
    activity: "Submitting prompt",
    // The elapsed clock starts only after a runtime event or status record
    // confirms the turn. An optimistic local echo is not runtime acceptance.
    turnStartedAtMs: undefined,
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
  const restoreProgress = retryHistory
    ? { history: false, status: false }
    : state.restoreProgress;
  return {
    ...state,
    restoreProgress,
    phase: "starting",
    bootLabel: retryHistory ? "Retrying conversation history" : "Retrying session status",
    replaying: retryHistory,
    restoreIssue: {
      missing: (["history", "status"] as const).filter((step) => !restoreProgress[step]),
      message: "Retrying restoration",
      attempt: (state.restoreIssue?.attempt || 1) + 1,
    },
    ...(retryHistory ? {
      blocks: [],
      lanes: {},
      pendingDelegateBriefs: {},
      plans: {},
      pipeline: undefined,
      outputs: [],
      alerts: [],
      context: emptyContext(),
      turnLoop: emptyTurnLoop(),
      pendingApproval: undefined,
      pendingDecision: undefined,
      restoreSource: undefined,
      restoredTranscriptMessages: undefined,
      restoredEventCount: undefined,
      indexedHistoryRecords: undefined,
      archivedMetadata: undefined,
      replayedTranscriptMessageIds: new Set(),
      acceptedReplayTranscriptMessages: 0,
      acceptedReplayEvents: 0,
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
  // A replay does not advance the live wire-order counter, so the first live record after one
  // legitimately jumps. Warning about that gap blamed the runtime for Studio's own reconnect and
  // gave the user nothing to act on. Re-baseline silently once, then resume gap detection.
  if (next.sequenceResyncPending) {
    return { ...next, lastSequence: record.sequence, sequenceResyncPending: undefined };
  }
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
  // A declared pipeline belongs to one turn. Start every new prompt from the
  // generic observed loop; a Resolve/Attractor turn will replace it when its
  // own `pipeline_started` event supplies the authoritative topology.
  if (event.kind === "prompt_submit") next = { ...next, pipeline: undefined };
  if (event.kind === "provider_response_usage") {
    next = recordSessionUsage(next, event);
  }
  const planKeyBefore = planKeyForCall(next, stringValue(event.tool_call_id));
  const planLifecycle = isTodoTool(event) || Boolean(planKeyBefore);
  if (planLifecycle) next = reducePlanEvent(next, event);
  const planTracked = event.kind === "tool_pre"
    ? Boolean(planKeyForCall(next, stringValue(event.tool_call_id)))
    : Boolean(planKeyBefore);
  if (isPipelineEvent(event)) return reducePipelineEvent(next, event);
  if (!isChildEvent(next, event)) next = reduceTurnLoopEvent(next, event);
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
          costBasis: lane?.costBasis,
        },
      },
      activity: event.success === false
        ? `${stringValue(event.agent, lane?.agent || "Delegate")} needs attention`
        : "Reviewing delegate results",
    };
  }

  if (isChildEvent(next, event)) return reduceLaneEvent(next, event, planLifecycle, planTracked);

  switch (event.kind) {
    case "prompt_submit": {
      const mode = stringValue(event.mode, next.mode);
      const prompt = stringValue(event.prompt);
      const decoded = splitDocumentAttachments(prompt);
      const reconcilesPending = next.pendingPrompt?.runtimeText === prompt || next.pendingPrompt?.text === decoded.text;
      const reconcilesQueuedSteer = next.queuedSteers > 0 && next.blocks
        .filter((block): block is Extract<TranscriptBlock, { kind: "user" }> => block.kind === "user" && block.mode === "steer")
        .slice(-next.queuedSteers)
        .some((block) => block.text.trim() === decoded.text.trim());
      if (!reconcilesPending && !reconcilesQueuedSteer) {
        next = appendBlock(next, {
          kind: "user",
          text: decoded.text,
          mode,
          attachments: decoded.attachments.length ? decoded.attachments : undefined,
        });
      }
      const derivedTitle = shouldDeriveSessionTitle(next.title)
        ? promptSessionTitle(decoded.text)
        : undefined;
      return {
        ...next,
        title: derivedTitle || next.title,
        pendingPrompt: undefined,
        queuedSteers: reconcilesQueuedSteer ? Math.max(0, next.queuedSteers - 1) : next.queuedSteers,
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
      if (planLifecycle) return planTracked ? { ...next, activity: "Plan steps updated" } : next;
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
      if (planLifecycle) {
        return planTracked ? {
          ...next,
          activity: toolResultFailed(event) ? "Plan update needs attention" : "Plan steps updated",
        } : next;
      }
      const status = toolResultFailed(event) ? "failed" : "completed";
      next = forgetPendingDelegateBrief(next, stringValue(event.tool_call_id));
      next = settleTool(next, event, status);
      const turnArtifacts = outputArtifacts(event);
      next = captureOutputs(next, event);
      for (const artifact of turnArtifacts) {
        const output = next.outputs.find((candidate) => candidate.id === artifact.path);
        if (output?.kind === "image") {
          next = appendBlock(next, { kind: "output", output });
        }
      }
      return {
        ...next,
        activity: "Reviewing tool result",
      };
    }
    case "tool_error":
      if (planLifecycle) return planTracked ? { ...next, activity: "Plan update needs attention" } : next;
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
        const choices = stringList(event.choices);
        return {
          ...next,
          pendingDecision: {
            decisionId: stringValue(event.decision_id),
            question: stringValue(event.question, stringValue(event.message, "Decision required")),
            reason: stringValue(event.reason),
            choices,
            descriptions: stringList(event.descriptions),
            recommendedChoice: recommendedDecisionChoice(choices),
            multiple: event.multiple === true,
            custom: event.custom === true,
            createdAtMs: eventTimestampMs(event),
          },
        };
      }
      if (stringValue(event.source) === "recipe") {
        return reduceRecipeNotification(next, stringValue(event.message), noticeLevel(event.level));
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
      next = appendBlock(next, {
        kind: "notice",
        level: "success",
        text: `Approval recorded: ${stringValue(event.choice, "Allow once")}${stringValue(event.prompt) ? `\n${stringValue(event.prompt)}` : ""}`,
      });
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
    case "decision_answered": {
      const decisionId = stringValue(event.decision_id);
      const answer = stringValue(event.answer, "Answer recorded");
      const question = stringValue(event.question);
      next = appendBlock(next, {
        kind: "notice",
        level: "success",
        text: `Decision recorded: ${answer}${question ? `\n${question}` : ""}`,
      });
      return {
        ...next,
        activity: "Decision recorded · waiting for Amplifier to apply it",
        pendingDecision: next.pendingDecision?.decisionId === decisionId ? undefined : next.pendingDecision,
      };
    }
    case "decision_applied": {
      const answer = stringValue(event.answer, "Answer applied");
      return appendBlock({ ...next, activity: "Decision applied · continuing" }, {
        kind: "notice",
        level: "info",
        text: `Decision applied to Amplifier's next reasoning step: ${answer}`,
      });
    }
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

function emptyTurnLoop(): TurnLoopState {
  return {
    phase: "idle",
    detail: "Waiting for a prompt",
    iteration: 0,
    modelPasses: 0,
    toolCalls: 0,
    toolResults: 0,
    toolFailures: 0,
    delegates: 0,
    completedDelegates: 0,
    responseBlocks: 0,
    awaitingModelPass: false,
    activeTools: {},
    activeDelegates: {},
    transitions: [],
    appliedEvents: {},
  };
}

function emptyContext(): SessionViewState["context"] {
  return {
    tokens: 0,
    window: 0,
    percent: 0,
    costUsd: "0",
    costBasis: "unavailable",
    inputTokens: 0,
    outputTokens: 0,
    unpricedTokens: 0,
    usageResponses: 0,
  };
}

function reduceTurnLoopEvent(state: SessionViewState, event: UIEvent): SessionViewState {
  const key = turnLoopEventKey(event);
  if (state.turnLoop.appliedEvents[key]) return state;
  const appliedEvents = { ...state.turnLoop.appliedEvents, [key]: true as const };
  let loop = { ...state.turnLoop, appliedEvents };

  switch (event.kind) {
    case "prompt_submit": {
      loop = {
        ...emptyTurnLoop(),
        phase: "prompt",
        detail: "Prompt accepted by Amplifier",
        startedAtMs: eventTimeMs(event),
        appliedEvents: { [key]: true },
      };
      loop = appendTurnLoopTransition(loop, event, "prompt", "Prompt accepted", "Turn entered Amplifier", "completed");
      break;
    }
    case "execution_start": {
      const pass = Math.max(1, loop.modelPasses);
      loop = {
        ...loop,
        phase: "model",
        detail: `Model pass ${pass}`,
        iteration: pass,
        modelPasses: pass,
        awaitingModelPass: false,
      };
      loop = appendTurnLoopTransition(loop, event, "model", `Model pass ${pass}`, "Provider request started");
      break;
    }
    case "content_block_start": {
      const blockType = stringValue(event.block_type, "text");
      if (!["thinking", "text", "tool_call"].includes(blockType)) break;
      const nextPass = loop.modelPasses === 0
        ? 1
        : loop.awaitingModelPass
          ? loop.modelPasses + 1
          : loop.modelPasses;
      const beganPass = loop.modelPasses === 0 || loop.awaitingModelPass;
      loop = {
        ...loop,
        phase: "model",
        detail: blockType === "thinking"
          ? `Model pass ${nextPass} · reasoning`
          : blockType === "tool_call"
            ? `Model pass ${nextPass} · selecting tools`
            : `Model pass ${nextPass} · producing output`,
        iteration: nextPass,
        modelPasses: nextPass,
        awaitingModelPass: false,
      };
      if (beganPass) {
        loop = appendTurnLoopTransition(loop, event, "model", `Model pass ${nextPass}`, "Tool results and context entered the model");
      }
      break;
    }
    case "content_block_end": {
      const blockType = stringValue(event.block_type, "text");
      if (blockType === "text") loop = { ...loop, responseBlocks: loop.responseBlocks + 1 };
      break;
    }
    case "tool_pre": {
      const id = stringValue(event.tool_call_id, key);
      if (loop.activeTools[id]) break;
      const delegate = isDelegateTool(event);
      const name = stringValue(event.tool_name, "tool");
      loop = {
        ...loop,
        phase: delegate ? "delegates" : "tools",
        detail: delegate ? "Delegating work to an Amplifier agent" : `Running ${displayToolName(name)}`,
        toolCalls: loop.toolCalls + 1,
        activeTools: { ...loop.activeTools, [id]: { id, name, delegate } },
      };
      loop = appendTurnLoopTransition(
        loop,
        event,
        delegate ? "delegates" : "tools",
        delegate ? "Delegate requested" : displayToolName(name),
        delegate ? "Coordinator opened a child-agent workspace" : "Tool call started",
      );
      break;
    }
    case "agent_spawned": {
      const id = stringValue(event.sub_session_id, stringValue(event.session_id, key));
      if (loop.activeDelegates[id]) break;
      const agent = stringValue(event.agent, "delegate");
      loop = {
        ...loop,
        phase: "delegates",
        detail: `${agent} is running`,
        delegates: loop.delegates + 1,
        activeDelegates: { ...loop.activeDelegates, [id]: true },
      };
      loop = appendTurnLoopTransition(loop, event, "delegates", `${agent} started`, "Child session is executing");
      break;
    }
    case "agent_completed": {
      const id = stringValue(event.sub_session_id, stringValue(event.session_id));
      const activeDelegates = { ...loop.activeDelegates };
      const wasActive = Boolean(activeDelegates[id]);
      delete activeDelegates[id];
      loop = {
        ...loop,
        phase: Object.keys(loop.activeTools).length ? "delegates" : "model",
        detail: event.success === false ? "Delegate returned an error" : "Delegate result returned to coordinator",
        completedDelegates: loop.completedDelegates + (wasActive ? 1 : 0),
        activeDelegates,
        awaitingModelPass: Object.keys(loop.activeTools).length === 0,
      };
      loop = appendTurnLoopTransition(
        loop,
        event,
        "delegates",
        event.success === false ? "Delegate failed" : "Delegate completed",
        "Child result returned to the coordinator",
        event.success === false ? "failed" : "completed",
      );
      break;
    }
    case "tool_post":
    case "tool_error": {
      const id = stringValue(event.tool_call_id);
      const active = loop.activeTools[id];
      if (!active) break;
      const activeTools = { ...loop.activeTools };
      delete activeTools[id];
      const failed = event.kind === "tool_error" || toolResultFailed(event);
      const stillRunning = Object.values(activeTools);
      const phase: TurnLoopPhase = stillRunning.some((tool) => tool.delegate) || Object.keys(loop.activeDelegates).length
        ? "delegates"
        : stillRunning.length
          ? "tools"
          : "model";
      loop = {
        ...loop,
        phase,
        detail: stillRunning.length
          ? `${stillRunning.length} tool call${stillRunning.length === 1 ? "" : "s"} still running`
          : "Tool results returned to the model",
        toolResults: loop.toolResults + 1,
        toolFailures: loop.toolFailures + (failed ? 1 : 0),
        activeTools,
        awaitingModelPass: stillRunning.length === 0,
      };
      loop = appendTurnLoopTransition(
        loop,
        event,
        phase,
        failed ? `${displayToolName(active.name)} failed` : "Result returned",
        failed ? "Amplifier can recover on the next model pass" : `${displayToolName(active.name)} completed`,
        failed ? "failed" : "completed",
      );
      break;
    }
    case "execution_end":
      loop = {
        ...loop,
        phase: "response",
        detail: "Final model output recorded",
        awaitingModelPass: false,
      };
      loop = appendTurnLoopTransition(loop, event, "response", "Final response", "Amplifier closed the execution loop");
      break;
    case "orchestrator_complete": {
      const status = stringValue(event.status, "success");
      loop = {
        ...loop,
        phase: status === "success" ? "response" : "complete",
        detail: status === "success" ? "Orchestrator completed successfully" : `Orchestrator ${status}`,
        completedAtMs: status === "success" ? loop.completedAtMs : eventTimeMs(event),
      };
      if (status !== "success") {
        loop = appendTurnLoopTransition(loop, event, "complete", `Turn ${status}`, "Orchestrator stopped before success", "failed");
      }
      break;
    }
    case "prompt_complete":
      loop = {
        ...loop,
        phase: "complete",
        detail: loop.toolFailures ? `Complete · ${loop.toolFailures} tool failure${loop.toolFailures === 1 ? "" : "s"} handled` : "Turn complete",
        completedAtMs: eventTimeMs(event),
        awaitingModelPass: false,
        activeTools: {},
        activeDelegates: {},
      };
      loop = appendTurnLoopTransition(loop, event, "complete", "Turn complete", "Final response returned", "completed");
      break;
    default:
      break;
  }
  return { ...state, turnLoop: loop };
}

function appendTurnLoopTransition(
  loop: TurnLoopState,
  event: UIEvent,
  phase: TurnLoopPhase,
  label: string,
  detail: string,
  status: "running" | "completed" | "failed" = "running",
): TurnLoopState {
  const transition = {
    id: `${turnLoopEventKey(event)}:${phase}:${loop.transitions.length}`,
    phase,
    label,
    detail,
    iteration: loop.iteration,
    atMs: eventTimeMs(event),
    status,
  };
  return { ...loop, transitions: [...loop.transitions, transition].slice(-30) };
}

function turnLoopEventKey(event: UIEvent): string {
  const eventId = stringValue(event.event_id);
  const timestamp = numberValue(event.ts);
  if (eventId) return `${eventId}:${timestamp}`;
  return [
    event.kind,
    stringValue(event.tool_call_id),
    stringValue(event.sub_session_id),
    stringValue(event.block_index),
    String(timestamp),
  ].join(":");
}

function isPipelineEvent(event: UIEvent): boolean {
  return ["pipeline_started", "pipeline_progress", "pipeline_checkpoint", "pipeline_complete"].includes(event.kind);
}

function reducePipelineEvent(state: SessionViewState, event: UIEvent): SessionViewState {
  const key = pipelineEventKey(event);
  if (state.pipeline?.appliedEvents[key]) return state;

  if (event.kind === "pipeline_started") {
    return {
      ...state,
      pipeline: {
        graphName: stringValue(event.graph_name, "Attractor pipeline"),
        goal: stringValue(event.goal),
        dotSource: stringValue(event.dot_source),
        declaredNodeCount: numberValue(event.node_count),
        declaredEdgeCount: numberValue(event.edge_count),
        status: "running",
        nodes: {},
        edges: {},
        totalNodesExecuted: 0,
        startedAtMs: eventTimestampMs(event),
        appliedEvents: { [key]: true },
      },
    };
  }

  const pipeline = state.pipeline || emptyPipeline();
  const appliedEvents = { ...pipeline.appliedEvents, [key]: true as const };
  if (event.kind === "pipeline_progress") {
    const phase = stringValue(event.phase);
    if (phase === "edge_selected") {
      const from = stringValue(event.from_node);
      const to = stringValue(event.to_node);
      if (!from || !to) return { ...state, pipeline: { ...pipeline, appliedEvents } };
      const edgeId = [from, to, stringValue(event.branch_id), stringValue(event.edge_label)].join("::");
      return {
        ...state,
        pipeline: {
          ...pipeline,
          edges: {
            ...pipeline.edges,
            [edgeId]: {
              id: edgeId,
              from,
              to,
              label: stringValue(event.edge_label) || undefined,
              branchId: stringValue(event.branch_id) || undefined,
              selected: true,
            },
          },
          appliedEvents,
        },
      };
    }
    const nodeId = stringValue(event.node_id);
    if (!nodeId) return { ...state, pipeline: { ...pipeline, appliedEvents } };
    const previous = pipeline.nodes[nodeId];
    const failed = ["failed", "error", "cancelled", "canceled"].includes(stringValue(event.status).toLowerCase());
    const status: PipelineNodeState["status"] = phase === "node_started" ? "running" : failed ? "failed" : "completed";
    return {
      ...state,
      pipeline: {
        ...pipeline,
        nodes: {
          ...pipeline.nodes,
          [nodeId]: {
            id: nodeId,
            handlerType: stringValue(event.handler_type) || previous?.handlerType,
            status,
            attempt: numberValue(event.attempt) || previous?.attempt || 0,
            executionIndex: numberValue(event.execution_index) || previous?.executionIndex || 0,
            durationMs: optionalNumber(event.duration_ms) ?? previous?.durationMs,
            notes: stringValue(event.notes) || previous?.notes,
            failureReason: stringValue(event.failure_reason) || previous?.failureReason,
            sessionId: stringValue(event.node_session_id) || previous?.sessionId,
            branchId: stringValue(event.branch_id) || previous?.branchId,
            viaParallel: typeof event.via_parallel === "boolean" ? event.via_parallel : previous?.viaParallel,
            checkpointPath: previous?.checkpointPath,
            updatedAtMs: eventTimestampMs(event),
          },
        },
        appliedEvents,
      },
    };
  }
  if (event.kind === "pipeline_checkpoint") {
    const nodeId = stringValue(event.node_id);
    const previous = pipeline.nodes[nodeId];
    if (!nodeId) return { ...state, pipeline: { ...pipeline, appliedEvents } };
    return {
      ...state,
      pipeline: {
        ...pipeline,
        nodes: {
          ...pipeline.nodes,
          [nodeId]: {
            ...previous,
            id: nodeId,
            status: previous?.status === "completed" || previous?.status === "failed" ? previous.status : "checkpointed",
            attempt: previous?.attempt || 0,
            executionIndex: previous?.executionIndex || 0,
            checkpointPath: stringValue(event.checkpoint_path) || previous?.checkpointPath,
            branchId: stringValue(event.branch_id) || previous?.branchId,
            updatedAtMs: eventTimestampMs(event),
          },
        },
        appliedEvents,
      },
    };
  }
  return {
    ...state,
    pipeline: {
      ...pipeline,
      status: stringValue(event.status, "completed"),
      totalNodesExecuted: numberValue(event.total_nodes_executed),
      durationMs: optionalNumber(event.duration_ms) ?? pipeline.durationMs,
      branchId: stringValue(event.branch_id) || pipeline.branchId,
      completedAtMs: eventTimestampMs(event),
      appliedEvents,
    },
  };
}

function emptyPipeline(): PipelineState {
  return {
    graphName: "Attractor pipeline",
    goal: "",
    dotSource: "",
    declaredNodeCount: 0,
    declaredEdgeCount: 0,
    status: "running",
    nodes: {},
    edges: {},
    totalNodesExecuted: 0,
    appliedEvents: {},
  };
}

function pipelineEventKey(event: UIEvent): string {
  return stringValue(event.event_id) || [
    event.kind,
    stringValue(event.phase),
    stringValue(event.node_id),
    stringValue(event.from_node),
    stringValue(event.to_node),
    stringValue(event.execution_index),
    stringValue(event.branch_id),
  ].join(":");
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTodoTool(event: UIEvent): boolean {
  const tool = stringValue(event.tool_name).trim().toLowerCase();
  return tool === "todo"
    || tool === "update_plan"
    || /(?:[.:/])(?:todo|update_plan)$/.test(tool);
}

function reducePlanEvent(state: SessionViewState, event: UIEvent): SessionViewState {
  if (event.kind === "tool_pre") {
    const items = todoItems(event.tool_input);
    if (!items?.length) return state;
    const sessionId = stringValue(event.session_id, state.runtimeSessionId || "coordinator");
    const isAgent = Boolean(
      stringValue(event.parent_id)
      || (state.runtimeSessionId && sessionId && sessionId !== state.runtimeSessionId),
    );
    const key = isAgent ? `agent:${sessionId}` : "coordinator";
    return {
      ...state,
      plans: {
        ...state.plans,
        [key]: {
          ownerId: isAgent ? sessionId : state.runtimeSessionId || sessionId,
          ownerKind: isAgent ? "agent" : "coordinator",
          items,
          toolCallId: stringValue(event.tool_call_id, stringValue(event.event_id)),
          updateStatus: "pending",
          updatedAtMs: eventTimestampMs(event),
        },
      },
    };
  }
  if (event.kind !== "tool_post" && event.kind !== "tool_error") return state;
  const key = planKeyForCall(state, stringValue(event.tool_call_id));
  if (!key) return state;
  const current = state.plans[key];
  if (!current) return state;
  const failed = event.kind === "tool_error" || toolResultFailed(event);
  return {
    ...state,
    plans: {
      ...state.plans,
      [key]: {
        ...current,
        updateStatus: failed ? "degraded" : "applied",
        message: failed ? planFailureMessage(event) : undefined,
        updatedAtMs: eventTimestampMs(event) || current.updatedAtMs,
      },
    },
  };
}

function todoItems(value: unknown): PlanItemState[] | undefined {
  const input = objectValue(value);
  const todos = Array.isArray(input.todos) ? input.todos : input.plan;
  if (!Array.isArray(todos)) return undefined;
  const items = todos.flatMap((value): PlanItemState[] => {
    if (!isRecord(value)) return [];
    const content = stringValue(value.content, stringValue(value.step)).trim();
    if (!content) return [];
    const activeForm = stringValue(value.activeForm, stringValue(value.active_form)).trim();
    return [{
      content,
      activeForm: activeForm || undefined,
      status: todoStatus(value.status),
    }];
  });
  return items.length ? items : undefined;
}

function todoStatus(value: unknown): PlanItemState["status"] {
  const status = stringValue(value).trim().toLowerCase().replaceAll("-", "_");
  if (["completed", "complete", "done"].includes(status)) return "completed";
  if (["in_progress", "active", "running"].includes(status)) return "in_progress";
  return "pending";
}

function planKeyForCall(state: SessionViewState, toolCallId: string): string | undefined {
  if (!toolCallId) return undefined;
  return Object.entries(state.plans).find(([, plan]) => plan.toolCallId === toolCallId)?.[0];
}

function planFailureMessage(event: UIEvent): string {
  const result = objectValue(event.result);
  const status = stringValue(result.status).toLowerCase();
  const direct = stringValue(event.error_message)
    || stringValue(result.message)
    || stringValue(result.error);
  if (direct) return `Plan update failed: ${direct}`;
  if (status === "denied" || status === "rejected") return "Plan update was denied. The proposed steps are retained for visibility.";
  return "Plan update failed. The proposed steps are retained for visibility.";
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
  const toolName = stringValue(event.tool_name);
  if (!isOutputProducingTool(toolName)) return state;
  const artifacts = outputArtifacts(event);
  if (!artifacts.length) return state;
  const source = toolName ? displayToolName(toolName) : undefined;
  const additions = artifacts.map((artifact) => ({
    id: artifact.path,
    kind: artifact.kind,
    title: artifact.path.split(/[\\/]/).at(-1) || artifact.path,
    path: artifact.path,
    source,
    laneId: stringValue(event.parent_id) ? stringValue(event.session_id) || undefined : undefined,
    toolCallId: stringValue(event.tool_call_id) || undefined,
    eventId: stringValue(event.event_id) || undefined,
    runtimeHost: stringValue(event.runtime_host) || undefined,
  }));
  const ids = new Set(additions.map((item) => item.id));
  return { ...state, outputs: [...state.outputs.filter((item) => !ids.has(item.id)), ...additions].slice(-80) };
}

function outputArtifacts(event: UIEvent): Array<{
  path: string;
  kind: SessionViewState["outputs"][number]["kind"];
}> {
  const toolName = stringValue(event.tool_name);
  if (!isOutputProducingTool(toolName)) return [];
  const typedArtifacts = Array.isArray(event.artifacts)
    ? event.artifacts.filter(isRecord).flatMap((artifact) => {
        const path = stringValue(artifact.path).trim();
        if (!path) return [];
        const kind = stringValue(artifact.kind);
        return [{
          path,
          kind: ["file", "image", "diagram", "data"].includes(kind)
            ? kind as SessionViewState["outputs"][number]["kind"]
            : outputKind(path),
        }];
      })
    : [];
  if (typedArtifacts.length) return typedArtifacts;

  const fromResult = collectOutputPaths(event.result).map((path) => ({ path, kind: outputKind(path) }));
  if (fromResult.length) return fromResult;

  // Fall back to the tool's INPUT. Which file a write touched is stated in the call, not
  // necessarily in the reply: a Claude-Code-shaped Write returns only
  // {content: "File created successfully at: ..."}, so reading the result alone made Studio's
  // output inventory depend on the runtime's reply shape. An Edit that echoes file_path was
  // captured; a Write that does not was silently dropped.
  return toolInputPaths(event.tool_input).map((path) => ({ path, kind: outputKind(path) }));
}

/** Path-shaped fields a write-like tool call uses to name its target. */
const TOOL_INPUT_PATH_KEYS = ["file_path", "filePath", "path", "filename", "target_file", "TargetFile"];

function toolInputPaths(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const paths = TOOL_INPUT_PATH_KEYS
    .map((key) => stringValue(input[key]).trim())
    // "/dev/null" is a real value some tools pass and never an artifact worth listing.
    .filter((value) => value.length > 0 && value !== "/dev/null" && value !== "undefined" && value !== "null");
  return [...new Set(paths)];
}

function isOutputProducingTool(toolName: string): boolean {
  const tool = toolName.trim().toLowerCase().replaceAll("-", "_");
  const leaf = tool.split(/[.:/]/).at(-1) || tool;
  if (/^(?:read|read_file|glob|grep|search|find|list|ls|stat|inspect|query|fetch|get)$/.test(leaf)) return false;
  return /(?:^|_)(?:write|create|generate|render|export|save|download|edit|patch|screenshot)(?:_|$)/.test(leaf)
    || ["apply_patch", "imagegen"].includes(leaf);
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

function reduceLaneEvent(
  state: SessionViewState,
  event: UIEvent,
  planLifecycle = false,
  planTracked = false,
): SessionViewState {
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
  let costBasis = previous.costBasis || "unavailable";
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
      const eventModel = stringValue(event.model);
      const pricingModel = concreteModel(eventModel) || concreteModel(model || "") || state.model;
      model = eventModel || model;
      const reportedCost = typeof event.cost_usd === "number" || typeof event.cost_usd === "string"
        ? Number(event.cost_usd)
        : Number.NaN;
      const estimate = estimateRunPodCost(
        pricingModel,
        numberValue(event.input_tokens),
        numberValue(event.output_tokens),
      );
      const useReported = Number.isFinite(reportedCost) && reportedCost >= 0 && (reportedCost > 0 || !estimate);
      if (useReported) {
        costUsd = moneyString(finiteMoney(costUsd || "0") + reportedCost);
        costBasis = mergeCostBasis(costBasis, "reported");
      } else if (estimate) {
        costUsd = moneyString(finiteMoney(costUsd || "0") + estimate.costUsd);
        costBasis = mergeCostBasis(costBasis, "estimated");
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
      if (planLifecycle) {
        if (planTracked) activity = "Updated plan steps";
        status = "running";
        break;
      }
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
      if (planLifecycle) {
        if (planTracked) activity = toolResultFailed(event) ? "Plan update needs attention" : "Plan steps updated";
        break;
      }
      const failed = toolResultFailed(event);
      tools = settleLaneTool(tools, event, failed ? "failed" : "completed");
      events = settleLaneEvent(events, stringValue(event.tool_call_id), failed ? "failed" : "completed", safeJson(event.result ?? {}));
      activity = failed ? `${displayToolName(stringValue(event.tool_name, "tool"))} failed` : "Reviewing tool result";
      if (failed) status = "attention";
      break;
    }
    case "tool_error":
      if (planLifecycle) {
        if (planTracked) activity = "Plan update needs attention";
        break;
      }
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
    activity: summarizeParallelWork(state, laneId, { ...previous, activity, tail, tailKind, thinking, tools, events, status, model, costUsd, costBasis }),
    lanes: {
      ...state.lanes,
      [laneId]: { ...previous, activity, tail, tailKind, thinking, tools, events, status, model, costUsd, costBasis },
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
        expiresAtMs: expiryFromRecord(approval),
        defaultChoice: stringValue(approval.default_choice) || undefined,
      }
    : undefined;
  const decisionId = stringValue(firstDecision?.decision_id);
  const pendingDecision = decisionId
    ? state.pendingDecision?.decisionId === decisionId
      ? mergeDecisionState(state.pendingDecision, firstDecision)
      : {
          decisionId,
          question: stringValue(firstDecision?.question, "Amplifier needs your input"),
          reason: stringValue(firstDecision?.reason),
          choices: stringList(firstDecision?.choices),
          descriptions: stringList(firstDecision?.descriptions),
          recommendedChoice: recommendedDecisionChoice(stringList(firstDecision?.choices)),
          multiple: firstDecision?.multiple === true,
          custom: firstDecision?.custom === true,
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
      ...state.context,
      tokens: numberValue(context.context_tokens, state.context.tokens),
      window: numberValue(context.context_window, state.context.window),
      percent: numberValue(context.context_pct, state.context.percent),
      ...contextCostFromRecord(state.context, context),
    },
  };
  return pendingApproval ? markLaneAwaitingApproval(next, {
    sessionId: pendingApproval.sessionId,
    toolCallId: pendingApproval.toolCallId,
    prompt: pendingApproval.prompt,
  }) : next;
}

function recordSessionUsage(state: SessionViewState, event: UIEvent): SessionViewState {
  const inputTokens = numberValue(event.input_tokens);
  const outputTokens = numberValue(event.output_tokens);
  const billableTokens = inputTokens + outputTokens;
  if (billableTokens <= 0) return state;

  const rawReported = event.cost_usd;
  const reported = typeof rawReported === "number" || typeof rawReported === "string"
    ? Number(rawReported)
    : Number.NaN;
  const eventModel = stringValue(event.model);
  const laneModel = state.lanes[stringValue(event.session_id)]?.model || "";
  const authoritativeModel = concreteModel(eventModel) || concreteModel(laneModel);
  const modelCandidates = (authoritativeModel
    ? [authoritativeModel]
    : [state.model, state.requestedModel || ""]
  ).filter((model, index, models) => model && models.indexOf(model) === index);
  const estimate = modelCandidates
    .map((model) => estimateRunPodCost(model, inputTokens, outputTokens))
    .find((candidate) => candidate !== undefined);
  // LiteLLM's self-hosted RunPod routes intentionally report zero because the
  // underlying bill is GPU-hours. For a recognized RunPod model, use the
  // explicitly-labelled fleet estimate instead of presenting that zero as free.
  const useReported = Number.isFinite(reported) && reported >= 0 && (reported > 0 || !estimate);
  const currentCost = finiteMoney(state.context.costUsd);
  let addedCost = 0;
  let costBasis: CostBasis = state.context.costBasis;
  let unpricedTokens = state.context.unpricedTokens;
  let estimateModel = state.context.estimateModel;
  let estimateRatePerMillion = state.context.estimateRatePerMillion;

  if (useReported) {
    addedCost = reported;
    costBasis = mergeCostBasis(costBasis, "reported");
  } else if (estimate) {
    addedCost = estimate.costUsd;
    costBasis = mergeCostBasis(costBasis, "estimated");
    estimateModel = estimateModel && estimateModel !== estimate.model ? "Multiple RunPod models" : estimate.model;
    estimateRatePerMillion = estimateRatePerMillion === undefined || estimateRatePerMillion === estimate.ratePerMillion
      ? estimate.ratePerMillion
      : undefined;
  } else {
    unpricedTokens += billableTokens;
    costBasis = currentCost > 0 ? "partial" : "unavailable";
  }
  if (unpricedTokens > 0 && costBasis !== "unavailable") costBasis = "partial";

  return {
    ...state,
    context: {
      ...state.context,
      costUsd: moneyString(currentCost + addedCost),
      costBasis,
      inputTokens: state.context.inputTokens + inputTokens,
      outputTokens: state.context.outputTokens + outputTokens,
      unpricedTokens,
      usageResponses: state.context.usageResponses + 1,
      estimateModel,
      estimateRatePerMillion,
    },
  };
}

function contextFromRecord(current: SessionViewState["context"], record: ProtocolRecord): SessionViewState["context"] {
  return {
    ...current,
    tokens: numberValue(record.context_tokens),
    window: numberValue(record.context_window),
    percent: numberValue(record.context_pct),
    ...contextCostFromRecord(current, record),
  };
}

function contextCostFromRecord(
  current: SessionViewState["context"],
  record: Record<string, unknown>,
): Pick<SessionViewState["context"], "costUsd" | "costBasis"> {
  // Once durable usage events have rebuilt an all-agent total, a root-only
  // context snapshot must not overwrite it. This is especially important on
  // resume, where replay arrives immediately before session.status.
  if (current.usageResponses > 0) {
    return { costUsd: current.costUsd, costBasis: current.costBasis };
  }
  const raw = record.cost_usd;
  const numeric = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) {
    return { costUsd: current.costUsd, costBasis: current.costBasis };
  }
  // A resumed legacy session can carry an authoritative persisted total even
  // when the newly booted runtime has no in-memory context meter yet. Do not
  // erase that non-zero history with a transient zero-valued status snapshot.
  if (numeric === 0 && finiteMoney(current.costUsd) > 0 && current.costBasis === "reported") {
    return { costUsd: current.costUsd, costBasis: current.costBasis };
  }
  const estimatedOrIncomplete = record.cost_estimated === true;
  return {
    costUsd: moneyString(numeric),
    costBasis: numeric === 0
      ? "unavailable"
      : estimatedOrIncomplete
        ? "partial"
        : "reported",
  };
}

function finiteMoney(value: string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function moneyString(value: number): string {
  return value === 0 ? "0" : value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function concreteModel(value: string): string | undefined {
  if (!value) return undefined;
  const role = value.trim().toLowerCase();
  return ["fast", "general", "reasoning", "coding", "vision", "image", "default", "utility"].includes(role)
    ? undefined
    : value;
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
  return result.success === false || ["denied", "rejected", "error", "failed"].includes(status) || Boolean(result.error);
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

function expiryFromRecord(record: Record<string, unknown>): number | undefined {
  const seconds = numberValue(record.expires_in_seconds, -1);
  return seconds >= 0 ? Date.now() + seconds * 1_000 : undefined;
}

function recommendedDecisionChoice(choices: string[]): string | undefined {
  return choices.find((choice) => /\brecommended\b/i.test(choice));
}

function mergeDecisionState(
  existing: NonNullable<SessionViewState["pendingDecision"]>,
  incoming: Record<string, unknown> | undefined,
): NonNullable<SessionViewState["pendingDecision"]> {
  if (!incoming) return existing;
  const incomingChoices = stringList(incoming.choices);
  const choices = incomingChoices.length ? incomingChoices : existing.choices;
  const incomingDescriptions = stringList(incoming.descriptions);
  return {
    ...existing,
    question: stringValue(incoming.question, existing.question),
    reason: stringValue(incoming.reason, existing.reason),
    choices,
    descriptions: incomingDescriptions.length ? incomingDescriptions : existing.descriptions,
    recommendedChoice: recommendedDecisionChoice(choices) || existing.recommendedChoice,
    multiple: incoming.multiple === true || existing.multiple,
    custom: incoming.custom === true || existing.custom,
  };
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
  // Keep the target in the summary. Overwriting with "<tool> <status>" turned
  // "write_file · src/main.rs" into "write_file completed" the moment the call finished, so the
  // one useful fact on the row disappeared exactly when the row became final.
  const settledSummary = block.summary.includes(" · ")
    ? `${block.summary} — ${status}`
    : `${block.toolName} ${status}`;
  blocks[index] = { ...block, status, summary: settledSummary, detail };
  return { ...state, blocks };
}

function finalizeAnswer(state: SessionViewState, response: string): SessionViewState {
  if (!response) return state;
  const index = findLastIndex(
    state.blocks,
    (block) => block.kind === "answer" && block.text.trim() === response,
  );
  const reconciledIndex = index >= 0
    ? index
    : findLastIndex(
      state.blocks,
      (block) => block.kind === "answer" && !block.final && redactedTextMatches(block.text.trim(), response),
    );
  if (reconciledIndex < 0) return appendBlock(state, { kind: "answer", text: response, final: true });
  const block = state.blocks[reconciledIndex];
  if (block.kind !== "answer" || block.final) return state;
  const blocks = [...state.blocks];
  blocks[reconciledIndex] = { ...block, text: response, final: true };
  return { ...state, blocks };
}

function redactedTextMatches(redacted: string, clear: string): boolean {
  const placeholder = /\[REDACTED(?::[A-Z_]+)?\]/g;
  if (!placeholder.test(redacted)) return false;
  const fragments = redacted.split(placeholder);
  let cursor = 0;
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index] || "";
    if (!fragment) continue;
    const found = clear.indexOf(fragment, cursor);
    if (found < 0 || (index === 0 && found !== 0)) return false;
    cursor = found + fragment.length;
  }
  const tail = fragments.at(-1) || "";
  return !tail || clear.endsWith(tail);
}

function appendBlock(state: SessionViewState, block: NewTranscriptBlock): SessionViewState {
  const complete = { ...block, id: `b${state.nextBlock}` } as TranscriptBlock;
  return { ...state, blocks: [...state.blocks, complete], nextBlock: state.nextBlock + 1 };
}

function reduceRecipeNotification(
  state: SessionViewState,
  message: string,
  level: "info" | "warning" | "error" | "success",
): SessionViewState {
  const start = message.match(/Starting recipe:\s*(.+?)\s*\((\d+)\s+steps?\)/i);
  if (start) {
    return appendBlock(state, {
      kind: "recipe",
      name: start[1]?.trim() || "recipe",
      total: Number(start[2]) || 0,
      status: "running",
      steps: [],
      messages: [],
    });
  }

  const completion = message.match(/Recipe completed:\s*(.+?)\s*$/i);
  if (completion) {
    return updateRecipeBlock(state, completion[1]?.trim(), (recipe) => ({
      ...recipe,
      status: "completed",
      steps: recipe.steps.map((step) => ({ ...step, status: "completed" })),
    }));
  }

  const step = message.match(/^\s*\[(\d+)\/(\d+)]\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/);
  if (step) {
    const index = Number(step[1]);
    const total = Number(step[2]);
    const name = step[3]?.trim() || `Step ${index}`;
    const kind = step[4]?.trim() || undefined;
    return updateRecipeBlock(state, undefined, (recipe) => {
      const without = recipe.steps.filter((item) => item.index !== index).map((item) => ({
        ...item,
        status: item.status === "running" ? "completed" as const : item.status,
      }));
      return {
        ...recipe,
        total: total || recipe.total,
        status: level === "error" ? "failed" : recipe.status,
        steps: [...without, {
          index,
          total,
          name,
          kind,
          status: level === "error" ? "failed" as const : "running" as const,
        }].sort((left, right) => left.index - right.index),
      };
    });
  }

  return updateRecipeBlock(state, undefined, (recipe) => ({
    ...recipe,
    status: level === "error" ? "failed" : /waiting for approval/i.test(message) ? "attention" : recipe.status,
    messages: [...recipe.messages, message.trim()].filter(Boolean).slice(-12),
  }));
}

function updateRecipeBlock(
  state: SessionViewState,
  name: string | undefined,
  update: (recipe: Extract<TranscriptBlock, { kind: "recipe" }>) => Extract<TranscriptBlock, { kind: "recipe" }>,
): SessionViewState {
  const index = findLastIndex(state.blocks, (block) => block.kind === "recipe"
    && block.status !== "completed"
    && (!name || block.name === name));
  if (index < 0) {
    return appendBlock(state, {
      kind: "recipe",
      name: name || "Recipe activity",
      total: 0,
      status: "running",
      steps: [],
      messages: [],
    });
  }
  const recipe = state.blocks[index];
  if (recipe.kind !== "recipe") return state;
  const blocks = [...state.blocks];
  blocks[index] = update(recipe);
  return { ...state, blocks };
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
  const target = toolInputPaths(input)[0]
    || stringValue(input.command, stringValue(input.query));
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

function historySource(
  value: unknown,
  fallback: SessionViewState["restoreSource"] = "ui-events",
): SessionViewState["restoreSource"] {
  if (value === "transcript" || value === "legacy-events" || value === "mixed-events" || value === "ui-events") {
    return value;
  }
  return fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function optionalMoney(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? moneyString(numeric) : undefined;
}

function bootMessage(action: string, detail: string): string {
  const actionText = action ? action.replaceAll("_", " ") : "Preparing";
  return detail ? `${capitalize(actionText)} · ${detail}` : capitalize(actionText);
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function shouldDeriveSessionTitle(title: string): boolean {
  return title === "New session"
    || title === "Ready for your first prompt"
    || title === "Restoring saved work"
    || title === "Untitled Amplifier run"
    || /^Work in /i.test(title)
    || /^(?:Session|Resume) [a-z0-9-]{1,12}$/i.test(title);
}

export function usableSessionTitle(title: string | undefined): string | undefined {
  const clean = title?.trim();
  if (!clean
    || /^(?:Session|Resume) [a-z0-9-]{1,12}$/i.test(clean)
    || clean === "Restoring saved work") return undefined;
  return clean;
}

function promptSessionTitle(prompt: string): string | undefined {
  const clean = prompt
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^a-z0-9]+/i, "");
  if (!clean) return undefined;
  const words = clean.split(" ").slice(0, 7).join(" ");
  const title = truncate(words, 48).replace(/[.,;:!?-]+$/, "");
  return capitalize(title);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}
