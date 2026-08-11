import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CapabilityCatalog, NewSessionInput, ProtocolRecord, StoredSession } from "./protocol";
import { isRecord } from "./protocol";

export interface ProcessLog {
  stream: string;
  message: string;
}

export interface ProcessExit {
  code?: number;
  message: string;
}

export interface SessionHandlers {
  onRecord: (record: ProtocolRecord) => void;
  onLog: (log: ProcessLog) => void;
  onExit: (exit: ProcessExit) => void;
}

export interface SessionConnection {
  dispose: () => void;
}

export interface StartSessionOptions extends NewSessionInput {
  guiId: string;
}

export interface RuntimeStatus {
  installed: boolean;
  executable?: string;
  version?: string;
  installSupported: boolean;
  message: string;
}

interface BridgeConnection extends SessionConnection {
  socket: WebSocket;
}

interface BridgeEnvelope {
  type?: string;
  channel?: string;
  payload?: unknown;
  message?: string;
}

const bridgeConnections = new Map<string, BridgeConnection>();
const BRIDGE_STORAGE_KEY = "amplifier-studio.bridge-url";

export function createGuiId(): string {
  return crypto.randomUUID();
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function usesWebBridge(): boolean {
  return bridgeBaseUrl() !== undefined;
}

export function configuredBridgeUrl(): string {
  return new URLSearchParams(window.location.search).get("bridge")
    || localStorage.getItem(BRIDGE_STORAGE_KEY)
    || import.meta.env.VITE_STUDIO_BRIDGE_URL
    || "";
}

export function saveBridgeUrl(value: string): void {
  const cleaned = value.trim().replace(/\/$/, "");
  if (!cleaned) {
    localStorage.removeItem(BRIDGE_STORAGE_KEY);
    return;
  }
  const url = new URL(cleaned);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Bridge URL must start with https:// (or http:// for local development)");
  }
  localStorage.setItem(BRIDGE_STORAGE_KEY, url.toString().replace(/\/$/, ""));
}

export function transportLabel(): string {
  if (usesWebBridge()) return isTauriRuntime() ? "Native mobile · remote Rust bridge" : "Web · local Rust bridge";
  return "Native desktop · local Rust bridge";
}

export async function launchSession(
  options: StartSessionOptions,
  handlers: SessionHandlers,
): Promise<SessionConnection> {
  const bridge = bridgeBaseUrl();
  if (bridge) return launchBridgeSession(bridge, options, handlers);

  requireTauri();
  const unlisten = await Promise.all([
    listen<unknown>(`session://${options.guiId}/record`, (event) => {
      if (isRecord(event.payload)) handlers.onRecord(event.payload);
    }),
    listen<ProcessLog>(`session://${options.guiId}/log`, (event) => handlers.onLog(event.payload)),
    listen<ProcessExit>(`session://${options.guiId}/exit`, (event) => handlers.onExit(event.payload)),
  ]);

  try {
    await invoke("start_session", { options: wireOptions(options) });
  } catch (error) {
    unlisten.forEach((dispose) => dispose());
    throw error;
  }
  return { dispose: () => unlisten.forEach((stop) => stop()) };
}

export async function sendOp(guiId: string, op: Record<string, unknown>): Promise<void> {
  const connection = bridgeConnections.get(guiId);
  if (connection) {
    sendBridge(connection.socket, { type: "op", op });
    return;
  }
  requireTauri();
  await invoke("send_op", { guiId, op });
}

export async function stopSession(guiId: string): Promise<boolean> {
  const connection = bridgeConnections.get(guiId);
  if (connection) {
    sendBridge(connection.socket, { type: "stop" });
    return true;
  }
  requireTauri();
  return invoke<boolean>("stop_session", { guiId });
}

export async function listStoredSessions(projectDir?: string): Promise<StoredSession[]> {
  const bridge = bridgeBaseUrl();
  if (bridge) {
    const url = new URL("/api/stored-sessions", bridge);
    const project = clean(projectDir);
    if (project) url.searchParams.set("projectDir", project);
    return fetchJson<StoredSession[]>(url);
  }
  requireTauri();
  return invoke<StoredSession[]>("list_stored_sessions", { projectDir: clean(projectDir) });
}

export async function listCatalog(projectDir?: string): Promise<CapabilityCatalog> {
  const bridge = bridgeBaseUrl();
  if (bridge) {
    const url = new URL("/api/catalog", bridge);
    const project = clean(projectDir);
    if (project) url.searchParams.set("projectDir", project);
    return fetchJson<CapabilityCatalog>(url);
  }
  requireTauri();
  return invoke<CapabilityCatalog>("list_catalog", { projectDir: clean(projectDir) });
}

export async function defaultProjectDir(): Promise<string> {
  const bridge = bridgeBaseUrl();
  if (bridge) {
    const config = await fetchJson<{ defaultProjectDir?: string }>(new URL("/api/config", bridge));
    return config.defaultProjectDir || "";
  }
  if (!isTauriRuntime()) return "";
  return invoke<string>("default_project_dir");
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const bridge = bridgeBaseUrl();
  if (bridge) return fetchJson<RuntimeStatus>(new URL("/api/runtime", bridge));
  requireTauri();
  return invoke<RuntimeStatus>("runtime_status");
}

export async function installRuntime(): Promise<RuntimeStatus> {
  if (bridgeBaseUrl()) {
    throw new Error("Install the runtime on the Rust bridge host; remote installation is intentionally disabled");
  }
  requireTauri();
  return invoke<RuntimeStatus>("install_runtime");
}

async function launchBridgeSession(
  bridge: string,
  options: StartSessionOptions,
  handlers: SessionHandlers,
): Promise<SessionConnection> {
  const url = new URL(`/api/session/${encodeURIComponent(options.guiId)}`, bridge);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  let disposed = false;
  let ready = false;
  let sawExit = false;

  const connection: BridgeConnection = {
    socket,
    dispose: () => {
      disposed = true;
      bridgeConnections.delete(options.guiId);
      socket.close(1000, "session view closed");
    },
  };
  bridgeConnections.set(options.guiId, connection);

  return new Promise<SessionConnection>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (!ready) fail(new Error("The Rust bridge did not acknowledge the session start"));
    }, 15_000);

    const fail = (error: Error) => {
      window.clearTimeout(timer);
      bridgeConnections.delete(options.guiId);
      disposed = true;
      socket.close();
      reject(error);
    };

    socket.addEventListener("open", () => {
      sendBridge(socket, { type: "start", options: wireOptions(options) });
    });
    socket.addEventListener("message", (event) => {
      let envelope: BridgeEnvelope;
      try {
        envelope = JSON.parse(String(event.data)) as BridgeEnvelope;
      } catch {
        handlers.onLog({ stream: "bridge", message: "The Rust bridge sent invalid JSON" });
        return;
      }

      if (envelope.type === "ready") {
        ready = true;
        window.clearTimeout(timer);
        resolve(connection);
        return;
      }
      if (envelope.type === "error") {
        const error = new Error(envelope.message || "Rust bridge error");
        if (!ready) fail(error);
        else handlers.onLog({ stream: "bridge", message: error.message });
        return;
      }
      if (envelope.type !== "event") return;

      if (envelope.channel === "record" && isRecord(envelope.payload)) {
        handlers.onRecord(envelope.payload);
      } else if (envelope.channel === "log" && isProcessLog(envelope.payload)) {
        handlers.onLog(envelope.payload);
      } else if (envelope.channel === "exit" && isProcessExit(envelope.payload)) {
        sawExit = true;
        handlers.onExit(envelope.payload);
      }
    });
    socket.addEventListener("error", () => {
      if (!ready) fail(new Error(`Could not connect to the Rust bridge at ${bridge}`));
    });
    socket.addEventListener("close", () => {
      window.clearTimeout(timer);
      bridgeConnections.delete(options.guiId);
      if (!ready && !disposed) reject(new Error(`The Rust bridge at ${bridge} closed during startup`));
      else if (!disposed && !sawExit) handlers.onExit({ message: "Connection to the Rust bridge closed" });
    });
  });
}

function bridgeBaseUrl(): string | undefined {
  const queryValue = new URLSearchParams(window.location.search).get("bridge");
  if (queryValue) localStorage.setItem(BRIDGE_STORAGE_KEY, queryValue);
  const configured = queryValue
    || localStorage.getItem(BRIDGE_STORAGE_KEY)
    || import.meta.env.VITE_STUDIO_BRIDGE_URL
    || (isTauriRuntime() ? undefined : window.location.origin);
  if (!configured) return undefined;
  try {
    const url = new URL(configured, window.location.origin);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function wireOptions(options: StartSessionOptions): Record<string, unknown> {
  return {
    guiId: options.guiId,
    projectDir: options.projectDir,
    bundle: clean(options.bundle),
    model: clean(options.model),
    provider: clean(options.provider),
    mode: clean(options.mode),
    resumeId: clean(options.resumeId),
  };
}

function sendBridge(socket: WebSocket, value: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) throw new Error("The Rust bridge connection is not open");
  socket.send(JSON.stringify(value));
}

async function fetchJson<T>(url: URL): Promise<T> {
  const response = await fetch(url);
  const value = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw new Error(value?.error || `Bridge request failed (${response.status})`);
  return value as T;
}

function isProcessLog(value: unknown): value is ProcessLog {
  return isRecord(value) && typeof value.stream === "string" && typeof value.message === "string";
}

function isProcessExit(value: unknown): value is ProcessExit {
  return isRecord(value)
    && (value.code === undefined || typeof value.code === "number")
    && typeof value.message === "string";
}

function clean(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function requireTauri(): void {
  if (!isTauriRuntime()) {
    throw new Error("No local Rust bridge is available. Run `npm run web:serve` or launch the Tauri app.");
  }
}

export type { UnlistenFn };
