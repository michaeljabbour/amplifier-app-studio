export type TerminalId = string;

export interface TerminalHostIdentity {
  id: string;
  label: string;
  kind: "local" | "remote";
  transport: "native" | "network";
}

export interface TerminalProjectIdentity {
  id: string;
  label: string;
  root: string;
  repository?: string;
}

export type TerminalInputAuthorization = "input" | "read-only" | "unavailable";

export interface TerminalCapabilities {
  list: boolean;
  create: boolean;
  attach: boolean;
  detach: boolean;
  terminate: boolean;
  rename: boolean;
  capture: boolean;
  send: TerminalInputAuthorization;
  resize: boolean;
  reconnect: boolean;
  independentAttachments: boolean;
  scrollbackPaging: boolean;
  maxCaptureLines?: number;
  supportedKeys: readonly string[];
  /** Live attachments emit an ANSI stream or complete replacement frames. */
  outputMode?: "stream" | "snapshot";
}

export interface TerminalAttentionState {
  needsAttention: boolean;
  unseenCount: number;
  lastFiredAt?: number;
  seenAt?: number;
  source?: string;
}

export interface TerminalScrollbackState {
  start: number;
  rowCount: number;
  total: number;
  hasMore: boolean;
  saturated: boolean;
  pageSize: number;
}

export type TerminalConnectionStatus =
  | "detached"
  | "attaching"
  | "attached"
  | "reconnecting"
  | "read-only"
  | "error"
  | "terminated";

export interface TerminalConnectionState {
  status: TerminalConnectionStatus;
  generation: number;
  reconnectAttempt: number;
  lastConnectedAt?: number;
  lastDataAt?: number;
  message?: string;
}

export interface TerminalSession {
  id: TerminalId;
  backendId: string;
  name: string;
  host: TerminalHostIdentity;
  project?: TerminalProjectIdentity;
  cwd?: string;
  createdAt?: number;
  lastActivityAt?: number;
  snapshot: string;
  liveOutput: string;
  attention: TerminalAttentionState;
  scrollback?: TerminalScrollbackState;
  connection: TerminalConnectionState;
  capabilities: TerminalCapabilities;
}

export interface CreateTerminalRequest {
  name: string;
  project?: TerminalProjectIdentity;
  commandProfile?: string;
}

export interface CaptureTerminalRequest {
  lines?: number;
  before?: number;
}

export interface TerminalCapture {
  snapshot: string;
  scrollback: TerminalScrollbackState;
  cursor?: { column: number; row: number };
  paneHeight?: number;
}

export interface TerminalInputRequest {
  text?: string;
  keys?: readonly string[];
  enter?: boolean;
  captureLines?: number;
  /**
   * `interactive` is a low-latency PTY keystroke stream. `command` uses the
   * backend's auditable input endpoint and can return a fresh snapshot.
   */
  mode?: "interactive" | "command";
}

export interface TerminalInputResult {
  snapshot?: string;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface TerminalAttachmentObserver {
  onOpen: () => void;
  onData: (data: string) => void;
  /** Replace the terminal screen instead of appending a stream delta. */
  onSnapshot?: (snapshot: string) => void;
  onClose: (event: { code?: number; reason?: string; expected?: boolean }) => void;
  onError: (error: Error) => void;
}

export interface TerminalAttachment {
  close: () => void;
}

/** Backend-neutral boundary implemented by MuxPlex today and other PTY hosts later. */
export interface TerminalBackend {
  readonly host: TerminalHostIdentity;
  readonly project?: TerminalProjectIdentity;
  readonly capabilities: TerminalCapabilities;

  list(): Promise<TerminalSession[]>;
  create(request: CreateTerminalRequest): Promise<TerminalSession>;
  attach(terminal: TerminalSession, observer: TerminalAttachmentObserver): Promise<TerminalAttachment>;
  detach(terminal: TerminalSession): Promise<void>;
  terminate(terminal: TerminalSession): Promise<void>;
  rename(terminal: TerminalSession, name: string): Promise<TerminalSession>;
  capture(terminal: TerminalSession, request?: CaptureTerminalRequest): Promise<TerminalCapture>;
  send(terminal: TerminalSession, request: TerminalInputRequest): Promise<TerminalInputResult>;
  resize(terminal: TerminalSession, size: TerminalSize): Promise<void>;
}

export interface TerminalCoordinatorSnapshot {
  sessions: readonly TerminalSession[];
  selectedId?: TerminalId;
  refreshing: boolean;
  error?: string;
}

export interface TerminalCoordinatorContract {
  snapshot(): TerminalCoordinatorSnapshot;
  subscribe(listener: (snapshot: TerminalCoordinatorSnapshot) => void): () => void;
  select(id: TerminalId | undefined): void;
  refresh(): Promise<readonly TerminalSession[]>;
  create(request: CreateTerminalRequest): Promise<TerminalSession>;
  attach(id: TerminalId): Promise<void>;
  reconnect(id: TerminalId): Promise<void>;
  detach(id: TerminalId): Promise<void>;
  terminate(id: TerminalId): Promise<void>;
  rename(id: TerminalId, name: string): Promise<TerminalSession>;
  capture(id: TerminalId, request?: CaptureTerminalRequest): Promise<TerminalCapture>;
  loadOlder(id: TerminalId, lines?: number): Promise<TerminalCapture | undefined>;
  send(id: TerminalId, request: TerminalInputRequest): Promise<TerminalInputResult>;
  resize(id: TerminalId, size: TerminalSize): Promise<void>;
  dispose(): void;
}

export class TerminalAuthorizationError extends Error {
  readonly operation: "send" | "rename" | "terminate";

  constructor(operation: "send" | "rename" | "terminate", message: string) {
    super(message);
    this.name = "TerminalAuthorizationError";
    this.operation = operation;
  }
}

export function terminalId(hostId: string, backendId: string): TerminalId {
  return `${hostId}::${encodeURIComponent(backendId)}`;
}

export function detachedConnection(): TerminalConnectionState {
  return { status: "detached", generation: 0, reconnectAttempt: 0 };
}
