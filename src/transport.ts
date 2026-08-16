import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CapabilityCatalog, ComposerAttachment, NewSessionInput, ProtocolRecord, StoredSession } from "./protocol";
import { isRecord } from "./protocol";
import type { RuntimeSettingScope } from "./settingsSchema";
import type { AudioRecording } from "./transcription";

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
  current: boolean;
  executable?: string;
  version?: string;
  adapter: "neutral" | "configured" | "missing";
  installSupported: boolean;
  providerStatusAvailable: boolean;
  providerConfigured: boolean;
  providerMessage: string;
  message: string;
}

export interface RuntimeHost {
  id: string;
  name: string;
  url: string;
  tokenRef: string;
  defaultProjectRoot?: string;
}

export interface RuntimeHostProbe {
  status: RuntimeStatus;
  defaultProjectDir: string;
}

export interface HostDirectoryListing {
  version: number;
  path: string;
  parent?: string;
  roots: string[];
  directories: Array<{ name: string; path: string }>;
}

export interface TranscriptionStatus {
  available: boolean;
  provider?: string;
  model?: string;
  message: string;
}

export interface OutputPreview {
  mediaType: string;
  data: string;
  size?: number;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type NativeAttachment = WithoutId<ComposerAttachment>;

export interface RuntimeSettingValue {
  path: string;
  display: string;
  source: string;
  sourceLabel: string;
}

export interface RuntimeSettingsSnapshot {
  projectDir: string;
  values: RuntimeSettingValue[];
  version: string;
  paths: Record<string, unknown>;
  recentChanges: Record<string, unknown>[];
}

export interface RuntimeSettingChange {
  path: string;
  action: "set" | "unset";
  value?: string;
  scope: RuntimeSettingScope;
}

export type NativeAttachmentDropEvent =
  | { type: "enter" }
  | { type: "leave" }
  | { type: "drop"; attachments: NativeAttachment[] }
  | { type: "error"; message: string };

interface BridgeConnection extends SessionConnection {
  socket: WebSocket;
  disposed: boolean;
  stopRequested: boolean;
  stopCompleted: boolean;
  pendingStop?: {
    promise: Promise<boolean>;
    resolve: (stopped: boolean) => void;
    reject: (error: Error) => void;
    timer: number;
  };
  sawExit: boolean;
  reconnectAttempt: number;
  reconnectTimer?: number;
  lastCursor: number;
  replaying: boolean;
  replayBuffer: BridgeEnvelope[];
  seenEventIds: Set<string>;
  replayCoveredIds: Set<string>;
}

interface BridgeEnvelope {
  version?: number;
  type?: string;
  channel?: string;
  payload?: unknown;
  message?: string;
  stopped?: boolean;
}

const bridgeConnections = new Map<string, BridgeConnection>();
const BRIDGE_STORAGE_KEY = "amplifier-studio.bridge-url";
const BRIDGE_TOKEN_STORAGE_KEY = "amplifier-studio.bridge-token";
const HOST_PROTOCOL_VERSION = 1;
const HOST_API_PREFIX = "/v1/api";
const WS_PROTOCOL = "amplifier-host.v1";
const WS_BEARER_PREFIX = "amplifier-host.bearer.";
const NON_DURABLE_EVENT_KINDS = new Set([
  "stream_block_start",
  "stream_block_delta",
  "stream_block_end",
  "stream_aborted",
]);

export function createGuiId(): string {
  return crypto.randomUUID();
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * Tauri injects `__TAURI_INTERNALS__` on mobile too, so `isTauriRuntime()` alone
 * cannot tell iOS from desktop. Every desktop-only command was guarded on it and
 * therefore fired on iOS, where those commands are `#[cfg(desktop)]`-gated and
 * unregistered -- surfacing as "Command <name> not found".
 */
export function isMobileRuntime(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** A Tauri runtime that actually has the desktop-only commands registered. */
export function isDesktopRuntime(): boolean {
  return isTauriRuntime() && !isMobileRuntime();
}

export function usesWebBridge(): boolean {
  return bridgeBaseUrl() !== undefined;
}

export function configuredBridgeUrl(): string {
  return new URLSearchParams(window.location.search).get("bridge")
    || localStorage.getItem(BRIDGE_STORAGE_KEY)
    || import.meta.env.VITE_STUDIO_BRIDGE_URL
    || (isTauriRuntime() ? "" : window.location.origin)
    || "";
}

export function configuredBridgeToken(bridgeUrl = configuredBridgeUrl()): string {
  const stored = sessionStorage.getItem(BRIDGE_TOKEN_STORAGE_KEY);
  if (!stored) return injectedBridgeToken(bridgeUrl);
  try {
    const parsed = JSON.parse(stored) as {
      bridge?: unknown;
      token?: unknown;
      tokens?: Record<string, unknown>;
    };
    const bridge = normalizedBridgeUrl(bridgeUrl);
    if (!bridge) return "";
    if (parsed.tokens && typeof parsed.tokens[bridge] === "string") return parsed.tokens[bridge] as string;
    if (typeof parsed.token === "string" && parsed.bridge === bridge) return parsed.token;
    return injectedBridgeToken(bridgeUrl);
  } catch {
    return injectedBridgeToken(bridgeUrl);
  }
}

/**
 * Build-time bridge token, the counterpart to VITE_STUDIO_BRIDGE_URL. Simulator
 * and device builds have no way to reach Settings before a session exists, so a
 * test build can carry its own credential.
 *
 * It only applies to the bridge that VITE_STUDIO_BRIDGE_URL names, so a baked
 * token can never be sent to a host chosen at runtime. NEVER set this for a
 * published build: the value is compiled into the bundle in plain text.
 */
function injectedBridgeToken(bridgeUrl: string): string {
  const token = import.meta.env.VITE_STUDIO_BRIDGE_TOKEN;
  if (!token) return "";
  const injectedFor = normalizedBridgeUrl(import.meta.env.VITE_STUDIO_BRIDGE_URL || "");
  const target = normalizedBridgeUrl(bridgeUrl);
  return injectedFor && target && injectedFor === target ? token : "";
}

export function saveBridgeUrl(value: string): void {
  const cleaned = value.trim().replace(/\/$/, "");
  if (!cleaned) {
    localStorage.removeItem(BRIDGE_STORAGE_KEY);
    clearBridgeQuery();
    return;
  }
  const url = new URL(cleaned);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Bridge URL must start with https:// (or http:// for local development)");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Remote bridge URLs must use https://");
  }
  localStorage.setItem(BRIDGE_STORAGE_KEY, url.toString().replace(/\/$/, ""));
  clearBridgeQuery();
}

export function saveBridgeToken(value: string, bridgeUrl = configuredBridgeUrl()): void {
  const token = value.trim();
  const bridge = normalizedBridgeUrl(bridgeUrl);
  if (!bridge) throw new Error("Enter a valid bridge URL before saving its token");
  const tokens: Record<string, string> = {};
  const stored = sessionStorage.getItem(BRIDGE_TOKEN_STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { bridge?: unknown; token?: unknown; tokens?: Record<string, unknown> };
      if (parsed.tokens) {
        for (const [key, candidate] of Object.entries(parsed.tokens)) {
          if (typeof candidate === "string") tokens[key] = candidate;
        }
      } else if (typeof parsed.bridge === "string" && typeof parsed.token === "string") {
        tokens[parsed.bridge] = parsed.token;
      }
    } catch {
      // Replace damaged session-only credential state below.
    }
  }
  if (!token) {
    delete tokens[bridge];
    if (Object.keys(tokens).length) sessionStorage.setItem(BRIDGE_TOKEN_STORAGE_KEY, JSON.stringify({ tokens }));
    else sessionStorage.removeItem(BRIDGE_TOKEN_STORAGE_KEY);
    return;
  }
  const tokenLength = new TextEncoder().encode(token).byteLength;
  if (tokenLength < 32 || tokenLength > 4096) {
    throw new Error("Bridge tokens must contain 32 to 4096 bytes");
  }
  // Unproven bridge credentials stay session-only. After a native Studio
  // session starts successfully, App promotes the host token to Keychain.
  tokens[bridge] = token;
  sessionStorage.setItem(BRIDGE_TOKEN_STORAGE_KEY, JSON.stringify({ tokens }));
}

export async function listRuntimeHosts(): Promise<RuntimeHost[]> {
  const local: RuntimeHost = { id: "local", name: "This Mac", url: "", tokenRef: "local" };
  if (isMobileRuntime()) {
    // No local runtime on a phone: the only host is whatever bridge is configured.
    const url = bridgeBaseUrl();
    return url ? [{ id: "connected", name: "Connected host", url, tokenRef: "session" }] : [];
  }
  if (isDesktopRuntime()) {
    const remote = await invoke<RuntimeHost[]>("list_runtime_hosts");
    const configured = bridgeBaseUrl();
    if (configured) {
      const selected = remote.find((host) => normalizedBridgeUrl(host.url) === configured);
      if (selected) return [selected, local, ...remote.filter((host) => host.id !== selected.id)];
      return [
        { id: "configured", name: "Configured host", url: configured, tokenRef: "session" },
        local,
        ...remote,
      ];
    }
    return [local, ...remote];
  }
  const url = bridgeBaseUrl();
  return url
    ? [{ id: "connected", name: "Connected host", url, tokenRef: "session" }]
    : [local];
}

export async function saveRuntimeHost(host: RuntimeHost): Promise<RuntimeHost[]> {
  requireDesktop();
  return invoke<RuntimeHost[]>("save_runtime_host", { host });
}

export async function removeRuntimeHost(id: string): Promise<RuntimeHost[]> {
  requireDesktop();
  return invoke<RuntimeHost[]>("remove_runtime_host", { id });
}

export async function storeRuntimeHostToken(id: string, token: string): Promise<void> {
  requireDesktop();
  await invoke("store_runtime_host_token", { id, token });
}

export function durableRuntimeHostForSession(input: NewSessionInput, hosts: RuntimeHost[]): RuntimeHost | undefined {
  const url = input.hostUrl ? normalizedBridgeUrl(input.hostUrl) : undefined;
  if (!url || input.hostId === "local") return undefined;
  const existing = hosts.find((host) => host.tokenRef !== "local"
    && host.tokenRef !== "session"
    && normalizedBridgeUrl(host.url) === url);
  if (existing) {
    return { ...existing, url, defaultProjectRoot: input.projectDir || existing.defaultProjectRoot };
  }
  const parsed = new URL(url);
  const suppliedName = input.hostName?.trim();
  const genericName = !suppliedName || /^(configured|connected) host$/i.test(suppliedName);
  const id = runtimeHostId(url);
  return {
    id,
    name: genericName ? `Compute · ${parsed.host}` : suppliedName,
    url,
    tokenRef: `keychain:${id}`,
    defaultProjectRoot: input.projectDir || undefined,
  };
}

export function runtimeHostId(url: string): string {
  const parsed = new URL(url);
  const base = `${parsed.hostname}-${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "remote";
  let hash = 2166136261;
  for (const character of url) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const suffix = (hash >>> 0).toString(36);
  return `host-${base.slice(0, Math.max(1, 57 - suffix.length))}-${suffix}`.slice(0, 63);
}

export async function listHostDirectories(hostUrl: string, path?: string, hostId?: string): Promise<HostDirectoryListing> {
  const bridge = normalizedBridgeUrl(hostUrl);
  if (!bridge) throw new Error("The runtime host URL is invalid");
  await ensureBridgeToken(bridge, hostId);
  const url = hostApiUrl(bridge, "/directories");
  if (path?.trim()) url.searchParams.set("path", path.trim());
  return fetchJson<HostDirectoryListing>(url, undefined, bridge);
}

/** Creates one folder inside `parentPath`. The host validates containment. */
export async function createHostDirectory(
  hostUrl: string,
  parentPath: string,
  name: string,
  hostId?: string,
): Promise<{ path: string }> {
  const bridge = normalizedBridgeUrl(hostUrl);
  if (!bridge) throw new Error("The runtime host URL is invalid");
  await ensureBridgeToken(bridge, hostId);
  return fetchJson<{ path: string }>(hostApiUrl(bridge, "/directories"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: parentPath, name }),
  }, bridge);
}

export function transportLabel(): string {
  if (isMobileRuntime()) return usesWebBridge() ? "Mobile · remote Rust bridge" : "Mobile · no bridge configured";
  if (usesWebBridge()) return isTauriRuntime() ? "Native desktop · remote Rust bridge" : "Web · Rust bridge";
  return "Native desktop · local Rust bridge";
}

export function localRuntimeSettingsAvailable(): boolean {
  // Mobile has no local runtime: settings are only readable through a bridge.
  return isDesktopRuntime() || usesWebBridge();
}

export async function readRuntimeSettings(
  projectDir: string,
  hostUrl?: string,
  hostId?: string,
): Promise<RuntimeSettingsSnapshot> {
  const bridge = hostUrl
    ? normalizedBridgeUrl(hostUrl)
    : (!isDesktopRuntime() ? bridgeBaseUrl() : undefined);
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    const url = hostApiUrl(bridge, "/runtime-settings");
    url.searchParams.set("projectDir", projectDir);
    return fetchJson<RuntimeSettingsSnapshot>(url, undefined, bridge);
  }
  requireDesktop();
  return invoke<RuntimeSettingsSnapshot>("read_runtime_settings", { projectDir });
}

export async function applyRuntimeSettings(
  projectDir: string,
  changes: RuntimeSettingChange[],
  hostUrl?: string,
  hostId?: string,
): Promise<RuntimeSettingsSnapshot> {
  const bridge = hostUrl
    ? normalizedBridgeUrl(hostUrl)
    : (!isDesktopRuntime() ? bridgeBaseUrl() : undefined);
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    return fetchJson<RuntimeSettingsSnapshot>(hostApiUrl(bridge, "/runtime-settings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDir, changes }),
    }, bridge);
  }
  requireDesktop();
  return invoke<RuntimeSettingsSnapshot>("apply_runtime_settings", { projectDir, changes });
}

export async function listenNativeAttachmentDrops(
  handler: (event: NativeAttachmentDropEvent) => void,
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "enter") {
      handler({ type: "enter" });
      return;
    }
    if (event.payload.type === "leave") {
      handler({ type: "leave" });
      return;
    }
    if (event.payload.type !== "drop") return;
    void invoke<NativeAttachment[]>("load_attachment_paths", { paths: event.payload.paths })
      .then((attachments) => handler({ type: "drop", attachments }))
      .catch((error) => handler({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
  });
}

export async function openLocalOutput(projectDir: string, path: string): Promise<void> {
  const bridge = bridgeBaseUrl();
  if (bridge) {
    const url = hostApiUrl(bridge, "/output");
    url.searchParams.set("projectDir", projectDir);
    url.searchParams.set("path", path);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${requireBridgeToken()}` },
    });
    if (!response.ok) {
      const value = await response.json().catch(() => undefined) as { error?: string } | undefined;
      throw new Error(value?.error || `Host output request failed (${response.status})`);
    }
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = path.split(/[\\/]/).pop() || "amplifier-output";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    return;
  }
  requireDesktop();
  await invoke("open_output", { projectDir, path });
}

export async function loadOutputPreview(projectDir: string, path: string): Promise<OutputPreview> {
  if (usesWebBridge()) {
    const bridge = bridgeBaseUrl();
    if (!bridge) throw new Error("The Rust bridge is not configured");
    const url = hostApiUrl(bridge, "/output-preview");
    url.searchParams.set("projectDir", projectDir);
    url.searchParams.set("path", path);
    return fetchJson<OutputPreview>(url);
  }
  requireDesktop();
  return invoke<OutputPreview>("read_output_preview", { projectDir, path });
}

export async function launchSession(
  options: StartSessionOptions,
  handlers: SessionHandlers,
): Promise<SessionConnection> {
  const bridge = options.hostId === "local" ? undefined : bridgeBaseUrl(options.hostUrl);
  if (bridge) {
    if (!configuredBridgeToken(bridge) && isDesktopRuntime() && options.hostId) {
      const token = await invoke<string>("resolve_runtime_host_token", { id: options.hostId });
      saveBridgeToken(token, bridge);
    }
    return launchBridgeSession(bridge, options, handlers);
  }

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
    if (connection.stopCompleted) return true;
    if (connection.pendingStop) return connection.pendingStop.promise;
    connection.stopRequested = true;
    let resolveStop!: (stopped: boolean) => void;
    let rejectStop!: (error: Error) => void;
    const promise = new Promise<boolean>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const timer = window.setTimeout(() => {
      if (connection.pendingStop?.promise !== promise) return;
      connection.pendingStop = undefined;
      rejectStop(new Error("The Rust bridge did not confirm that the runtime stopped"));
    }, 20_000);
    connection.pendingStop = { promise, resolve: resolveStop, reject: rejectStop, timer };
    if (connection.socket.readyState === WebSocket.OPEN) {
      sendBridge(connection.socket, { type: "stop" });
    }
    return promise;
  }
  requireTauri();
  return invoke<boolean>("stop_session", { guiId });
}

export async function listStoredSessions(projectDir?: string, hostUrl?: string, hostId?: string): Promise<StoredSession[]> {
  const bridge = hostId === "local" ? undefined : hostUrl ? normalizedBridgeUrl(hostUrl) : bridgeBaseUrl();
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    const url = hostApiUrl(bridge, "/stored-sessions");
    const project = clean(projectDir);
    if (project) url.searchParams.set("projectDir", project);
    return fetchJson<StoredSession[]>(url);
  }
  requireTauri();
  return invoke<StoredSession[]>("list_stored_sessions", { projectDir: clean(projectDir) });
}

export async function listCatalog(projectDir?: string, hostUrl?: string, hostId?: string): Promise<CapabilityCatalog> {
  const bridge = hostUrl ? normalizedBridgeUrl(hostUrl) : bridgeBaseUrl();
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    const url = hostApiUrl(bridge, "/catalog");
    const project = clean(projectDir);
    if (project) url.searchParams.set("projectDir", project);
    return fetchJson<CapabilityCatalog>(url);
  }
  requireTauri();
  return invoke<CapabilityCatalog>("list_catalog", { projectDir: clean(projectDir) });
}

export async function addBundle(input: { projectDir?: string; uri: string; name?: string }): Promise<CapabilityCatalog> {
  const bridge = bridgeBaseUrl();
  if (bridge) {
    return fetchJson<CapabilityCatalog>(hostApiUrl(bridge, "/catalog/bundles"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectDir: clean(input.projectDir),
        uri: input.uri.trim(),
        name: clean(input.name),
      }),
    });
  }
  requireTauri();
  return invoke<CapabilityCatalog>("add_bundle", {
    projectDir: clean(input.projectDir),
    uri: input.uri.trim(),
    name: clean(input.name),
  });
}

export async function defaultProjectDir(): Promise<string> {
  const bridge = bridgeBaseUrl();
  if (bridge) {
    const config = await fetchJson<{ defaultProjectDir?: string }>(hostApiUrl(bridge, "/config"));
    return config.defaultProjectDir || "";
  }
  if (!isTauriRuntime()) return "";
  return invoke<string>("default_project_dir");
}

export async function getRuntimeStatus(hostUrl?: string, hostId?: string): Promise<RuntimeStatus> {
  const bridge = hostId === "local" ? undefined : hostUrl ? normalizedBridgeUrl(hostUrl) : bridgeBaseUrl();
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    return fetchJson<RuntimeStatus>(hostApiUrl(bridge, "/runtime"), undefined, bridge);
  }
  requireTauri();
  return invoke<RuntimeStatus>("runtime_status");
}

export async function probeRuntimeHost(hostUrl: string, hostId?: string): Promise<RuntimeHostProbe> {
  const bridge = normalizedBridgeUrl(hostUrl);
  if (!bridge) throw new Error("Enter a valid Amplifier Host URL");
  await ensureBridgeToken(bridge, hostId);
  const [status, config] = await Promise.all([
    fetchJson<RuntimeStatus>(hostApiUrl(bridge, "/runtime"), undefined, bridge),
    fetchJson<{ defaultProjectDir?: string }>(hostApiUrl(bridge, "/config"), undefined, bridge),
  ]);
  if (!status.installed) {
    throw new Error(status.message || "Amplifier Runtime is not installed on this compute host");
  }
  return { status, defaultProjectDir: config.defaultProjectDir?.trim() || "" };
}

export async function installRuntime(): Promise<RuntimeStatus> {
  if (bridgeBaseUrl()) {
    throw new Error("Install the runtime on the Rust bridge host; remote installation is intentionally disabled");
  }
  requireTauri();
  return invoke<RuntimeStatus>("install_runtime");
}

export async function configureProvider(input: {
  providerType: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): Promise<RuntimeStatus> {
  if (bridgeBaseUrl()) {
    throw new Error("Configure providers on the authenticated runtime host");
  }
  requireTauri();
  return invoke<RuntimeStatus>("configure_provider", {
    providerType: input.providerType.trim(),
    apiKey: input.apiKey.trim(),
    model: clean(input.model),
    baseUrl: clean(input.baseUrl),
  });
}

export async function getTranscriptionStatus(): Promise<TranscriptionStatus> {
  const bridge = bridgeBaseUrl();
  if (bridge) return fetchJson<TranscriptionStatus>(hostApiUrl(bridge, "/transcription"));
  requireTauri();
  return invoke<TranscriptionStatus>("transcription_status");
}

export async function transcribeAudio(recording: AudioRecording): Promise<string> {
  const bridge = bridgeBaseUrl();
  if (bridge) {
    const result = await fetchJson<{ text: string }>(hostApiUrl(bridge, "/transcription"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(recording),
    });
    return result.text;
  }
  requireTauri();
  return invoke<string>("transcribe_audio", { request: recording });
}

async function launchBridgeSession(
  bridge: string,
  options: StartSessionOptions,
  handlers: SessionHandlers,
): Promise<SessionConnection> {
  const url = hostApiUrl(bridge, `/session/${encodeURIComponent(options.guiId)}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = requireBridgeToken(bridge);
  const connection: BridgeConnection = {
    socket: undefined as unknown as WebSocket,
    disposed: false,
    stopRequested: false,
    stopCompleted: false,
    sawExit: false,
    reconnectAttempt: 0,
    lastCursor: 0,
    replaying: false,
    replayBuffer: [],
    seenEventIds: new Set(),
    replayCoveredIds: new Set(),
    dispose: () => {
      connection.disposed = true;
      if (connection.reconnectTimer !== undefined) window.clearTimeout(connection.reconnectTimer);
      if (connection.pendingStop) {
        window.clearTimeout(connection.pendingStop.timer);
        connection.pendingStop.reject(new Error("The session view detached before stop completed"));
        connection.pendingStop = undefined;
      }
      bridgeConnections.delete(options.guiId);
      connection.socket?.close(1000, "session view detached");
    },
  };
  bridgeConnections.set(options.guiId, connection);

  return new Promise<SessionConnection>((resolve, reject) => {
    let initiallyReady = false;
    let settled = false;

    const connect = (reattach: boolean) => {
      if (connection.disposed || connection.stopCompleted || connection.sawExit) return;
      connection.replaying = reattach;
      connection.replayBuffer = [];
      connection.replayCoveredIds.clear();
      const socket = new WebSocket(url, [WS_PROTOCOL, websocketBearerProtocol(token)]);
      connection.socket = socket;
      let acknowledged = false;
      const timer = window.setTimeout(() => {
        if (acknowledged) return;
        socket.close(4000, "bridge acknowledgement timeout");
        if (!initiallyReady && !settled) {
          settled = true;
          bridgeConnections.delete(options.guiId);
          reject(new Error("The Rust bridge did not acknowledge the session start"));
        }
      }, 15_000);

      socket.addEventListener("open", () => {
        sendBridge(socket, reattach
          ? { type: "attach", since: connection.lastCursor }
          : { type: "start", options: wireOptions(options) });
      });
      socket.addEventListener("message", (event) => {
        let envelope: BridgeEnvelope;
        try {
          envelope = JSON.parse(String(event.data)) as BridgeEnvelope;
        } catch {
          handlers.onLog({ stream: "bridge", message: "The Rust bridge sent invalid JSON" });
          return;
        }
        if (envelope.version !== HOST_PROTOCOL_VERSION) {
          handlers.onLog({
            stream: "host",
            message: `The host returned protocol version ${String(envelope.version)}; Studio requires version ${HOST_PROTOCOL_VERSION}`,
          });
          socket.close(4005, "unsupported host protocol version");
          return;
        }

        if (envelope.type === "ready") {
          acknowledged = true;
          initiallyReady = true;
          connection.reconnectAttempt = 0;
          window.clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(connection);
          } else if (reattach) {
            handlers.onLog({
              stream: "bridge",
              message: `Reattached to the runtime; replaying after cursor ${connection.lastCursor}`,
            });
          }
          if (connection.stopRequested) sendBridge(socket, { type: "stop" });
          return;
        }
        if (envelope.type === "stopped") {
          completeBridgeStop(connection, envelope.stopped !== false);
          return;
        }
        if (envelope.type === "error") {
          const error = new Error(envelope.message || "Rust bridge error");
          if (!initiallyReady && !settled) {
            settled = true;
            connection.disposed = true;
            bridgeConnections.delete(options.guiId);
            socket.close();
            reject(error);
          } else if (reattach && !acknowledged) {
            handlers.onLog({ stream: "bridge", message: error.message });
            socket.close(4004, "runtime reattach failed");
          } else {
            handlers.onLog({ stream: "bridge", message: error.message });
          }
          return;
        }
        if (envelope.type === "event") deliverBridgeEnvelope(connection, envelope, handlers);
      });
      socket.addEventListener("error", () => {
        if (!initiallyReady && !settled) {
          settled = true;
          connection.disposed = true;
          bridgeConnections.delete(options.guiId);
          reject(new Error(`Could not connect to the Rust bridge at ${bridge}`));
        }
      });
      socket.addEventListener("close", () => {
        window.clearTimeout(timer);
        if (connection.socket !== socket || connection.disposed || connection.stopCompleted || connection.sawExit) return;
        if (!initiallyReady) {
          if (!settled) {
            settled = true;
            connection.disposed = true;
            bridgeConnections.delete(options.guiId);
            reject(new Error(`The Rust bridge at ${bridge} closed during startup`));
          }
          return;
        }
        const delay = Math.min(8_000, 300 * (2 ** connection.reconnectAttempt));
        connection.reconnectAttempt = Math.min(connection.reconnectAttempt + 1, 6);
        handlers.onLog({ stream: "bridge", message: `Bridge connection lost; reconnecting in ${delay} ms` });
        connection.reconnectTimer = window.setTimeout(() => connect(true), delay);
      });
    };

    connect(false);
  });
}

function deliverBridgeEnvelope(
  connection: BridgeConnection,
  envelope: BridgeEnvelope,
  handlers: SessionHandlers,
): void {
  if (envelope.channel === "record" && isRecord(envelope.payload)) {
    const record = envelope.payload;
    if (record.type === "history.begin") {
      if (!connection.replaying) {
        connection.replaying = true;
        connection.replayBuffer = [];
        connection.replayCoveredIds.clear();
      }
      handlers.onRecord(record);
      return;
    }
    if (connection.replaying) {
      if (record.replay === true) {
        deliverRecordOnce(connection, record, handlers, true);
        return;
      }
      if (record.type === "history.end") {
        updateCursor(connection, record);
        handlers.onRecord(record);
        connection.replaying = false;
        const buffered = connection.replayBuffer;
        connection.replayBuffer = [];
        // Every id seen before/during the replay is now covered by the new
        // durable cursor. Buffered records beyond the replay snapshot become
        // the new post-cursor dedup set.
        connection.seenEventIds.clear();
        for (const pending of buffered) {
          if (pending.channel === "record" && isRecord(pending.payload)) {
            const eventId = durableRuntimeEventId(pending.payload);
            if (eventId && connection.replayCoveredIds.has(eventId)) continue;
          }
          deliverBridgeEnvelope(connection, pending, handlers);
        }
        connection.replayCoveredIds.clear();
        return;
      }
      connection.replayBuffer.push(envelope);
      return;
    }
    updateCursor(connection, record);
    deliverRecordOnce(connection, record, handlers, false);
  } else if (envelope.channel === "log" && isProcessLog(envelope.payload)) {
    handlers.onLog(envelope.payload);
  } else if (envelope.channel === "exit" && isProcessExit(envelope.payload)) {
    connection.sawExit = true;
    if (connection.stopRequested) completeBridgeStop(connection, true);
    handlers.onExit(envelope.payload);
  }
}

function completeBridgeStop(connection: BridgeConnection, stopped: boolean): void {
  connection.stopCompleted = stopped;
  connection.stopRequested = false;
  const pending = connection.pendingStop;
  if (!pending) return;
  window.clearTimeout(pending.timer);
  connection.pendingStop = undefined;
  pending.resolve(stopped);
}

function updateCursor(connection: BridgeConnection, record: ProtocolRecord): void {
  // JSONL `sequence` is a transient wire-order counter and includes Channel A
  // stream records that never enter ui-events.jsonl. Only history.end carries
  // the durable ledger cursor accepted by history.replay.since.
  if (
    record.type === "history.end"
    && typeof record.cursor === "number"
    && Number.isSafeInteger(record.cursor)
    && record.cursor >= 0
  ) {
    connection.lastCursor = record.cursor;
  }
}

function deliverRecordOnce(
  connection: BridgeConnection,
  record: ProtocolRecord,
  handlers: SessionHandlers,
  replay: boolean,
): void {
  const eventId = durableRuntimeEventId(record);
  if (eventId) {
    if (replay) connection.replayCoveredIds.add(eventId);
    if (connection.seenEventIds.has(eventId)) return;
    connection.seenEventIds.add(eventId);
  }
  handlers.onRecord(record);
}

function durableRuntimeEventId(record: ProtocolRecord): string | undefined {
  if (record.type !== "runtime.event" || !isRecord(record.event)) return undefined;
  if (typeof record.event.kind === "string" && NON_DURABLE_EVENT_KINDS.has(record.event.kind)) {
    return undefined;
  }
  return typeof record.event.event_id === "string" && record.event.event_id
    ? record.event.event_id
    : undefined;
}

function bridgeBaseUrl(explicit?: string): string | undefined {
  const queryValue = new URLSearchParams(window.location.search).get("bridge");
  // A link may select a bridge for this page load, but it never writes a
  // persistent trust decision. Persistence happens only through Settings.
  const configured = explicit?.trim()
    || queryValue
    || localStorage.getItem(BRIDGE_STORAGE_KEY)
    || import.meta.env.VITE_STUDIO_BRIDGE_URL
    || (isTauriRuntime() ? undefined : window.location.origin);
  return configured ? normalizedBridgeUrl(configured) : undefined;
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
  socket.send(JSON.stringify({ ...value, version: HOST_PROTOCOL_VERSION }));
}

function hostApiUrl(bridge: string, path: string): URL {
  return new URL(`${HOST_API_PREFIX}${path}`, bridge);
}

async function fetchJson<T>(url: URL, init?: RequestInit, bridgeUrl?: string): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${requireBridgeToken(bridgeUrl || url.origin)}`);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (caught) {
    const reason = caught instanceof Error && caught.message && caught.message !== "Load failed"
      ? ` (${caught.message})`
      : "";
    throw new Error(
      `Could not reach Amplifier Host at ${url.origin}${reason}. Check the SSH/Tailscale connection and make sure the host allows the native Studio origin.`,
    );
  }
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

function requireBridgeToken(bridgeUrl = configuredBridgeUrl()): string {
  const token = configuredBridgeToken(bridgeUrl).trim();
  if (!token) throw new Error("Enter the Rust bridge bearer token in Bridge settings");
  return token;
}

async function ensureBridgeToken(bridgeUrl: string, hostId?: string): Promise<void> {
  if (configuredBridgeToken(bridgeUrl)) return;
  if (!isDesktopRuntime() || !hostId) return;
  const token = await invoke<string>("resolve_runtime_host_token", { id: hostId });
  saveBridgeToken(token, bridgeUrl);
}

function websocketBearerProtocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${WS_BEARER_PREFIX}${encoded}`;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizedBridgeUrl(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return undefined;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function clearBridgeQuery(): void {
  const current = new URL(window.location.href);
  if (!current.searchParams.has("bridge")) return;
  current.searchParams.delete("bridge");
  window.history.replaceState(window.history.state, "", current);
}

function requireTauri(): void {
  if (!isTauriRuntime()) {
    throw new Error("No local Rust bridge is available. Run `npm run web:serve` or launch the Tauri app.");
  }
}

function requireDesktop(): void {
  if (isMobileRuntime()) {
    throw new Error("This action runs on the host machine. Connect a bridge in Settings to use it from mobile.");
  }
  requireTauri();
}

export type { UnlistenFn };
