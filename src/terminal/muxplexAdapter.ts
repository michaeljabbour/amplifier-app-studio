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
import { detachedConnection, TerminalAuthorizationError, terminalId } from "./types";

export interface MuxplexHttpRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface MuxplexSocketRequest {
  path: string;
  query?: Record<string, string | undefined>;
  protocols: readonly string[];
}

export type MuxplexSocketData = string | ArrayBuffer | Uint8Array;

export interface MuxplexSocketObserver {
  onOpen: () => void;
  onMessage: (data: MuxplexSocketData) => void;
  onClose: (event: { code?: number; reason?: string }) => void;
  onError: (error: Error) => void;
}

export interface MuxplexSocket {
  send(data: string | Uint8Array): void;
  close(code?: number): void;
}

/**
 * Credential-bearing I/O is injected by the native host. Implementations must
 * add auth headers/cookies internally and must never serialize secrets into a
 * URL or web storage. The adapter only supplies relative public API paths.
 */
export interface MuxplexTransport {
  request<T>(request: MuxplexHttpRequest): Promise<T>;
  openSocket(request: MuxplexSocketRequest, observer: MuxplexSocketObserver): MuxplexSocket;
}

export class MuxplexTransportError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "MuxplexTransportError";
  }
}

export interface MuxplexAdapterOptions {
  transport: MuxplexTransport;
  host: TerminalHostIdentity;
  project?: TerminalProjectIdentity;
  deviceId?: string;
  /**
   * Must be supplied from host-side policy. Defaulting this to read-only is
   * deliberate because MuxPlex terminal input is remote execution by design.
   */
  inputAuthorization?: "input" | "read-only";
  maxCaptureLines?: number;
}

interface MuxplexBellWire {
  last_fired_at?: number | null;
  seen_at?: number | null;
  unseen_count?: number;
  source?: string | null;
}

interface MuxplexSessionWire {
  name?: unknown;
  snapshot?: unknown;
  bell?: MuxplexBellWire;
  last_activity_at?: number | null;
  created_at?: number | null;
  cwd?: string | null;
}

interface MuxplexSnapshotWire extends MuxplexSessionWire {
  lines?: number;
  start?: number;
  row_count?: number;
  total?: number;
  has_more?: boolean;
  saturated?: boolean;
}

interface MuxplexInputWire {
  snapshot?: string;
}

const MUXPLEX_KEYS = [
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class MuxplexTerminalAdapter implements TerminalBackend {
  readonly host: TerminalHostIdentity;
  readonly project?: TerminalProjectIdentity;
  readonly capabilities: TerminalCapabilities;
  private readonly transport: MuxplexTransport;
  private readonly deviceId?: string;
  private readonly sockets = new Map<string, MuxplexSocket>();

  constructor(options: MuxplexAdapterOptions) {
    this.transport = options.transport;
    this.host = options.host;
    this.project = options.project;
    this.deviceId = options.deviceId;
    this.capabilities = {
      list: true,
      create: true,
      attach: true,
      detach: true,
      terminate: true,
      rename: true,
      capture: true,
      send: options.inputAuthorization || "read-only",
      resize: true,
      reconnect: true,
      independentAttachments: true,
      scrollbackPaging: true,
      maxCaptureLines: options.maxCaptureLines || 5_000,
      supportedKeys: MUXPLEX_KEYS,
    };
  }

  async list(): Promise<TerminalSession[]> {
    const response = await this.transport.request<unknown>({ method: "GET", path: "/api/sessions" });
    if (!Array.isArray(response)) throw new Error("MuxPlex returned an invalid session list");
    return response.map((wire) => this.sessionFromWire(requireSessionWire(wire)));
  }

  async create(request: CreateTerminalRequest): Promise<TerminalSession> {
    const body: Record<string, string> = { name: request.name };
    if (request.commandProfile) body.command_id = request.commandProfile;
    const response = await this.transport.request<MuxplexSessionWire>({
      method: "POST",
      path: "/api/sessions",
      body,
    });
    return this.sessionFromWire({
      name: typeof response.name === "string" ? response.name : request.name,
      snapshot: "",
      cwd: request.project?.root || this.project?.root,
    });
  }

  async attach(terminal: TerminalSession, observer: TerminalAttachmentObserver): Promise<TerminalAttachment> {
    const query = this.deviceId ? { device_id: this.deviceId } : undefined;
    await this.transport.request({
      method: "POST",
      path: `/api/sessions/${segment(terminal.backendId)}/connect`,
      query,
    });

    let expectedClose = false;
    let socket: MuxplexSocket;
    socket = this.transport.openSocket({
      path: "/terminal/ws",
      query: { session: terminal.backendId, device_id: this.deviceId },
      protocols: ["tty"],
    }, {
      onOpen: () => {
        socket.send(JSON.stringify({ AuthToken: "" }));
        observer.onOpen();
      },
      onMessage: (data) => {
        const output = decodeTtydOutput(data);
        if (output) observer.onData(output);
      },
      onClose: (event) => {
        if (this.sockets.get(terminal.id) === socket) this.sockets.delete(terminal.id);
        observer.onClose({ ...event, expected: expectedClose });
      },
      onError: observer.onError,
    });
    this.sockets.set(terminal.id, socket);

    return {
      close: () => {
        expectedClose = true;
        if (this.sockets.get(terminal.id) === socket) this.sockets.delete(terminal.id);
        socket.close(1000);
      },
    };
  }

  async detach(_terminal: TerminalSession): Promise<void> {
    // Closing this Studio attachment is the detach. Deliberately do not call
    // DELETE /api/sessions/current: that endpoint clears group-global state and
    // could disrupt another explicitly-addressed terminal attached in Studio.
  }

  async terminate(terminal: TerminalSession): Promise<void> {
    try {
      await this.transport.request({
        method: "DELETE",
        path: `/api/sessions/${segment(terminal.backendId)}`,
      });
    } catch (error) {
      throw mapAuthorizationError("terminate", error);
    }
  }

  async rename(terminal: TerminalSession, name: string): Promise<TerminalSession> {
    if (!name) throw new Error("Terminal name cannot be empty");
    try {
      const response = await this.transport.request<{ name?: unknown }>({
        method: "POST",
        path: `/api/sessions/${segment(terminal.backendId)}/rename`,
        body: { new_name: name },
      });
      const renamed = typeof response.name === "string" ? response.name : name;
      return {
        ...terminal,
        id: terminalId(this.host.id, renamed),
        backendId: renamed,
        name: renamed,
        liveOutput: "",
        connection: detachedConnection(),
      };
    } catch (error) {
      throw mapAuthorizationError("rename", error);
    }
  }

  async capture(terminal: TerminalSession, request: CaptureTerminalRequest = {}): Promise<TerminalCapture> {
    const lines = clampCaptureLines(request.lines || 200, this.capabilities.maxCaptureLines || 5_000);
    const response = await this.transport.request<MuxplexSnapshotWire>({
      method: "GET",
      path: `/api/sessions/${segment(terminal.backendId)}`,
      query: { lines, before: request.before },
    });
    const snapshot = typeof response.snapshot === "string" ? response.snapshot : "";
    const rowCount = integer(response.row_count, countRows(snapshot));
    const total = integer(response.total, rowCount);
    const start = integer(response.start, Math.max(0, total - rowCount));
    return {
      snapshot,
      scrollback: {
        start,
        rowCount,
        total,
        hasMore: response.has_more === true,
        saturated: response.saturated === true,
        pageSize: lines,
      },
    };
  }

  async send(terminal: TerminalSession, request: TerminalInputRequest): Promise<TerminalInputResult> {
    if (this.capabilities.send !== "input") {
      throw new TerminalAuthorizationError("send", "MuxPlex input is not authorized for this Studio host");
    }

    if (request.mode === "interactive") {
      const socket = this.sockets.get(terminal.id);
      if (!socket) throw new Error(`${terminal.name} is not attached`);
      if (request.text) socket.send(encodeTtydFrame(0x30, request.text));
      if (request.keys?.length || request.enter) {
        throw new Error("Interactive named keys use command mode so MuxPlex can enforce its input fence");
      }
      return {};
    }

    try {
      const response = await this.transport.request<MuxplexInputWire>({
        method: "POST",
        path: `/api/sessions/${segment(terminal.backendId)}/input`,
        body: {
          text: request.text || "",
          keys: [...(request.keys || [])],
          enter: request.enter === true,
          ...(request.captureLines ? { lines: request.captureLines } : {}),
        },
      });
      return { snapshot: typeof response.snapshot === "string" ? response.snapshot : undefined };
    } catch (error) {
      throw mapAuthorizationError("send", error);
    }
  }

  async resize(terminal: TerminalSession, size: TerminalSize): Promise<void> {
    const socket = this.sockets.get(terminal.id);
    if (!socket) return;
    socket.send(encodeTtydFrame(0x31, JSON.stringify({ columns: size.columns, rows: size.rows })));
  }

  private sessionFromWire(wire: MuxplexSessionWire): TerminalSession {
    const name = String(wire.name);
    const cwd = typeof wire.cwd === "string" && wire.cwd ? wire.cwd : undefined;
    const bell = wire.bell || {};
    const lastFiredAt = numberOrUndefined(bell.last_fired_at);
    const seenAt = numberOrUndefined(bell.seen_at);
    const unseenCount = integer(bell.unseen_count, 0);
    const needsAttention = unseenCount > 0 && (seenAt === undefined || (lastFiredAt !== undefined && lastFiredAt > seenAt));
    return {
      id: terminalId(this.host.id, name),
      backendId: name,
      name,
      host: this.host,
      project: projectFor(cwd, this.host, this.project),
      cwd,
      createdAt: numberOrUndefined(wire.created_at),
      lastActivityAt: numberOrUndefined(wire.last_activity_at),
      snapshot: typeof wire.snapshot === "string" ? wire.snapshot : "",
      liveOutput: "",
      attention: {
        needsAttention,
        unseenCount,
        lastFiredAt,
        seenAt,
        source: typeof bell.source === "string" ? bell.source : undefined,
      },
      connection: detachedConnection(),
      capabilities: { ...this.capabilities },
    };
  }
}

function requireSessionWire(value: unknown): MuxplexSessionWire {
  if (!value || typeof value !== "object" || typeof (value as MuxplexSessionWire).name !== "string") {
    throw new Error("MuxPlex returned an invalid terminal session");
  }
  return value as MuxplexSessionWire;
}

function projectFor(
  cwd: string | undefined,
  host: TerminalHostIdentity,
  configured: TerminalProjectIdentity | undefined,
): TerminalProjectIdentity | undefined {
  if (!cwd) return configured;
  if (configured && (cwd === configured.root || cwd.startsWith(`${configured.root.replace(/\/$/, "")}/`))) return configured;
  return {
    id: `${host.id}:${cwd}`,
    label: cwd.split("/").filter(Boolean).at(-1) || cwd,
    root: cwd,
  };
}

function decodeTtydOutput(data: MuxplexSocketData): string {
  if (typeof data === "string") return data;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) return "";
  return bytes[0] === 0x30 ? decoder.decode(bytes.subarray(1)) : "";
}

function encodeTtydFrame(type: number, value: string): Uint8Array {
  const body = encoder.encode(value);
  const frame = new Uint8Array(body.length + 1);
  frame[0] = type;
  frame.set(body, 1);
  return frame;
}

function mapAuthorizationError(operation: "send" | "rename" | "terminate", error: unknown): Error {
  if (error instanceof MuxplexTransportError && error.status === 403) {
    return new TerminalAuthorizationError(operation, error.message || `MuxPlex denied terminal ${operation}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function countRows(value: string): number {
  return value ? value.split("\n").length : 0;
}

function clampCaptureLines(lines: number, maximum: number): number {
  return Math.min(maximum, Math.max(1, Math.floor(lines)));
}
