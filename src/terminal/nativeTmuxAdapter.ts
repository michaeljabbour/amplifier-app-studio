import { invoke } from "@tauri-apps/api/core";
import type {
  CaptureTerminalRequest,
  CreateTerminalRequest,
  TerminalAttachment,
  TerminalAttachmentObserver,
  TerminalBackend,
  TerminalCapabilities,
  TerminalCapture,
  TerminalHostIdentity,
  TerminalInputRequest,
  TerminalInputResult,
  TerminalProjectIdentity,
  TerminalSession,
  TerminalSize,
} from "./types";
import { detachedConnection, terminalId } from "./types";

const MAX_CAPTURE_LINES = 5_000;
const DEFAULT_CAPTURE_LINES = 400;
const MAX_INPUT_BYTES = 64 * 1024;
const LOCAL_TMUX_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "C-c",
  "C-d",
  "Up",
  "Down",
  "Left",
  "Right",
  "PageUp",
  "PageDown",
] as const;
const LOCAL_TMUX_KEY_SET = new Set<string>(LOCAL_TMUX_KEYS);
const LOCAL_TMUX_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const LOCAL_TMUX_SESSION_ID = /^\$[0-9]{1,20}$/;
const LOCAL_TMUX_PANE_ID = /^%[0-9]{1,20}$/;

export type NativeTmuxInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface NativeTmuxSessionWire {
  name: string;
  sessionId: string;
  paneId: string;
  createdAt?: number;
  lastActivityAt?: number;
  cwd?: string;
}

interface NativeTmuxCaptureWire {
  snapshot: string;
  historySize: number;
  paneHeight: number;
  cursorX?: number;
  cursorY?: number;
}

interface PollAttachment {
  closed: boolean;
  previousFrame: string;
  observer: TerminalAttachmentObserver;
  timer?: ReturnType<typeof setTimeout>;
}

interface NativeTmuxBinding {
  sessionId: string;
  paneId: string;
  studioOwned: boolean;
}

export interface NativeTmuxAdapterOptions {
  host: TerminalHostIdentity;
  project?: TerminalProjectIdentity;
  invoke?: NativeTmuxInvoke;
  pollIntervalMs?: number;
  maxCaptureLines?: number;
}

/**
 * Backend-neutral adapter for Studio's credential-free local tmux commands.
 *
 * Rust only validates bounded arguments and launches literal `tmux` argv.
 * This adapter owns polling attachment state; the coordinator above it owns
 * connection generations, reconnect, selection, and presentation state.
 */
export class NativeTmuxAdapter implements TerminalBackend {
  readonly host: TerminalHostIdentity;
  readonly project?: TerminalProjectIdentity;
  readonly capabilities: TerminalCapabilities;
  private readonly invokeNative: NativeTmuxInvoke;
  private readonly pollIntervalMs: number;
  private readonly attachments = new Map<string, PollAttachment>();
  private readonly bindings = new Map<string, NativeTmuxBinding>();

  constructor(options: NativeTmuxAdapterOptions) {
    if (options.host.kind !== "local" || options.host.transport !== "native") {
      throw new Error("Native tmux requires a local native Studio host");
    }
    this.host = options.host;
    this.project = options.project;
    this.invokeNative = options.invoke || invoke;
    this.pollIntervalMs = clampInteger(options.pollIntervalMs || 650, 100, 10_000);
    this.capabilities = {
      list: true,
      create: true,
      attach: true,
      detach: true,
      terminate: true,
      rename: true,
      capture: true,
      send: "input",
      // Existing tmux sessions may be attached in Terminal or MUX Plex.
      // Session-level capabilities opt in only sessions this instance creates.
      resize: false,
      reconnect: true,
      independentAttachments: true,
      scrollbackPaging: false,
      maxCaptureLines: clampInteger(options.maxCaptureLines || MAX_CAPTURE_LINES, 1, MAX_CAPTURE_LINES),
      supportedKeys: LOCAL_TMUX_KEYS,
      outputMode: "snapshot",
    };
  }

  async list(): Promise<TerminalSession[]> {
    const response = await this.invokeNative<unknown>("terminal_tmux_list");
    if (!Array.isArray(response)) throw new Error("Studio's tmux bridge returned an invalid session list");
    return response.map((value) => this.sessionFromWire(requireSessionWire(value), false));
  }

  async create(request: CreateTerminalRequest): Promise<TerminalSession> {
    const name = requireExactTmuxName(request.name);
    if (request.commandProfile && request.commandProfile !== "default") {
      throw new Error("Local tmux does not run configurable command profiles; it starts the user's default shell");
    }
    const project = request.project || this.project;
    const response = await this.invokeNative<unknown>("terminal_tmux_create", {
      name,
      projectDir: project?.root,
    });
    const wire = requireSessionWire(response);
    if (wire.name !== name) throw new Error("Studio's tmux bridge returned a different session than it created");
    return this.sessionFromWire(wire, true);
  }

  async attach(terminal: TerminalSession, observer: TerminalAttachmentObserver): Promise<TerminalAttachment> {
    const name = requireExactTmuxName(terminal.backendId);
    this.attachments.get(terminal.id)?.observer.onClose({ code: 1000, reason: "Attachment replaced", expected: true });
    this.closePoller(terminal.id);

    const initial = await this.capture(terminal, { lines: DEFAULT_CAPTURE_LINES });
    const initialFrame = terminalSnapshotFrame(initial);
    const poller: PollAttachment = {
      closed: false,
      previousFrame: initialFrame,
      observer,
    };
    this.attachments.set(terminal.id, poller);
    observer.onOpen();
    if (initialFrame && initialFrame !== terminal.snapshot) {
      publishSnapshot(observer, initialFrame);
    }

    const poll = async () => {
      if (poller.closed) return;
      try {
        const next = await this.capture(terminal, { lines: DEFAULT_CAPTURE_LINES });
        if (poller.closed) return;
        const frame = terminalSnapshotFrame(next);
        if (frame !== poller.previousFrame) {
          poller.previousFrame = frame;
          publishSnapshot(observer, frame);
        }
        this.schedulePoll(poller, poll);
      } catch (error) {
        if (poller.closed) return;
        poller.closed = true;
        this.attachments.delete(terminal.id);
        const message = nativeTmuxErrorMessage(error);
        observer.onClose({
          code: message.includes("TMUX_SESSION_NOT_FOUND") ? 4404 : 1006,
          reason: message.replace(/^TMUX_SESSION_NOT_FOUND:\s*/, ""),
          expected: false,
        });
      }
    };
    this.schedulePoll(poller, poll);

    return {
      close: () => {
        if (poller.closed) return;
        poller.closed = true;
        this.closePoller(terminal.id);
        observer.onClose({ code: 1000, reason: `${name} detached`, expected: true });
      },
    };
  }

  async detach(_terminal: TerminalSession): Promise<void> {
    // The coordinator closes this Studio poller before calling detach. tmux
    // remains alive; there is no native detach or global-selection command.
  }

  async terminate(terminal: TerminalSession): Promise<void> {
    await this.invokeNative("terminal_tmux_terminate", {
      name: requireExactTmuxName(terminal.backendId),
    });
    this.bindings.delete(terminal.id);
  }

  async rename(terminal: TerminalSession, name: string): Promise<TerminalSession> {
    const oldName = requireExactTmuxName(terminal.backendId);
    const newName = requireExactTmuxName(name);
    if (oldName === newName) return terminal;
    const binding = this.bindingFor(terminal);
    await this.invokeNative("terminal_tmux_rename", { name: oldName, newName });
    const renamed = {
      ...terminal,
      id: terminalId(this.host.id, newName),
      backendId: newName,
      name: newName,
      liveOutput: "",
      connection: detachedConnection(),
    };
    this.bindings.delete(terminal.id);
    this.bindings.set(renamed.id, binding);
    return renamed;
  }

  async capture(terminal: TerminalSession, request: CaptureTerminalRequest = {}): Promise<TerminalCapture> {
    if (request.before !== undefined) {
      throw new Error("Native tmux exposes a bounded live capture but not stable absolute scrollback cursors");
    }
    const lines = clampInteger(
      request.lines || DEFAULT_CAPTURE_LINES,
      1,
      this.capabilities.maxCaptureLines || MAX_CAPTURE_LINES,
    );
    const response = await this.invokeNative<NativeTmuxCaptureWire>("terminal_tmux_capture", {
      name: requireExactTmuxName(terminal.backendId),
      paneId: this.bindingFor(terminal).paneId,
      lines,
    });
    if (!response || typeof response.snapshot !== "string") {
      throw new Error("Studio's tmux bridge returned an invalid capture");
    }
    const rowCount = countRows(response.snapshot);
    const total = Math.max(rowCount, integer(response.historySize) + integer(response.paneHeight));
    return {
      snapshot: response.snapshot,
      cursor: {
        column: integer(response.cursorX),
        row: integer(response.cursorY),
      },
      paneHeight: Math.max(1, integer(response.paneHeight)),
      scrollback: {
        start: Math.max(0, total - rowCount),
        rowCount,
        total,
        hasMore: false,
        saturated: total > rowCount,
        pageSize: lines,
      },
    };
  }

  async send(terminal: TerminalSession, request: TerminalInputRequest): Promise<TerminalInputResult> {
    const text = request.text || "";
    if (new TextEncoder().encode(text).byteLength > MAX_INPUT_BYTES) {
      throw new Error(`Terminal input cannot exceed ${MAX_INPUT_BYTES} UTF-8 bytes`);
    }
    const keys = [...(request.keys || [])];
    for (const key of keys) {
      if (!LOCAL_TMUX_KEY_SET.has(key)) throw new Error(`Unsupported terminal key: ${key}`);
    }
    if (!text && !keys.length && !request.enter) throw new Error("Terminal input cannot be empty");
    await this.invokeNative("terminal_tmux_send", {
      name: requireExactTmuxName(terminal.backendId),
      paneId: this.bindingFor(terminal).paneId,
      text: text || undefined,
      keys,
      enter: request.enter === true,
    });

    // An attached poller owns the snapshot progression and emits only its
    // delta. Returning a second snapshot here would duplicate the same output
    // in TerminalCoordinator's `snapshot + liveOutput` view.
    if (request.captureLines && !this.attachments.has(terminal.id)) {
      const captured = await this.capture(terminal, { lines: request.captureLines });
      return { snapshot: captured.snapshot };
    }
    return {};
  }

  async resize(terminal: TerminalSession, size: TerminalSize): Promise<void> {
    const binding = this.bindingFor(terminal);
    if (!binding.studioOwned) {
      throw new Error("Studio does not resize tmux sessions created outside this Studio window");
    }
    await this.invokeNative("terminal_tmux_resize", {
      name: requireExactTmuxName(terminal.backendId),
      paneId: binding.paneId,
      columns: clampInteger(size.columns, 2, 1_000),
      rows: clampInteger(size.rows, 1, 1_000),
    });
  }

  private sessionFromWire(wire: NativeTmuxSessionWire, studioOwned: boolean): TerminalSession {
    const name = requireExactTmuxName(wire.name);
    const sessionId = requireTmuxIdentity(wire.sessionId, LOCAL_TMUX_SESSION_ID, "session");
    const paneId = requireTmuxIdentity(wire.paneId, LOCAL_TMUX_PANE_ID, "pane");
    const cwd = typeof wire.cwd === "string" && wire.cwd ? wire.cwd : undefined;
    const id = terminalId(this.host.id, name);
    const existing = this.bindings.get(id);
    const binding = existing?.sessionId === sessionId
      ? { ...existing, studioOwned: existing.studioOwned || studioOwned }
      : { sessionId, paneId, studioOwned };
    this.bindings.set(id, binding);
    return {
      id,
      backendId: name,
      name,
      host: this.host,
      project: projectFor(cwd, this.host, this.project),
      cwd,
      createdAt: finiteNumber(wire.createdAt),
      lastActivityAt: finiteNumber(wire.lastActivityAt),
      snapshot: "",
      liveOutput: "",
      attention: { needsAttention: false, unseenCount: 0 },
      connection: detachedConnection(),
      capabilities: { ...this.capabilities, resize: binding.studioOwned },
    };
  }

  private bindingFor(terminal: TerminalSession): NativeTmuxBinding {
    const binding = this.bindings.get(terminal.id);
    if (!binding) throw new Error(`${terminal.name} has no stable tmux pane identity; refresh terminals`);
    return binding;
  }

  private schedulePoll(poller: PollAttachment, poll: () => Promise<void>): void {
    if (!poller.closed) poller.timer = setTimeout(() => void poll(), this.pollIntervalMs);
  }

  private closePoller(id: string): void {
    const poller = this.attachments.get(id);
    if (!poller) return;
    poller.closed = true;
    if (poller.timer !== undefined) clearTimeout(poller.timer);
    this.attachments.delete(id);
  }
}

export function requireExactTmuxName(value: string): string {
  if (!LOCAL_TMUX_NAME.test(value)) {
    throw new Error(
      "Terminal names must be 1-64 ASCII letters, numbers, underscores, or hyphens and cannot start with a hyphen",
    );
  }
  return value;
}

export function terminalSnapshotFrame(capture: TerminalCapture): string {
  const paneHeight = Math.max(1, capture.paneHeight || capture.scrollback.rowCount || 1);
  const lines = capture.snapshot.replace(/\n$/, "").split("\n");
  const visible = lines.slice(-paneHeight).join("\n");
  const row = Math.min(paneHeight, Math.max(1, (capture.cursor?.row || 0) + 1));
  const column = Math.max(1, (capture.cursor?.column || 0) + 1);
  // RIS clears the emulator's old frame and scrollback so a polled tmux
  // capture replaces the screen instead of accumulating repeated TUI paints.
  return `\x1bc\x1b[?25l${visible}\x1b[${row};${column}H\x1b[?25h`;
}

function publishSnapshot(observer: TerminalAttachmentObserver, frame: string): void {
  if (observer.onSnapshot) observer.onSnapshot(frame);
  else observer.onData(frame);
}

function requireSessionWire(value: unknown): NativeTmuxSessionWire {
  if (
    !value
    || typeof value !== "object"
    || typeof (value as NativeTmuxSessionWire).name !== "string"
    || typeof (value as NativeTmuxSessionWire).sessionId !== "string"
    || typeof (value as NativeTmuxSessionWire).paneId !== "string"
  ) {
    throw new Error("Studio's tmux bridge returned an invalid terminal session");
  }
  return value as NativeTmuxSessionWire;
}

function requireTmuxIdentity(value: string, pattern: RegExp, kind: "session" | "pane"): string {
  if (!pattern.test(value)) throw new Error(`Studio's tmux bridge returned an invalid ${kind} identity`);
  return value;
}

function projectFor(
  cwd: string | undefined,
  host: TerminalHostIdentity,
  configured: TerminalProjectIdentity | undefined,
): TerminalProjectIdentity | undefined {
  if (configured && (!cwd || configured.root === cwd)) return configured;
  if (!cwd) return configured;
  const label = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || cwd;
  return { id: `${host.id}:${cwd}`, label, root: cwd };
}

function countRows(snapshot: string): number {
  if (!snapshot) return 0;
  return snapshot.replace(/\n$/, "").split("\n").length;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function nativeTmuxErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
