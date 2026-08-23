export const JSONL_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type JsonObject = Record<string, unknown>;

export interface ProtocolRecord extends JsonObject {
  schema_version?: number;
  sequence?: number;
  timestamp?: string;
  type?: string;
  replay?: boolean;
}

export interface UIEvent extends JsonObject {
  kind: string;
  event_id?: string;
  session_id?: string;
  parent_id?: string | null;
  ts?: number;
}

export interface ApprovalState {
  ticketId: string;
  prompt: string;
  options: string[];
  sessionId?: string;
  parentId?: string;
  toolCallId?: string;
  expiresAtMs?: number;
  defaultChoice?: string;
  submissionError?: string;
}

export interface DecisionState {
  decisionId: string;
  question: string;
  reason: string;
  choices: string[];
  descriptions: string[];
  recommendedChoice?: string;
  multiple: boolean;
  custom: boolean;
  createdAtMs?: number;
  submissionError?: string;
}

export interface ContextState {
  tokens: number;
  window: number;
  percent: number;
  costUsd: string;
  costBasis: "unavailable" | "reported" | "estimated" | "mixed" | "partial";
  inputTokens: number;
  outputTokens: number;
  unpricedTokens: number;
  usageResponses: number;
  estimateModel?: string;
  estimateRatePerMillion?: number;
}

export interface GoalProgressState {
  state: string;
  condition?: string;
  turn: number;
  continuations: number;
  cap?: number;
  reason?: string;
  summary?: string;
  stallDetail?: string;
  updatedAtMs: number;
}

export interface ComposerImageAttachment {
  kind: "image";
  id: string;
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  size: number;
}

export interface ComposerDocumentAttachment {
  kind: "document";
  id: string;
  name: string;
  mediaType: string;
  text: string;
  size: number;
  truncated: boolean;
}

export type ComposerAttachment = ComposerImageAttachment | ComposerDocumentAttachment;

export type SessionPhase = "starting" | "degraded" | "ready" | "closing" | "exited" | "error";

interface BaseBlock {
  id: string;
}

export interface UserBlock extends BaseBlock {
  kind: "user";
  text: string;
  mode?: string;
  attachments?: ComposerAttachment[];
}

export interface AnswerBlock extends BaseBlock {
  kind: "answer";
  text: string;
  final: boolean;
}

export interface ThinkingBlock extends BaseBlock {
  kind: "thinking";
  text: string;
  expanded: boolean;
}

export interface ToolBlock extends BaseBlock {
  kind: "tool";
  toolName: string;
  toolCallId: string;
  status: "running" | "completed" | "failed";
  summary: string;
  detail: string;
}

export interface RecipeStepState {
  index: number;
  total: number;
  name: string;
  kind?: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface RecipeBlock extends BaseBlock {
  kind: "recipe";
  name: string;
  total: number;
  status: "running" | "completed" | "attention" | "failed";
  steps: RecipeStepState[];
  messages: string[];
}

export interface NoticeBlock extends BaseBlock {
  kind: "notice";
  level: "info" | "warning" | "error" | "success";
  text: string;
}

export interface OutputBlock extends BaseBlock {
  kind: "output";
  output: SessionOutput;
}

export type TranscriptBlock = UserBlock | AnswerBlock | ThinkingBlock | ToolBlock | RecipeBlock | NoticeBlock | OutputBlock;

export interface LiveTailState {
  blockType: string;
  text: string;
}

export interface LaneToolState {
  id: string;
  name: string;
  label: string;
  status: "running" | "completed" | "failed" | "unknown";
}

export interface LaneEventState {
  id: string;
  kind: "status" | "thinking" | "message" | "tool";
  title: string;
  detail: string;
  status?: "running" | "completed" | "failed" | "unknown";
}

export interface LaneState {
  id: string;
  parentId?: string;
  agent: string;
  status: "running" | "completed" | "attention" | "detached";
  activity: string;
  tail: string;
  tailKind: "text" | "thinking";
  thinking: string;
  tools: LaneToolState[];
  events: LaneEventState[];
  instruction?: string;
  model?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  costUsd?: string;
  costBasis?: "unavailable" | "reported" | "estimated" | "mixed" | "partial";
}

export interface PendingDelegateBrief {
  instruction: string;
  model?: string;
  toolCallId?: string;
}

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItemState {
  content: string;
  activeForm?: string;
  status: PlanItemStatus;
}

export interface PlanOwnerState {
  ownerId: string;
  ownerKind: "coordinator" | "agent";
  items: PlanItemState[];
  toolCallId: string;
  updateStatus: "pending" | "applied" | "degraded";
  message?: string;
  updatedAtMs?: number;
}

export type TurnLoopPhase = "idle" | "prompt" | "model" | "tools" | "delegates" | "response" | "complete";

export interface TurnLoopTransition {
  id: string;
  phase: TurnLoopPhase;
  label: string;
  detail: string;
  iteration: number;
  atMs: number;
  status: "running" | "completed" | "failed";
}

export interface TurnLoopToolState {
  id: string;
  name: string;
  delegate: boolean;
}

export interface TurnLoopState {
  phase: TurnLoopPhase;
  detail: string;
  iteration: number;
  modelPasses: number;
  toolCalls: number;
  toolResults: number;
  toolFailures: number;
  delegates: number;
  completedDelegates: number;
  responseBlocks: number;
  awaitingModelPass: boolean;
  activeTools: Record<string, TurnLoopToolState>;
  activeDelegates: Record<string, true>;
  transitions: TurnLoopTransition[];
  appliedEvents: Record<string, true>;
  startedAtMs?: number;
  completedAtMs?: number;
}

export type PipelineNodeStatus = "pending" | "running" | "completed" | "failed" | "checkpointed";

export interface PipelineNodeState {
  id: string;
  handlerType?: string;
  status: PipelineNodeStatus;
  attempt: number;
  executionIndex: number;
  durationMs?: number;
  notes?: string;
  failureReason?: string;
  sessionId?: string;
  branchId?: string;
  viaParallel?: boolean;
  checkpointPath?: string;
  updatedAtMs?: number;
}

export interface PipelineEdgeState {
  id: string;
  from: string;
  to: string;
  label?: string;
  branchId?: string;
  selected: boolean;
}

export interface PipelineState {
  graphName: string;
  goal: string;
  dotSource: string;
  declaredNodeCount: number;
  declaredEdgeCount: number;
  status: string;
  nodes: Record<string, PipelineNodeState>;
  edges: Record<string, PipelineEdgeState>;
  totalNodesExecuted: number;
  durationMs?: number;
  branchId?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  appliedEvents: Record<string, true>;
}

export interface SessionAlert {
  id: string;
  level: "info" | "warning" | "error";
  title: string;
  message: string;
}

export interface SessionOutput {
  id: string;
  kind: "file" | "image" | "diagram" | "data";
  title: string;
  path: string;
  source?: string;
  laneId?: string;
  toolCallId?: string;
  eventId?: string;
  runtimeHost?: string;
}

export interface ArchivedTurnOutcome {
  turnId?: string;
  checkpointId?: string;
  costUsd?: string;
  elapsedSeconds?: number;
  tokens?: number;
  cachedPercent?: number;
  interrupted?: boolean;
  yields: Array<{ kind: string; label: string }>;
}

export interface ArchivedSessionMetadata {
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  turnCount?: number;
  totalCostUsd?: string;
  permissionPosture?: string;
  permissionProfile?: {
    name?: string;
    auto: string[];
    ask: string[];
    block: string[];
    classifierGated?: boolean;
  };
  outcomes: ArchivedTurnOutcome[];
}

export interface SessionViewState {
  guiId: string;
  hostId?: string;
  hostName?: string;
  hostUrl?: string;
  capabilityId?: string;
  capabilityName?: string;
  runtimeSessionId?: string;
  runtimeCapabilities?: {
    protocolVersion: number;
    features: string[];
    operations: Record<string, string>;
  };
  projectDir: string;
  requestedBundle?: string;
  requestedModel?: string;
  requestedProvider?: string;
  resumeId?: string;
  /** Number of durable transcript messages Studio saw before launching the
   * resume. Used only to detect an older live runtime owner that reports a
   * successful but empty replay for a non-empty legacy session. */
  expectedHistoryMessages?: number;
  /** Number of normalized UI events indexed before resume. When present,
   * Studio verifies that the complete visual ledger was delivered. */
  expectedHistoryEvents?: number;
  title: string;
  bundle: string;
  model: string;
  mode: string;
  phase: SessionPhase;
  /** Remote bridge reachability is independent of the runtime lifecycle. A
   * ready runtime can remain alive while Studio reconnects its view. */
  connectivity?: {
    status: "connected" | "reconnecting";
    message?: string;
  };
  bootLabel: string;
  busy: boolean;
  pendingPrompt?: {
    text: string;
    runtimeText?: string;
    mode: string;
  };
  composerDraft: string;
  composerAttachments: ComposerAttachment[];
  autopilot: boolean;
  autopilotPending: boolean;
  activity: string;
  turnStartedAtMs?: number;
  replaying: boolean;
  /** Which durable source rebuilt the visible history on resume. UI events
   * retain rich plan/tool/output state; legacy transcript snapshots carry
   * only the user/assistant conversation that was actually persisted. */
  restoreSource?: "ui-events" | "legacy-events" | "mixed-events" | "transcript";
  restoredTranscriptMessages?: number;
  restoredEventCount?: number;
  indexedHistoryRecords?: number;
  archivedMetadata?: ArchivedSessionMetadata;
  /** Synthetic transcript message ids already folded into this view. Native
   * retries do not pass through the bridge transport's replay deduplicator. */
  /**
   * Message ids already accepted from a durable replay.
   *
   * A mutable Set, deliberately: it is a monotonic dedupe accumulator that is never rendered and
   * never persisted, and the previous shape -- a plain object rebuilt with `{ ...ids, [id]: true }`
   * per replayed message -- made a full-history resume quadratic. Measured: 10k messages took
   * 6,958 ms of main-thread copying versus 0.86 ms with a Set.
   */
  replayedTranscriptMessageIds?: Set<string>;
  /** User/assistant transcript records accepted since the latest
   * history.begin. This is compared with history.end.transcript_count while
   * the initial restore gate is active; reported delivery counts alone are
   * not proof that Studio received the conversation. */
  acceptedReplayTranscriptMessages?: number;
  /** Normalized UI events actually accepted since the latest history.begin. */
  acceptedReplayEvents?: number;
  restoreProgress?: {
    history: boolean;
    status: boolean;
    statusBusy?: boolean;
  };
  restoreIssue?: {
    missing: Array<"history" | "status">;
    message: string;
    attempt: number;
  };
  pendingApproval?: ApprovalState;
  pendingDecision?: DecisionState;
  context: ContextState;
  goal?: GoalProgressState;
  effort?: string;
  effortLevels: string[];
  effortPending?: string;
  effortConfirmedAtMs?: number;
  blocks: TranscriptBlock[];
  liveTail?: LiveTailState;
  openThinkingId?: string;
  lanes: Record<string, LaneState>;
  pendingDelegateBriefs: Record<string, PendingDelegateBrief>;
  plans: Record<string, PlanOwnerState>;
  turnLoop: TurnLoopState;
  pipeline?: PipelineState;
  alerts: SessionAlert[];
  outputs: SessionOutput[];
  lastSequence?: number;
  /** Set when a replay ends: the next live record re-baselines `lastSequence` without a gap warning. */
  sequenceResyncPending?: boolean;
  queuedSteers: number;
  nextBlock: number;
  logs: string[];
  error?: string;
  exitCode?: number;
}

export interface NewSessionInput {
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
  /** Studio-only resume expectation; deliberately omitted from runtime wire
   * options because it describes the catalog entry, not runtime behavior. */
  expectedHistoryMessages?: number;
  expectedHistoryEvents?: number;
  capabilityId?: string;
  capabilityName?: string;
}

export interface StoredSession {
  sessionId: string;
  /** Compute origin is attached by Studio when it federates host histories. */
  hostId?: string;
  hostName?: string;
  hostUrl?: string;
  sourceKind?: "local" | "remote";
  name: string;
  bundle: string;
  model?: string;
  tags: string[];
  turnCount?: number;
  messageCount: number;
  /** Normalized UI events available for a lossless visual replay. Older
   * compute hosts omit this field. */
  eventCount?: number;
  mtimeMs: number;
  projectSlug: string;
  projectDir?: string;
  state: "ok" | "recovered" | "corrupt" | "transcript_lost" | "indexing" | "empty";
  summary: string;
  /** Bounded user/assistant transcript text used by federated history search. */
  searchText?: string;
}

export interface BundleOption {
  name: string;
  active: boolean;
  location: string;
  status: string;
}

export interface ProviderOption {
  name: string;
  module: string;
  model: string;
  active: boolean;
  toolCompatible: boolean;
  warning?: string;
}

export interface CapabilityCatalog {
  bundles: BundleOption[];
  providers: ProviderOption[];
}

export function isRecord(value: unknown): value is ProtocolRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asEvent(value: unknown): UIEvent | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  return value as UIEvent;
}

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Largest tool payload Studio will keep pretty-printed in a transcript block.
 *
 * Tool results are arbitrary agent-controlled data -- a file read or an HTTP body can be
 * megabytes -- and every one was retained in state and in the DOM at full size, indented.
 * Truncating keeps the block readable and bounds memory; the untruncated result is still on
 * disk in the durable session.
 */
const MAX_TOOL_PAYLOAD_CHARS = 32 * 1024;

export function safeJson(value: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, null, 2);
  } catch {
    rendered = String(value);
  }
  if (rendered === undefined) return "";
  if (rendered.length <= MAX_TOOL_PAYLOAD_CHARS) return rendered;
  const omitted = rendered.length - MAX_TOOL_PAYLOAD_CHARS;
  return `${rendered.slice(0, MAX_TOOL_PAYLOAD_CHARS)}\n… ${omitted.toLocaleString()} more characters truncated by Studio; the full payload is in the durable session.`;
}
