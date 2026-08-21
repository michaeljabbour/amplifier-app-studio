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
  onConnectionChange?: (state: { status: "connected" | "reconnecting"; message?: string }) => void;
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
  capabilities: string[];
}

export interface RuntimeHostConfig {
  defaultProjectDir: string;
  capabilities: string[];
}

export interface HostDirectoryListing {
  version: number;
  path: string;
  parent?: string;
  roots: string[];
  directories: Array<{ name: string; path: string }>;
}

export interface CloneRepositoryResult {
  path: string;
  repository: string;
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

export interface PortableSession {
  schema: string;
  session_id: string;
  metadata: Record<string, unknown>;
  transcript: Record<string, unknown>[];
  sanitized?: boolean;
  [key: string]: unknown;
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
  replayWatchdog?: number;
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
const MOBILE_HOST_STORAGE_KEY = "amplifier-studio.mobile-host";
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
  // session starts successfully, App promotes the host token to the operating
  // system's secure credential store.
  tokens[bridge] = token;
  sessionStorage.setItem(BRIDGE_TOKEN_STORAGE_KEY, JSON.stringify({ tokens }));
}

export async function listRuntimeHosts(): Promise<RuntimeHost[]> {
  const local: RuntimeHost = { id: "local", name: "This computer", url: "", tokenRef: "local" };
  if (isMobileRuntime()) {
    const host = mobileRuntimeHost();
    return host ? [host] : [];
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
  if (isMobileRuntime()) {
    saveBridgeUrl(host.url);
    const url = bridgeBaseUrl();
    if (!url) throw new Error("The compute host URL is invalid");
    const mobileHost = { ...host, url, tokenRef: "session" };
    localStorage.setItem(MOBILE_HOST_STORAGE_KEY, JSON.stringify(mobileHost));
    return [mobileHost];
  }
  requireDesktop();
  return invoke<RuntimeHost[]>("save_runtime_host", { host });
}

export async function removeRuntimeHost(id: string): Promise<RuntimeHost[]> {
  if (isMobileRuntime()) {
    const host = mobileRuntimeHost();
    if (!host || host.id !== id) return host ? [host] : [];
    saveBridgeToken("", host.url);
    localStorage.removeItem(MOBILE_HOST_STORAGE_KEY);
    saveBridgeUrl("");
    return [];
  }
  requireDesktop();
  return invoke<RuntimeHost[]>("remove_runtime_host", { id });
}

export async function storeRuntimeHostToken(id: string, token: string): Promise<void> {
  if (isMobileRuntime()) {
    const host = mobileRuntimeHost();
    if (!host || host.id !== id) throw new Error(`Unknown Amplifier host '${id}'`);
    saveBridgeToken(token, host.url);
    return;
  }
  requireDesktop();
  await invoke("store_runtime_host_token", { id, token });
}

function mobileRuntimeHost(): RuntimeHost | undefined {
  const configured = bridgeBaseUrl();
  if (!configured) return undefined;
  const stored = localStorage.getItem(MOBILE_HOST_STORAGE_KEY);
  if (stored) {
    try {
      const host = JSON.parse(stored) as Partial<RuntimeHost>;
      const url = typeof host.url === "string" ? normalizedBridgeUrl(host.url) : undefined;
      if (url === configured
        && typeof host.id === "string" && host.id
        && typeof host.name === "string" && host.name) {
        return {
          id: host.id,
          name: host.name,
          url: configured,
          tokenRef: "session",
          defaultProjectRoot: typeof host.defaultProjectRoot === "string"
            ? host.defaultProjectRoot
            : undefined,
        };
      }
    } catch {
      // Fall back to a host derived from the explicitly configured bridge.
    }
  }
  return {
    id: runtimeHostId(configured),
    name: `Compute · ${new URL(configured).hostname}`,
    url: configured,
    tokenRef: "session",
  };
}

export function durableRuntimeHostForSession(
  input: NewSessionInput,
  hosts: RuntimeHost[],
  configuredProjectRoot = input.projectDir,
): RuntimeHost | undefined {
  const url = input.hostUrl ? normalizedBridgeUrl(input.hostUrl) : undefined;
  if (!url || input.hostId === "local") return undefined;
  const durable = (host: RuntimeHost) => host.tokenRef !== "local" && host.tokenRef !== "session";
  const parsed = new URL(url);
  const suppliedName = input.hostName?.trim();
  const genericName = !suppliedName || /^(configured|connected) host$/i.test(suppliedName);

  const existing = hosts.find((host) => durable(host) && normalizedBridgeUrl(host.url) === url)
    // Re-point rather than duplicate. A host's id is derived from its URL, and these URLs are
    // loopback ports handed out by an SSH or Tailscale forward -- inherently ephemeral. When a
    // forward came back on a different port the URL stopped matching, a brand new host record
    // and keychain entry were minted, and every stored session pinned to the old id was
    // orphaned with no way to reach it. A user-assigned name ("Spark 288f") is the stable
    // identity here, so reuse that record and move it to the new URL. Generic auto-names are
    // excluded: collapsing two "Configured host" entries would merge unrelated computes.
    || (genericName
      ? undefined
      : hosts.find((host) => durable(host) && host.name.trim().toLowerCase() === suppliedName!.toLowerCase()));
  if (existing) {
    return { ...existing, url, defaultProjectRoot: configuredProjectRoot || existing.defaultProjectRoot };
  }
  const id = runtimeHostId(url);
  return {
    id,
    name: genericName ? `Compute · ${parsed.host}` : suppliedName,
    url,
    tokenRef: `keychain:${id}`,
    defaultProjectRoot: configuredProjectRoot || undefined,
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

/** Clone one credential-free GitHub URL into the selected compute's dev
 * workspace. The Rust host owns URL, destination, and process validation. */
export async function cloneGithubRepository(
  repositoryUrl: string,
  hostUrl?: string,
  hostId?: string,
): Promise<CloneRepositoryResult> {
  const bridge = hostId === "local"
    ? undefined
    : hostUrl
      ? normalizedBridgeUrl(hostUrl)
      : (!isDesktopRuntime() ? bridgeBaseUrl() : undefined);
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    try {
      return await fetchJson<CloneRepositoryResult>(hostApiUrl(bridge, "/repositories/clone"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryUrl: repositoryUrl.trim() }),
      }, bridge);
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "").trim();
      if (/\b404\b/.test(message) || /^not found$/i.test(message)) {
        throw new Error("Update Amplifier Host on this compute before cloning repositories from Studio.");
      }
      throw error;
    }
  }
  requireDesktop();
  return invoke<CloneRepositoryResult>("clone_github_repository", {
    repositoryUrl: repositoryUrl.trim(),
  });
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

export async function openLocalOutput(
  projectDir: string,
  path: string,
  hostUrl?: string,
  hostId?: string,
): Promise<void> {
  const bridge = sessionBridge({ hostUrl, hostId });
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    const url = hostApiUrl(bridge, "/output");
    url.searchParams.set("projectDir", projectDir);
    url.searchParams.set("path", path);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${requireBridgeToken(bridge)}` },
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

export async function loadOutputPreview(
  projectDir: string,
  path: string,
  hostUrl?: string,
  hostId?: string,
): Promise<OutputPreview> {
  const bridge = sessionBridge({ hostUrl, hostId });
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    const url = hostApiUrl(bridge, "/output-preview");
    url.searchParams.set("projectDir", projectDir);
    url.searchParams.set("path", path);
    return fetchJson<OutputPreview>(url, undefined, bridge);
  }
  requireDesktop();
  return invoke<OutputPreview>("read_output_preview", { projectDir, path });
}

export async function launchSession(
  options: StartSessionOptions,
  handlers: SessionHandlers,
): Promise<SessionConnection> {
  const bridge = sessionBridge(options);
  if (bridge) {
    // Preserve the synchronous socket construction used by callers/tests once
    // this bridge is already trusted; only credential resolution needs an
    // async preflight.
    if (!configuredBridgeToken(bridge)) await prepareSessionLaunch(options);
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

/** Resolve remote credentials before App creates a tab. A failed preflight
 * should leave the new/resume dialog actionable instead of manufacturing a
 * stopped tab that is counted as a parallel runtime. */
export async function prepareSessionLaunch(options: NewSessionInput): Promise<void> {
  const bridge = sessionBridge(options);
  if (!bridge) return;
  await ensureBridgeToken(bridge, options.hostId);
  requireBridgeToken(bridge);
}

function sessionBridge(options: Pick<NewSessionInput, "hostId" | "hostUrl">): string | undefined {
  return options.hostId === "local" ? undefined : bridgeBaseUrl(options.hostUrl);
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

export async function exportStoredSession(
  projectDir: string,
  sessionId: string,
  hostUrl?: string,
  hostId?: string,
): Promise<PortableSession> {
  const bridge = hostId === "local" ? undefined : hostUrl ? normalizedBridgeUrl(hostUrl) : bridgeBaseUrl();
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    const url = hostApiUrl(bridge, "/stored-session-export");
    url.searchParams.set("projectDir", projectDir.trim());
    url.searchParams.set("sessionId", sessionId);
    return fetchJson<PortableSession>(url);
  }
  requireTauri();
  return invoke<PortableSession>("export_stored_session", { projectDir, sessionId });
}

export async function importStoredSession(
  projectDir: string,
  payload: PortableSession,
  newId: string,
  name: string | undefined,
  hostUrl?: string,
  hostId?: string,
): Promise<string> {
  const bridge = hostId === "local" ? undefined : hostUrl ? normalizedBridgeUrl(hostUrl) : bridgeBaseUrl();
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    const result = await fetchJson<{ sessionId: string }>(hostApiUrl(bridge, "/stored-session-import"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDir, payload, newId, name: clean(name) }),
    });
    return result.sessionId;
  }
  requireTauri();
  return invoke<string>("import_stored_session", { projectDir, payload, newId, name: clean(name) });
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

export async function defaultProjectDir(hostUrl?: string, hostId?: string): Promise<string> {
  return (await runtimeHostConfig(hostUrl, hostId)).defaultProjectDir;
}

export async function runtimeHostConfig(hostUrl?: string, hostId?: string): Promise<RuntimeHostConfig> {
  const bridge = hostId === "local"
    ? undefined
    : hostUrl
      ? normalizedBridgeUrl(hostUrl)
      : bridgeBaseUrl();
  if (bridge) {
    await ensureBridgeToken(bridge, hostId);
    const config = await fetchJson<{ defaultProjectDir?: string; capabilities?: unknown }>(hostApiUrl(bridge, "/config"), undefined, bridge);
    return {
      defaultProjectDir: config.defaultProjectDir || "",
      capabilities: Array.isArray(config.capabilities)
        ? config.capabilities.filter((item): item is string => typeof item === "string")
        : [],
    };
  }
  if (!isTauriRuntime()) return { defaultProjectDir: "", capabilities: [] };
  return {
    defaultProjectDir: await invoke<string>("default_project_dir"),
    capabilities: isDesktopRuntime() ? ["githubRepositoryClone"] : [],
  };
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
    fetchJson<{ defaultProjectDir?: string; capabilities?: unknown }>(hostApiUrl(bridge, "/config"), undefined, bridge),
  ]);
  if (!status.installed) {
    throw new Error(status.message || "Amplifier Runtime is not installed on this compute host");
  }
  return {
    status,
    defaultProjectDir: config.defaultProjectDir?.trim() || "",
    capabilities: Array.isArray(config.capabilities)
      ? config.capabilities.filter((item): item is string => typeof item === "string")
      : [],
  };
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
      clearReplayWatchdog(connection);
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
          handlers.onConnectionChange?.({
            status: "connected",
            message: reattach ? "Reattached to the runtime" : "Connected to the runtime host",
          });
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
          // The reattach is acknowledged but its replay has not finished. Until history.end
          // arrives every record goes to replayBuffer, so a replay that never completes buries
          // the session behind a UI that still reads "connected".
          if (reattach) armReplayWatchdog(connection, handlers);
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
            // The host refused the reattach: the runtime this view was bound to is gone. This
            // used to just close the socket, which fell through to the reconnect backoff and
            // retried a runtime that can never come back -- "Reconnecting to compute" forever,
            // composer disabled, and the loop survived detaching the tab.
            handlers.onLog({ stream: "bridge", message: error.message });
            endBridgeConnection(connection, options.guiId, handlers, socket, error.message);
          } else {
            handlers.onLog({ stream: "bridge", message: error.message });
            // A post-ready error during replay means history.end is never coming. Deliver what
            // was buffered rather than holding it until the socket happens to drop.
            if (connection.replaying) {
              flushReplayBuffer(connection, handlers, "History replay failed; showing live updates from here.");
            }
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
        const message = `Bridge connection lost; reconnecting in ${delay} ms`;
        handlers.onConnectionChange?.({ status: "reconnecting", message });
        handlers.onLog({ stream: "bridge", message });
        connection.reconnectTimer = window.setTimeout(() => connect(true), delay);
      });
    };

    connect(false);
  });
}

/** How long a reattach may sit in replay before Studio gives up waiting for history.end. */
const REPLAY_WATCHDOG_MS = 12_000;

function clearReplayWatchdog(connection: BridgeConnection): void {
  if (connection.replayWatchdog === undefined) return;
  window.clearTimeout(connection.replayWatchdog);
  connection.replayWatchdog = undefined;
}

function armReplayWatchdog(connection: BridgeConnection, handlers: SessionHandlers): void {
  clearReplayWatchdog(connection);
  if (!connection.replaying) return;
  connection.replayWatchdog = window.setTimeout(() => {
    connection.replayWatchdog = undefined;
    if (!connection.replaying) return;
    flushReplayBuffer(
      connection,
      handlers,
      "The runtime did not finish replaying history; showing live updates from here.",
    );
  }, REPLAY_WATCHDOG_MS);
}

/** Leaves replay mode and delivers whatever was buffered, in order. */
function flushReplayBuffer(connection: BridgeConnection, handlers: SessionHandlers, message: string): void {
  clearReplayWatchdog(connection);
  connection.replaying = false;
  const buffered = connection.replayBuffer;
  connection.replayBuffer = [];
  connection.replayCoveredIds.clear();
  handlers.onLog({ stream: "bridge", message });
  for (const pending of buffered) deliverBridgeEnvelope(connection, pending, handlers);
}

/**
 * Puts a bridge connection into a terminal state and reports the runtime as exited.
 *
 * Reconnecting is only correct while the runtime still exists. When the host tells us it does
 * not, the view needs an ending: without one the reconnect backoff runs forever and the session
 * can never be relaunched or cleared.
 */
function endBridgeConnection(
  connection: BridgeConnection,
  guiId: string,
  handlers: SessionHandlers,
  socket: WebSocket | undefined,
  message: string,
): void {
  if (connection.sawExit) return;
  // `sawExit` and `disposed` both suppress the close handler's reconnect scheduling.
  connection.sawExit = true;
  connection.disposed = true;
  if (connection.reconnectTimer !== undefined) window.clearTimeout(connection.reconnectTimer);
  clearReplayWatchdog(connection);
  bridgeConnections.delete(guiId);
  socket?.close(4004, "runtime reattach failed");
  handlers.onExit({ message });
}

/**
 * Forgets transport-level dedupe for a session so a full re-replay can be delivered.
 *
 * "Retry restore" clears the transcript and re-asks for the whole ledger with
 * `history.replay { since: 0 }`. `seenEventIds` still held every id from the first delivery, so
 * deliverRecordOnce dropped all of them and the retry produced a permanently blank transcript
 * with no error shown. The reducer keeps its own `replayedTranscriptMessageIds`, so a full
 * rebuild stays idempotent downstream.
 */
export function resetReplayDedupe(guiId: string): void {
  const connection = bridgeConnections.get(guiId);
  if (!connection) return;
  connection.seenEventIds.clear();
  connection.replayCoveredIds.clear();
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
        clearReplayWatchdog(connection);
        connection.replaying = false;
        const buffered = connection.replayBuffer;
        connection.replayBuffer = [];
        // Every id seen before/during the replay is now covered by the new
        // durable cursor. Buffered records beyond the replay snapshot become
        // the new post-cursor dedup set.
        // A UI-event replay advances a durable cursor, so ids at/before that
        // cursor can be forgotten. Legacy transcript replay deliberately keeps
        // cursor 0; forgetting its synthetic message ids would append the full
        // conversation again on the next reconnect.
        if (record.source !== "transcript") connection.seenEventIds.clear();
        for (const pending of buffered) {
          if (pending.channel === "record" && isRecord(pending.payload)) {
            const eventId = durableReplayRecordId(pending.payload);
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
  const eventId = durableReplayRecordId(record);
  if (eventId) {
    if (replay) connection.replayCoveredIds.add(eventId);
    if (connection.seenEventIds.has(eventId)) return;
    connection.seenEventIds.add(eventId);
  }
  handlers.onRecord(record);
}

function durableReplayRecordId(record: ProtocolRecord): string | undefined {
  if (record.type === "transcript.message") {
    return typeof record.message_id === "string" && record.message_id
      ? record.message_id
      : undefined;
  }
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
    throw new Error(hostRequestFailureMessage(url.origin, caught), { cause: caught });
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

/**
 * Describes a request that never produced a response.
 *
 * A rejected `fetch` tells us only that: a dead tunnel, a CORS rejection, and a blocked scheme
 * are indistinguishable from here. The previous wording asserted one of them -- "Check the
 * SSH/Tailscale connection" -- and that sent a real investigation down the wrong path while the
 * host was listening, CORS-correct, and answering curl the entire time. State what is actually
 * known, keep the underlying error for diagnosis, and list the candidates without picking one.
 */
export function hostRequestFailureMessage(origin: string, caught: unknown): string {
  const detail = caught instanceof Error && caught.message && caught.message !== "Load failed"
    ? ` (${caught.name}: ${caught.message})`
    : "";
  return `No response from ${origin}${detail}. The host never answered, so this is not an error it reported:`
    + " check that the SSH or Tailscale forward is still listening, that the host allows Studio's origin,"
    + " and that the saved URL still points at the right port.";
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
