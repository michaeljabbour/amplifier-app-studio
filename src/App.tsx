import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { AttentionBar, type AttentionResponse } from "./components/AttentionBar";
import { CapabilityPalette } from "./components/CapabilityPalette";
import { Composer } from "./components/Composer";
import { CoordinatorHome } from "./components/CoordinatorHome";
import { Footer } from "./components/Footer";
import { Inspector, type InspectorTab } from "./components/Inspector";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { ProviderSetupDialog } from "./components/ProviderSetupDialog";
import { SessionToolbar } from "./components/SessionToolbar";
import { SessionDrawer } from "./components/SessionDrawer";
import { SessionLifecycleDialog } from "./components/SessionLifecycleDialog";
import { StudioSettingsDialog } from "./components/StudioSettingsDialog";
import { StoredSessionDialog } from "./components/StoredSessionDialog";
import { TabStrip } from "./components/TabStrip";
import { TerminalWorkSurface } from "./components/TerminalWorkSurface";
import { Transcript } from "./components/Transcript";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { capabilitySessionInput, type StudioCapability } from "./capabilities";
import { activeSessionAutopilotOp, canEngageAutopilot } from "./autopilot";
import {
  appendAttachmentFiles,
  appendComposerAttachments,
  hasAttachmentFiles,
  imageAttachments,
  promptWithDocumentAttachments,
} from "./attachments";
import { nativeProjectPickerAvailable, pickAttachments, pickProjectDirectory, saveDiagnosticsFile } from "./nativePickers";
import { remoteProjectDefault, shouldRememberProjectLocally } from "./projectFolders";
import type { CapabilityCatalog, ComposerAttachment, NewSessionInput, ProtocolRecord, ProviderOption, SessionViewState, StoredSession } from "./protocol";
import {
  addLocalNotice,
  addProcessLog,
  createSessionState,
  dismissAlert,
  markAutopilotPending,
  markAutopilotSendFailed,
  markEffortPending,
  markExited,
  markPromptSendFailed,
  markPromptSubmitted,
  markSteerSubmitted,
  markSteerSendFailed,
  markRestoreDegraded,
  openRestoreAnyway,
  reduceRecord,
  resolveAttention,
  retryRestore,
  setComposerDraft,
  setComposerAttachments,
  setThinkingExpanded,
} from "./reducer";
import {
  createGuiId,
  addBundle,
  cloneGithubRepository,
  configureProvider,
  configuredBridgeToken,
  defaultProjectDir,
  durableRuntimeHostForSession,
  getRuntimeStatus,
  getTranscriptionStatus,
  openLocalOutput,
  probeRuntimeHost,
  prepareSessionLaunch,
  runtimeHostConfig,
  installRuntime,
  importStoredSession,
  listenNativeAttachmentDrops,
  localRuntimeSettingsAvailable,
  launchSession,
  listCatalog,
  listRuntimeHosts,
  listStoredSessions,
  exportStoredSession,
  removeRuntimeHost,
  sendOp,
  saveBridgeToken,
  saveRuntimeHost,
  stopSession,
  storeRuntimeHostToken,
  transportLabel,
  transcribeAudio,
  usesWebBridge,
  isDesktopRuntime,
  isTauriRuntime,
  isMobileRuntime,
  type RuntimeStatus,
  type RuntimeHost,
  type TranscriptionStatus,
  type NativeAttachmentDropEvent,
  type SessionConnection,
} from "./transport";
import { appUpdatesEnabled, checkForAppUpdate, installAppUpdate, type AppUpdateState } from "./updater";
import { clearUpdateRestorePlan, hydrateLegacyUpdateRestoreEntry, saveUpdateRestorePlan, takeUpdateRestorePlan } from "./updateContinuity";
import { toolContractFailure } from "./providerSafety";
import { applyStudioTheme, loadStudioTheme, saveStudioTheme, type StudioTheme } from "./theme";
import { openGuiIdForStoredSession, parallelSessionSummary } from "./sessionSelection";
import { storedSessionLegacyBundleOverride, storedSessionResumeBlocker } from "./sessionAvailability";
import { projectContextForHost } from "./settingsProjectContext";
import { projectDisplayName } from "./projectDisplayName";
import { createLatestAsyncRunner } from "./latestAsync";
import { loadStoredSessionsAcrossHosts, storedHistoryFailureMessage, type FederatedStoredSessions } from "./storedSessions";
import { attemptRuntimeStop, ordinaryTabCloseIntent, sessionHasLiveRuntime } from "./sessionLifecycle";
import { NativeTmuxAdapter, TerminalCoordinator, type TerminalProjectIdentity } from "./terminal";

const RESTORE_TIMEOUT_MS = 15_000;
const SESSION_HOME_HOST_KEY = "amplifier-studio.session-home-host";

interface StoredSessionRecovery {
  session: StoredSession;
  resumeDisabledReason?: string;
}

interface StopRuntimeRequest {
  guiId: string;
  stopping: boolean;
  error?: string;
}

export default function App() {
  const [sessions, setSessions] = createSignal<SessionViewState[]>([]);
  const [activeId, setActiveId] = createSignal<string>();
  const [dialog, setDialog] = createSignal<NewSessionInput>();
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [stored, setStored] = createSignal<StoredSession[]>([]);
  const [storedLoading, setStoredLoading] = createSignal(false);
  const [storedError, setStoredError] = createSignal<string>();
  const [storedWarning, setStoredWarning] = createSignal<string>();
  const [storedSessionDialog, setStoredSessionDialog] = createSignal<StoredSessionRecovery>();
  const [stopRuntimeRequest, setStopRuntimeRequest] = createSignal<StopRuntimeRequest>();
  const [defaultDir, setDefaultDir] = createSignal("");
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [studioTheme, setStudioTheme] = createSignal<StudioTheme>(loadStudioTheme());
  const [providerSetupOpen, setProviderSetupOpen] = createSignal(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = createSignal(false);
  const [transport, setTransport] = createSignal(transportLabel());
  const [catalog, setCatalog] = createSignal<CapabilityCatalog>({ bundles: [], providers: [] });
  const [catalogError, setCatalogError] = createSignal<string>();
  const [selectedLaneId, setSelectedLaneId] = createSignal<string>();
  const [inspectorTab, setInspectorTab] = createSignal<InspectorTab>("run");
  const [leftOpen, setLeftOpen] = createSignal(window.matchMedia("(min-width: 761px)").matches);
  const [rightOpen, setRightOpen] = createSignal(false);
  const [workbenchSurface, setWorkbenchSurface] = createSignal<"agent" | "terminal">("agent");
  const [workspaceAttachmentDrag, setWorkspaceAttachmentDrag] = createSignal(false);
  const [homeAttachments, setHomeAttachments] = createSignal<ComposerAttachment[]>([]);
  const [appUpdate, setAppUpdate] = createSignal<AppUpdateState>({ status: "disabled" });
  const [runtime, setRuntime] = createSignal<RuntimeStatus>();
  // "local" means run on this machine, which mobile cannot do. Selecting it on a
  // phone routes runtime_status to a local invoke that reports nothing installed,
  // so the app claims "Runtime setup required" even with a healthy bridge.
  const defaultHostId = isMobileRuntime() ? "connected" : "local";
  const [runtimeHosts, setRuntimeHosts] = createSignal<RuntimeHost[]>(
    isMobileRuntime() ? [] : [{ id: "local", name: "This computer", url: "", tokenRef: "local" }],
  );
  const [hostProjectRoots, setHostProjectRoots] = createSignal<Record<string, string>>({});
  const [hostCapabilities, setHostCapabilities] = createSignal<Record<string, string[]>>({
    local: isDesktopRuntime() ? ["githubRepositoryClone"] : [],
  });
  const [sessionHomeHostId, setSessionHomeHostId] = createSignal(localStorage.getItem(SESSION_HOME_HOST_KEY) || defaultHostId);
  const [runtimeChecking, setRuntimeChecking] = createSignal(true);
  const [runtimeInstalling, setRuntimeInstalling] = createSignal(false);
  const [runtimeError, setRuntimeError] = createSignal<string>();
  const [transcription, setTranscription] = createSignal<TranscriptionStatus>();
  const connections = new Map<string, SessionConnection>();
  const detachedSessions = new Map<string, SessionViewState>();
  const [detachedSessionsVersion, setDetachedSessionsVersion] = createSignal(0);
  const initialized = new Set<string>();
  const statusPollers = new Map<string, number>();
  const restoreTimers = new Map<string, number>();
  const pendingInitialPrompts = new Map<string, { runtimeText: string; attachments: ComposerAttachment[] }>();
  const runLatestRuntimeRefresh = createLatestAsyncRunner<RuntimeStatus>();
  const runLatestStoredRefresh = createLatestAsyncRunner<FederatedStoredSessions>();
  const terminalCoordinator = isDesktopRuntime()
    ? new TerminalCoordinator(new NativeTmuxAdapter({
      host: { id: "local", label: "This computer", kind: "local", transport: "native" },
    }))
    : undefined;

  const active = createMemo(() => sessions().find((session) => session.guiId === activeId()));
  const detachedSessionList = createMemo(() => {
    detachedSessionsVersion();
    return [...detachedSessions.values()];
  });
  const openSessionViews = createMemo(() => [...sessions(), ...detachedSessionList()]);
  const lanes = createMemo(() => Object.values(active()?.lanes || {}));
  const selectedLane = createMemo(() => active()?.lanes[selectedLaneId() || ""]);
  const updateBlocked = createMemo(() => openSessionViews().some((session) => session.busy || session.phase === "starting" || session.phase === "degraded" || session.phase === "closing"));
  const updateInProgress = createMemo(() => appUpdate().status === "downloading" || appUpdate().status === "installing");
  const autopilotActive = createMemo(() => active()?.autopilot === true || active()?.goal?.state === "continuing");
  const sessionHomeHost = createMemo(() => runtimeHosts().find((host) => host.id === sessionHomeHostId())
    || runtimeHosts().find((host) => host.id === "local")
    || runtimeHosts()[0]);

  const knownHostProjectRoot = (host?: RuntimeHost) => host?.url
    ? remoteProjectDefault(host, hostProjectRoots()[host.id] || "")
    : localStorage.getItem("amplifier-studio.project-dir")?.trim() || defaultDir();

  const settingsProjectDir = createMemo(() => {
    const host = sessionHomeHost();
    return projectContextForHost(active(), host, knownHostProjectRoot(host));
  });
  const nativeTerminalProject = createMemo<TerminalProjectIdentity | undefined>(() => {
    const session = active();
    const root = session && (!session.hostUrl || session.hostId === "local")
      ? session.projectDir.trim()
      : knownHostProjectRoot(runtimeHosts().find((host) => host.id === "local")).trim();
    if (!root) return undefined;
    return { id: root, label: projectDisplayName(root), root };
  });
  const mobileOverlayOpen = createMemo(() => Boolean(
    stopRuntimeRequest()
    || storedSessionDialog()
    || providerSetupOpen()
    || capabilitiesOpen()
    || settingsOpen()
    || dialog()
    || rightOpen()
    || drawerOpen(),
  ));

  const dismissTopMobileOverlay = () => {
    if (stopRuntimeRequest()) setStopRuntimeRequest(undefined);
    else if (storedSessionDialog()) setStoredSessionDialog(undefined);
    else if (providerSetupOpen()) setProviderSetupOpen(false);
    else if (capabilitiesOpen()) setCapabilitiesOpen(false);
    else if (settingsOpen()) setSettingsOpen(false);
    else if (dialog()) setDialog(undefined);
    else if (rightOpen()) setRightOpen(false);
    else if (drawerOpen()) setDrawerOpen(false);
  };

  createEffect(() => {
    if (!isTauriRuntime() || !/Android/i.test(navigator.userAgent) || !mobileOverlayOpen()) return;
    let disposed = false;
    let listener: Awaited<ReturnType<typeof onBackButtonPress>> | undefined;
    void onBackButtonPress(() => dismissTopMobileOverlay()).then((registered) => {
      if (disposed) void registered.unregister();
      else listener = registered;
    }).catch((error) => setRuntimeError(cleanError(error)));
    onCleanup(() => {
      disposed = true;
      if (listener) void listener.unregister();
    });
  });

  const refreshHostProjectRoot = async (host: RuntimeHost): Promise<string> => {
    if (!host.url) return knownHostProjectRoot(host);
    const config = await runtimeHostConfig(host.url, host.id);
    const configured = config.defaultProjectDir.trim();
    setHostCapabilities((current) => ({ ...current, [host.id]: config.capabilities }));
    const projectRoot = remoteProjectDefault(host, configured);
    if (projectRoot) setHostProjectRoots((current) => ({ ...current, [host.id]: projectRoot }));
    return projectRoot;
  };

  const setSessionHomeHost = (id: string) => {
    const selected = runtimeHosts().some((host) => host.id === id)
      ? id
      : runtimeHosts()[0]?.id || (isMobileRuntime() ? "" : "local");
    setSessionHomeHostId(selected);
    if (selected) localStorage.setItem(SESSION_HOME_HOST_KEY, selected);
    else localStorage.removeItem(SESSION_HOME_HOST_KEY);
  };

  createEffect(() => {
    const laneId = selectedLaneId();
    if (laneId && !active()?.lanes[laneId]) {
      setSelectedLaneId(undefined);
      if (inspectorTab() === "agent") setInspectorTab("run");
    }
  });

  onMount(() => {
    if (!isMobileRuntime()) {
      const rememberedProject = localStorage.getItem("amplifier-studio.project-dir")?.trim();
      if (rememberedProject) setDefaultDir(rememberedProject);
      else void defaultProjectDir(undefined, "local").then(setDefaultDir).catch(() => undefined);
    }
    if (!isMobileRuntime()) void refreshRuntime();
    void listRuntimeHosts().then((hosts) => {
      setRuntimeHosts(hosts);
      if (!hosts.some((host) => host.id === sessionHomeHostId())) {
        setSessionHomeHost(hosts[0]?.id || (isMobileRuntime() ? "" : "local"));
      }
      void refreshRuntime();
      const home = hosts.find((host) => host.id === sessionHomeHostId()) || hosts[0];
      if (home?.url) void refreshHostProjectRoot(home).catch(() => undefined);
    }).catch((error) => setRuntimeError(cleanError(error)));
    void refreshTranscription();
    queueMicrotask(() => void refreshCatalog());
    const checkForUpdates = () => {
      if (appUpdatesEnabled() && !updateInProgress()) void refreshAppUpdate(false);
    };
    const updateTimer = appUpdatesEnabled() ? window.setTimeout(checkForUpdates, 1_500) : undefined;
    const updateInterval = appUpdatesEnabled() ? window.setInterval(checkForUpdates, 15 * 60_000) : undefined;
    const visibility = () => {
      if (document.visibilityState === "visible") checkForUpdates();
    };
    window.addEventListener("focus", checkForUpdates);
    document.addEventListener("visibilitychange", visibility);
    queueMicrotask(() => void restoreAfterUpdate());
    let nativeDropDisposed = false;
    let unlistenNativeAttachmentDrops: (() => void) | undefined;
    void listenNativeAttachmentDrops(handleNativeAttachmentDrop).then((unlisten) => {
      if (nativeDropDisposed) unlisten();
      else unlistenNativeAttachmentDrops = unlisten;
    }).catch((error) => setRuntimeError(cleanError(error)));
    onCleanup(() => {
      nativeDropDisposed = true;
      window.removeEventListener("focus", checkForUpdates);
      document.removeEventListener("visibilitychange", visibility);
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
      if (updateInterval !== undefined) window.clearInterval(updateInterval);
      unlistenNativeAttachmentDrops?.();
    });
  });

  onCleanup(() => {
    terminalCoordinator?.dispose();
    connections.forEach((connection) => connection.dispose());
    statusPollers.forEach((timer) => window.clearInterval(timer));
    restoreTimers.forEach((timer) => window.clearTimeout(timer));
  });

  const update = (guiId: string, transform: (state: SessionViewState) => SessionViewState) => {
    const detached = detachedSessions.get(guiId);
    if (detached) {
      detachedSessions.set(guiId, transform(detached));
      setDetachedSessionsVersion((version) => version + 1);
    }
    setSessions((items) => items.map((item) => (item.guiId === guiId ? transform(item) : item)));
  };

  const sessionForGuiId = (guiId: string) => sessions().find((item) => item.guiId === guiId)
    || detachedSessionList().find((item) => item.guiId === guiId);

  const handleRecord = (guiId: string, record: ProtocolRecord) => {
    update(guiId, (state) => reduceRecord(state, record));
    if (record.type === "session.started" || record.type === "session.attached") {
      void applyStoredSessionTitle(guiId, typeof record.session_id === "string" ? record.session_id : undefined);
    }
    if (sessionForGuiId(guiId)?.phase === "ready") clearRestoreTimeout(guiId);
    const type = typeof record.type === "string" ? record.type : "";
    if ((type === "session.started" || type === "session.attached") && !initialized.has(guiId)) {
      initialized.add(guiId);
      void sendOp(guiId, { op: "runtime.capabilities" }).catch((error) => reportSendError(guiId, error));
      void sendOp(guiId, { op: "context.get" }).catch((error) => reportSendError(guiId, error));
      void sendOp(guiId, { op: "effort.get" }).catch((error) => reportSendError(guiId, error));
      void sendOp(guiId, { op: "goal.status" }).catch((error) => reportSendError(guiId, error));
      const session = sessionForGuiId(guiId);
      if (session?.resumeId) {
        void requestRestore(guiId);
      } else {
        void requestStatus(guiId);
      }
      const initialPrompt = pendingInitialPrompts.get(guiId);
      if (initialPrompt) {
        pendingInitialPrompts.delete(guiId);
        void sendOp(guiId, {
          op: "submit",
          text: initialPrompt.runtimeText,
          manage_project_plan: true,
          presentation_capabilities: ["markdown", "amplifier-html", "amplifier-svg", "amplifier-dot", "auto-height"],
          ...(imageAttachments(initialPrompt.attachments).length
            ? { attachments: imageAttachments(initialPrompt.attachments).map((image) => ({ media_type: image.mediaType, data: image.data })) }
            : {}),
        }).catch((error) => {
          update(guiId, (state) => markPromptSendFailed(state, cleanError(error)));
        });
      }
    }
  };

  const start = async (input: NewSessionInput, initialPrompt?: string, initialAttachments: ComposerAttachment[] = []) => {
    if (updateInProgress()) throw new Error("Finish the Amplifier Studio update before starting another run");
    await prepareSessionLaunch(input);
    const guiId = createGuiId();
    const state = initialPrompt?.trim()
      ? markPromptSubmitted(
          createSessionState(guiId, input),
          initialPrompt,
          initialAttachments,
          promptWithDocumentAttachments(initialPrompt, initialAttachments),
        )
      : createSessionState(guiId, input);
    setSessions((items) => [...items, state]);
    setActiveId(guiId);
    setDialog(undefined);
    if (initialPrompt?.trim()) pendingInitialPrompts.set(guiId, {
      runtimeText: promptWithDocumentAttachments(initialPrompt, initialAttachments),
      attachments: initialAttachments,
    });
    try {
      const connection = await launchSession(
        { guiId, ...input },
        {
          onRecord: (record) => handleRecord(guiId, record),
          onLog: (log) => update(guiId, (current) => addProcessLog(current, log.stream, log.message)),
          onConnectionChange: (connectivity) => update(guiId, (current) => ({ ...current, connectivity })),
          onExit: (exit) => {
            clearStatusPolling(guiId);
            clearRestoreTimeout(guiId);
            update(guiId, (current) => markExited(current, exit.code, exit.message));
            if (detachedSessions.has(guiId)) discardSessionView(guiId);
          },
        },
      );
      connections.set(guiId, connection);
      startStatusPolling(guiId);
      if (input.hostUrl && input.hostId !== "local" && isTauriRuntime()) {
        void rememberRuntimeHost(guiId, input);
      }
      if (input.projectDir && shouldRememberProjectLocally(input)) {
        localStorage.setItem("amplifier-studio.project-dir", input.projectDir);
        setDefaultDir(input.projectDir);
      }
      if (input.projectDir) void refreshCatalog(input.projectDir, input.hostUrl, input.hostId);
    } catch (error) {
      pendingInitialPrompts.delete(guiId);
      update(guiId, (current) => markExited(current, undefined, cleanError(error)));
      if (input.resumeId && cleanError(error).includes("already open in Amplifier Studio")) {
        const session = stored().find((item) => item.sessionId === input.resumeId
          && (!input.hostId || item.hostId === input.hostId));
        if (session) {
          discardSessionView(guiId);
          setStoredSessionDialog({
            session,
            resumeDisabledReason: "This durable session is already open on its owning compute. Duplicate it to continue independently.",
          });
        }
      }
      throw error;
    }
  };

  const detachSessionView = (guiId: string) => {
    const session = sessions().find((item) => item.guiId === guiId);
    if (!session) return;
    if (!sessionHasLiveRuntime(session)) {
      discardSessionView(guiId);
      return;
    }
    detachedSessions.set(guiId, session);
    setDetachedSessionsVersion((version) => version + 1);
    const remaining = sessions().filter((item) => item.guiId !== guiId);
    setSessions(remaining);
    if (activeId() === guiId) setActiveId(remaining.at(-1)?.guiId);
    if (stopRuntimeRequest()?.guiId === guiId) setStopRuntimeRequest(undefined);
  };

  const activateSessionView = (guiId: string) => {
    const detached = detachedSessions.get(guiId);
    if (detached) {
      detachedSessions.delete(guiId);
      setDetachedSessionsVersion((version) => version + 1);
      setSessions((items) => items.some((item) => item.guiId === guiId) ? items : [...items, detached]);
    }
    setActiveId(guiId);
    setWorkbenchSurface("agent");
  };

  const discardSessionView = (guiId: string) => {
    connections.get(guiId)?.dispose();
    connections.delete(guiId);
    if (detachedSessions.delete(guiId)) setDetachedSessionsVersion((version) => version + 1);
    initialized.delete(guiId);
    pendingInitialPrompts.delete(guiId);
    clearStatusPolling(guiId);
    clearRestoreTimeout(guiId);
    const remaining = sessions().filter((item) => item.guiId !== guiId);
    setSessions(remaining);
    if (activeId() === guiId) setActiveId(remaining.at(-1)?.guiId);
    if (stopRuntimeRequest()?.guiId === guiId) setStopRuntimeRequest(undefined);
  };

  const requestTabClose = (guiId: string) => {
    const session = sessions().find((item) => item.guiId === guiId);
    if (!session) return;
    if (ordinaryTabCloseIntent(session) === "detach") {
      detachSessionView(guiId);
      return;
    }
    setStopRuntimeRequest({ guiId, stopping: false });
  };

  const requestRuntimeStop = (guiId: string) => {
    const session = sessionForGuiId(guiId);
    if (!session || session.phase === "exited" || session.phase === "error") return;
    setStopRuntimeRequest({ guiId, stopping: false });
  };

  const confirmRuntimeStop = async (guiId: string) => {
    const request = stopRuntimeRequest();
    if (!request || request.guiId !== guiId || request.stopping) return;
    setStopRuntimeRequest({ guiId, stopping: true });
    const outcome = await attemptRuntimeStop(() => stopSession(guiId));
    if (outcome.stopped) {
      discardSessionView(guiId);
      return;
    }
    const message = outcome.error || "The runtime did not confirm that it stopped";
    update(guiId, (current) => addLocalNotice(current, `Runtime stop failed: ${message}`, "error"));
    setStopRuntimeRequest({ guiId, stopping: false, error: message });
  };

  const submit = async (text: string, attachments: ComposerAttachment[] = []) => {
    const session = active();
    if (!session) return false;
    const effectiveProvider = session.requestedProvider
      || catalog().providers.find((provider) => provider.model === session.model)?.name
      || "";
    const contractFailure = toolContractFailure(session.model, effectiveProvider);
    if (contractFailure) {
      update(session.guiId, (state) => addLocalNotice(state, contractFailure, "error"));
      return false;
    }
    if (updateInProgress()) {
      update(session.guiId, (state) => addLocalNotice(state, "Amplifier Studio is updating; this runtime is being prepared for a clean restart", "warning"));
      return false;
    }
    if (session.busy) {
      if (imageAttachments(attachments).length) {
        update(session.guiId, (state) => addLocalNotice(
          state,
          "Image attachments can start a new turn, but cannot be added to a mid-turn steer yet. Documents can be steered in.",
          "warning",
        ));
        return false;
      }
      if (session.queuedSteers >= 32) {
        update(session.guiId, (state) => addLocalNotice(state, "Steering queue is full (32 items)", "warning"));
        return false;
      }
      let optimisticSteerId: string | undefined;
      update(session.guiId, (state) => {
        const next = markSteerSubmitted(state, text, attachments);
        optimisticSteerId = next.blocks.at(-1)?.id;
        return next;
      });
      try {
        await sendOp(session.guiId, { op: "steer", text: promptWithDocumentAttachments(text, attachments) });
      } catch (error) {
        update(session.guiId, (state) => markSteerSendFailed(state, cleanError(error), optimisticSteerId));
        return false;
      }
      return true;
    }
    const runtimeText = promptWithDocumentAttachments(text, attachments);
    update(session.guiId, (state) => markPromptSubmitted(state, text, attachments, runtimeText));
    try {
      await sendOp(session.guiId, {
        op: "submit",
        text: runtimeText,
        manage_project_plan: true,
        presentation_capabilities: ["markdown", "amplifier-html", "amplifier-svg", "amplifier-dot", "auto-height"],
        ...(imageAttachments(attachments).length
          ? { attachments: imageAttachments(attachments).map((image) => ({ media_type: image.mediaType, data: image.data })) }
          : {}),
      });
    } catch (error) {
      update(session.guiId, (state) => markPromptSendFailed(state, cleanError(error)));
      return false;
    }
    return true;
  };

  const attachFilesToSession = async (guiId: string, files: File[]) => {
    const session = sessions().find((item) => item.guiId === guiId);
    if (!session) return;
    try {
      const attachments = await appendAttachmentFiles(session.composerAttachments, files);
      update(guiId, (state) => setComposerAttachments(state, attachments));
    } catch (error) {
      update(guiId, (state) => addLocalNotice(state, cleanError(error), "warning"));
    }
  };

  const interrupt = async () => {
    const session = active();
    if (!session) return;
    try {
      await sendOp(session.guiId, { op: "interrupt" });
    } catch (error) {
      reportSendError(session.guiId, error);
    }
  };

  const chooseAttention = async (response: AttentionResponse) => {
    const session = active();
    if (!session) return;
    try {
      if (response.kind === "approval" && session.pendingApproval?.ticketId === response.ticketId) {
        await sendOp(session.guiId, {
          op: "approve",
          ticket_id: response.ticketId,
          choice: response.choice,
        });
        update(session.guiId, (state) => resolveAttention(state, { approvalTicketId: response.ticketId }));
      } else if (response.kind === "decision" && session.pendingDecision?.decisionId === response.decisionId) {
        await sendOp(session.guiId, {
          op: "decision",
          decision_id: response.decisionId,
          answer: response.answer,
        });
      } else {
        update(session.guiId, (state) => addLocalNotice(
          state,
          "That request changed before Studio could answer it. Review the current Amplifier prompt and choose again.",
          "warning",
        ));
        return;
      }
      void requestStatus(session.guiId);
    } catch (error) {
      reportSendError(session.guiId, error);
      throw error;
    }
  };

  const refreshStored = async () => {
    setStoredLoading(true);
    setStoredError(undefined);
    setStoredWarning(undefined);
    const refreshedHosts = await listRuntimeHosts().catch(() => runtimeHosts());
    if (refreshedHosts.length) setRuntimeHosts(refreshedHosts);
    const hosts = refreshedHosts.length
      ? refreshedHosts
      : runtimeHosts().length
        ? runtimeHosts()
        : [{ id: "local", name: "This computer", url: "", tokenRef: "local" }];
    await runLatestStoredRefresh(
      () => loadStoredSessionsAcrossHosts(hosts, (host) => listStoredSessions(
        undefined,
        host.url || undefined,
        host.id,
      )),
      {
        commit: (result) => {
          setStored(result.sessions);
          const message = storedHistoryFailureMessage(result);
          if (result.failures.length === result.hostsQueried) setStoredError(message);
          else setStoredWarning(message);
        },
        reject: (error) => setStoredError(cleanError(error)),
        finish: () => setStoredLoading(false),
      },
    );
  };

  const refreshCatalog = async (projectDir?: string, hostUrl?: string, hostId?: string) => {
    try {
      setCatalog(await listCatalog(projectDir, hostUrl, hostId));
      setCatalogError(undefined);
    } catch (error) {
      setCatalogError(cleanError(error));
    }
  };

  const openDrawer = () => {
    setDrawerOpen(true);
    void refreshStored();
  };

  const openNew = () => {
    void openNewDialog();
  };

  const openNewDialog = async () => {
    const host = sessionHomeHost();
    // A saved host record is only a hint. The host's current config is the
    // security boundary and may have changed since Studio last connected.
    const remembered = host?.url
      ? await refreshHostProjectRoot(host).catch(() => knownHostProjectRoot(host))
      : knownHostProjectRoot(host);
    if (host?.url) await refreshCatalog(remembered, host.url, host.id);
    setDialog({ projectDir: remembered, ...sessionHostInput(host) });
  };

  const openSibling = (bundle?: string, provider?: ProviderOption) => {
    if (provider?.toolCompatible === false) return;
    void openSiblingDialog(bundle, provider);
  };

  const openSiblingDialog = async (bundle?: string, provider?: ProviderOption) => {
    const session = active();
    const host = session ? runtimeHostForSession(session, runtimeHosts()) || sessionHomeHost() : sessionHomeHost();
    const remembered = session?.projectDir || (host?.url
      ? knownHostProjectRoot(host) || await refreshHostProjectRoot(host)
      : knownHostProjectRoot(host));
    setDialog({
      projectDir: remembered,
      ...sessionHostInput(host),
      bundle: bundle || (session?.bundle && session.bundle !== "default bundle" ? session.bundle : undefined),
      provider: provider?.name,
      model: provider?.model,
      mode: session?.mode,
    });
  };

  const openCapability = (capability: StudioCapability) => {
    if (capability.activation !== "parallel-session") return;
    void openCapabilityDialog(capability);
  };

  const openCapabilityDialog = async (capability: StudioCapability) => {
    const session = active();
    const host = session ? runtimeHostForSession(session, runtimeHosts()) || sessionHomeHost() : sessionHomeHost();
    const remembered = session?.projectDir || (host?.url
      ? knownHostProjectRoot(host) || await refreshHostProjectRoot(host)
      : knownHostProjectRoot(host));
    const provider = catalog().providers.find((item) => item.model === session?.model)
      || catalog().providers.find((item) => item.active);
    setCapabilitiesOpen(false);
    setDialog({ ...capabilitySessionInput(
      capability,
      remembered,
      provider ? { provider: provider.name, model: provider.model } : undefined,
    ), ...sessionHostInput(host) });
  };

  const engageAutopilot = async () => {
    const session = active();
    if (!session || !canEngageAutopilot(session)) return;
    if (!autopilotActive() && (session.pendingApproval || session.pendingDecision)) {
      update(session.guiId, (state) => addLocalNotice(
        state,
        "Autopilot is waiting at a consequential decision. Resolve it before autonomous work continues.",
        "warning",
      ));
      openInspector("run");
      return;
    }
    const op = activeSessionAutopilotOp(session);
    if (!op) {
      update(session.guiId, (state) => addLocalNotice(
        state,
        "Send a goal first, then turn on Autopilot for that goal.",
        "warning",
      ));
      return;
    }
    update(session.guiId, markAutopilotPending);
    try {
      await sendOp(session.guiId, op);
      openInspector("run");
    } catch (error) {
      update(session.guiId, (state) => markAutopilotSendFailed(state, cleanError(error)));
    }
  };

  const openInspector = (tab: InspectorTab) => {
    setInspectorTab(tab);
    setRightOpen(true);
  };

  const selectLane = (laneId: string) => {
    setSelectedLaneId(laneId);
    openInspector("agent");
  };

  const cycleEffort = async () => {
    const session = active();
    if (!session) return;
    const levels = session.effortLevels;
    const index = Math.max(0, levels.indexOf(session.effort || "none"));
    const requested = levels[(index + 1) % levels.length] || "none";
    update(session.guiId, (state) => markEffortPending(state, requested));
    try {
      await sendOp(session.guiId, { op: "effort.cycle" });
    } catch (error) {
      update(session.guiId, (state) => ({ ...state, effortPending: undefined }));
      reportSendError(session.guiId, error);
    }
  };

  const setEffort = async (effort: string) => {
    const session = active();
    if (!session || !session.effortLevels.includes(effort)) return;
    update(session.guiId, (state) => markEffortPending(state, effort));
    try {
      await sendOp(session.guiId, { op: "effort.set", effort });
    } catch (error) {
      update(session.guiId, (state) => ({ ...state, effortPending: undefined }));
      reportSendError(session.guiId, error);
    }
  };

  const registerBundle = async (uri: string, name?: string) => {
    const projectDir = active()?.projectDir || defaultDir();
    setCatalog(await addBundle({ projectDir, uri, name }));
    setCatalogError(undefined);
  };

  const reloadCatalog = async () => {
    await refreshCatalog(active()?.projectDir || defaultDir());
  };

  const requestContextForActive = async () => {
    const session = active();
    if (!session) return;
    try {
      await sendOp(session.guiId, { op: "context.get" });
    } catch (error) {
      reportSendError(session.guiId, error);
    }
  };

  const retrySessionRestore = (guiId: string) => {
    update(guiId, retryRestore);
    void requestRestore(guiId);
  };

  const openSessionWithoutFullRestore = (guiId: string) => {
    clearRestoreTimeout(guiId);
    update(guiId, openRestoreAnyway);
  };

  const relaunchFailedSession = async (session: SessionViewState, resumeLatest: boolean) => {
    const resumeId = resumeLatest ? session.runtimeSessionId || session.resumeId : session.resumeId;
    const projectDir = resumeId && !session.hostUrl
      ? await selectProjectFolder(session.projectDir)
      : session.projectDir;
    if (resumeId && !session.hostUrl && nativeProjectPickerAvailable() && !projectDir) return;
    const input: NewSessionInput = {
      projectDir: projectDir || session.projectDir,
      bundle: session.requestedBundle,
      model: session.requestedModel,
      provider: session.requestedProvider,
      mode: session.mode,
      resumeId,
      resumeName: resumeId ? session.title : undefined,
      expectedHistoryMessages: session.expectedHistoryMessages,
      capabilityId: session.capabilityId,
      capabilityName: session.capabilityName,
      hostId: session.hostId,
      hostName: session.hostName,
      hostUrl: session.hostUrl,
    };
    discardSessionView(session.guiId);
    try {
      await start(input);
    } catch {
      // start() keeps the replacement tab visible with its recovery actions.
    }
  };

  const exportSessionDiagnostics = async (session: SessionViewState) => {
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      session,
    };
    const label = (session.runtimeSessionId || session.resumeId || session.guiId).replace(/[^a-zA-Z0-9._-]+/g, "-");
    try {
      const saved = await saveDiagnosticsFile(
        `amplifier-studio-${label}-diagnostics.json`,
        `${JSON.stringify(payload, null, 2)}\n`,
      );
      if (saved) {
        update(session.guiId, (state) => addLocalNotice(state, `Diagnostics saved to ${saved}`, "success"));
      }
    } catch (error) {
      update(session.guiId, (state) => addLocalNotice(state, `Diagnostics export failed: ${cleanError(error)}`, "error"));
    }
  };

  const applyAppUpdate = async () => {
    const current = appUpdate();
    if (current.status === "error") {
      await refreshAppUpdate(true);
      return;
    }
    if (current.status !== "available" || updateBlocked()) return;
    try {
      saveUpdateRestorePlan(localStorage, openSessionViews(), activeId());
    } catch {
      // Update installation remains available even when WebView storage is unavailable.
    }
    try {
      await installAppUpdate(current, setAppUpdate);
    } catch (error) {
      try { clearUpdateRestorePlan(localStorage); } catch { /* storage is optional */ }
      setAppUpdate({ ...current, status: "error", message: cleanError(error) });
    }
  };

  return (
    <div class="app-shell">
      <TabStrip
        sessions={sessions()}
        activeId={activeId()}
        onSelect={(id) => {
          setActiveId(id);
          setWorkbenchSurface("agent");
        }}
        onClose={requestTabClose}
        onNew={openNew}
        onDrawer={openDrawer}
        onSettings={() => setSettingsOpen(true)}
        inspectorOpen={workbenchSurface() === "agent" && rightOpen()}
        inspectorAvailable={workbenchSurface() === "agent" && Boolean(active())}
        onToggleInspector={(attentionSessionId) => {
          const opening = !rightOpen();
          if (opening && attentionSessionId) activateSessionView(attentionSessionId);
          setWorkbenchSurface("agent");
          if (opening) setInspectorTab("run");
          setRightOpen(opening);
        }}
        onOpenExecution={() => openInspector("map")}
        onOpenPlan={() => openInspector("plan")}
        terminalAvailable={Boolean(terminalCoordinator)}
        terminalOpen={workbenchSurface() === "terminal"}
        onToggleTerminal={() => setWorkbenchSurface((surface) => surface === "terminal" ? "agent" : "terminal")}
        update={appUpdate()}
        updateBlocked={updateBlocked()}
        onUpdate={() => void applyAppUpdate()}
      />

      <Show when={workspaceAttachmentDrag()}><div class="native-drop-target">Drop files to attach</div></Show>

      <Show when={workbenchSurface() === "terminal" && terminalCoordinator} fallback={
        <Show
          when={active()}
          fallback={
          <CoordinatorHome
            sessions={stored()}
            loading={storedLoading()}
            transport={transport()}
            runtime={runtime()}
            checking={runtimeChecking()}
            installing={runtimeInstalling()}
            error={runtimeError()}
            onSend={startFromHome}
            onResume={requestStoredResume}
            onNew={openNew}
            projectDir={knownHostProjectRoot(sessionHomeHost())}
            onChooseProject={chooseHomeProject}
            remoteRuntime={Boolean(sessionHomeHost()?.url) || usesWebBridge()}
            onDrawer={openDrawer}
            onInstall={() => void installLocalRuntime()}
            onConfigureProvider={() => setProviderSetupOpen(true)}
            providerSetupSupported={!sessionHomeHost()?.url && !usesWebBridge()}
            onSettings={() => setSettingsOpen(true)}
            attachments={homeAttachments()}
            onAttachments={setHomeAttachments}
            onPickAttachments={pickAttachments}
            transcription={transcription()}
            onTranscribe={transcribeAudio}
          />
          }
        >
        {(session) => (
          <div
            class="workspace"
            id={`session-panel-${session().guiId}`}
            role="tabpanel"
            aria-labelledby={`session-tab-${session().guiId}`}
            classList={{ "left-open": leftOpen(), "right-open": rightOpen() }}
            onDragEnter={(event) => {
              const transfer = event.dataTransfer;
              const target = event.target as HTMLElement | null;
              if (transfer && hasAttachmentFiles(transfer) && !target?.closest(".composer-shell")) {
                event.preventDefault();
                setWorkspaceAttachmentDrag(true);
              }
            }}
            onDragOver={(event) => {
              const transfer = event.dataTransfer;
              const target = event.target as HTMLElement | null;
              if (transfer && hasAttachmentFiles(transfer) && !target?.closest(".composer-shell")) {
                event.preventDefault();
                transfer.dropEffect = "copy";
                setWorkspaceAttachmentDrag(true);
              }
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setWorkspaceAttachmentDrag(false);
            }}
            onDrop={(event) => {
              const target = event.target as HTMLElement | null;
              if (target?.closest(".composer-shell")) return;
              event.preventDefault();
              setWorkspaceAttachmentDrag(false);
              void attachFilesToSession(session().guiId, Array.from(event.dataTransfer?.files || []));
            }}
          >
            <WorkspaceSidebar
              state={session()}
              parallelSummary={parallelSessionSummary(sessions())}
              lanes={lanes()}
              selectedLaneId={selectedLaneId()}
              onSelectLane={selectLane}
              onNew={openNew}
              onResume={openDrawer}
            />
            <div class="session-column">
              <SessionToolbar
                state={session()}
                onDismissAlert={(id) => update(session().guiId, (state) => dismissAlert(state, id))}
                onDetach={() => detachSessionView(session().guiId)}
                onStop={() => requestRuntimeStop(session().guiId)}
              />
              <Transcript
                state={session()}
                onInterrupt={() => void interrupt()}
                onRetryRestore={() => retrySessionRestore(session().guiId)}
                onOpenRestoreAnyway={() => openSessionWithoutFullRestore(session().guiId)}
                onThinkingExpanded={(blockId, expanded) => update(session().guiId, (state) => setThinkingExpanded(state, blockId, expanded))}
                onRetry={session().projectDir ? () => void relaunchFailedSession(session(), true) : undefined}
                retryLabel={session().runtimeSessionId || session().resumeId ? "Retry resume" : "Retry"}
                onExport={() => void exportSessionDiagnostics(session())}
              />
              <div class="input-zone">
                <Show
                  when={session().pendingApproval || session().pendingDecision}
                  fallback={<Composer
                    state={session()}
                    onSend={submit}
                    onDraft={(draft) => update(session().guiId, (state) => setComposerDraft(state, draft))}
                    onAttachments={(attachments) => update(session().guiId, (state) => setComposerAttachments(state, attachments))}
                    onPickAttachments={pickAttachments}
                    onAutopilot={() => void engageAutopilot()}
                    autopilotActive={autopilotActive()}
                    autopilotAvailable={canEngageAutopilot(active())}
                    transcriptionAvailable={transcription()?.available === true}
                    transcriptionMessage={transcription()?.message}
                    onTranscribe={transcribeAudio}
                  />}
                >
                  <AttentionBar state={session()} onChoose={chooseAttention} />
                </Show>
              </div>
              <Footer
                state={session()}
                onCycleEffort={() => void cycleEffort()}
                onSetEffort={(effort) => void setEffort(effort)}
                onContext={() => { openInspector("context"); void requestContextForActive(); }}
                onBuild={() => openInspector("build")}
                onOutputs={() => openInspector("outputs")}
                onToggleWorkspace={() => setLeftOpen((value) => !value)}
              />
            </div>
            <Inspector
              state={session()}
              lane={selectedLane()}
              tab={inspectorTab()}
              transport={transport()}
              bundles={catalog().bundles}
              providers={catalog().providers}
              catalogError={catalogError()}
              onTab={setInspectorTab}
              onSelectLane={selectLane}
              onDismissAlert={(id) => update(session().guiId, (state) => dismissAlert(state, id))}
              onCycleEffort={() => void cycleEffort()}
              onStartSibling={openSibling}
              onAddBundle={registerBundle}
              onRefreshBundles={reloadCatalog}
              onCapabilities={() => setCapabilitiesOpen(true)}
              onStartCapability={openCapability}
              onRequestContext={() => void requestContextForActive()}
              onOpenOutput={async (path) => {
                try {
                  await openLocalOutput(session().projectDir, path, session().hostUrl, session().hostId);
                } catch (error) {
                  update(session().guiId, (state) => addLocalNotice(state, String(error), "error"));
                }
              }}
              onClose={() => setRightOpen(false)}
            />
          </div>
          )}
        </Show>
      } keyed>{(coordinator) => (
        <TerminalWorkSurface
          coordinator={coordinator}
          project={nativeTerminalProject()}
          onClose={() => setWorkbenchSurface("agent")}
        />
      )}</Show>

      <Show when={dialog()} keyed>
        {(initial) => <NewSessionDialog
          initial={initial}
          catalog={catalog()}
          catalogError={catalogError()}
          hosts={runtimeHosts()}
          nativeProjectPicker={nativeProjectPickerAvailable()}
          onCancel={() => setDialog(undefined)}
          onPickProjectDir={pickProjectDirectory}
          canCloneRepository={(host) => host.url
            ? hostCapabilities()[host.id]?.includes("githubRepositoryClone") === true
            : nativeProjectPickerAvailable()}
          onCloneRepository={(repositoryUrl, host) => cloneGithubRepository(
            repositoryUrl,
            host.url || undefined,
            host.id,
          )}
          onHostChange={async (host) => {
            const projectRoot = host.url ? await refreshHostProjectRoot(host) : knownHostProjectRoot(host);
            await refreshCatalog(projectRoot, host.url || undefined, host.id);
            return projectRoot || undefined;
          }}
          onStart={start}
        />}
      </Show>
      <Show when={capabilitiesOpen()}>
        <CapabilityPalette catalog={catalog()} catalogError={catalogError()} onClose={() => setCapabilitiesOpen(false)} onLaunch={openCapability} />
      </Show>
      <Show when={drawerOpen()}>
        <SessionDrawer
          sessions={stored()}
          openSessions={openSessionViews()}
          detachedSessionIds={detachedSessionList().map((session) => session.guiId)}
          activeId={activeId()}
          loading={storedLoading()}
          error={storedError()}
          warning={storedWarning()}
          sourceName={`All compute · ${runtimeHosts().length || 1} host${(runtimeHosts().length || 1) === 1 ? "" : "s"}`}
          sessionHomeName={sessionHomeHost()?.name || "This computer"}
          onClose={() => setDrawerOpen(false)}
          onRefresh={() => void refreshStored()}
          onResume={requestStoredResume}
          onSelectOpen={activateSessionView}
          onDetachOpen={detachSessionView}
          onStopOpen={requestRuntimeStop}
          onNew={openNew}
          onCapabilities={() => setCapabilitiesOpen(true)}
          onSettings={() => setSettingsOpen(true)}
        />
      </Show>
      <Show when={storedSessionDialog()} keyed>{(recovery) => (
        <StoredSessionDialog
          session={recovery.session}
          sessionHomeName={sessionHomeHost()?.name || "This computer"}
          resumeDisabledReason={recovery.resumeDisabledReason}
          onClose={() => setStoredSessionDialog(undefined)}
          onResume={() => prepareStoredResume(recovery.session)}
          onDuplicate={() => duplicateStoredSession(recovery.session)}
        />
      )}</Show>
      <Show when={stopRuntimeRequest()} keyed>{(request) => (
        <Show when={sessionForGuiId(request.guiId)} keyed>{(session) => (
          <SessionLifecycleDialog
            session={session}
            stopping={request.stopping}
            error={request.error}
            onCancel={() => setStopRuntimeRequest(undefined)}
            onDetach={() => detachSessionView(session.guiId)}
            onStop={() => void confirmRuntimeStop(session.guiId)}
          />
        )}</Show>
      )}</Show>
      <Show when={settingsOpen()}>
        <StudioSettingsDialog
          initialProjectDir={settingsProjectDir()}
          initialTheme={studioTheme()}
          runtimeHosts={runtimeHosts()}
          initialSessionHomeHostId={sessionHomeHostId()}
          runtimeSettingsAvailable={localRuntimeSettingsAvailable()}
          nativeProjectPicker={nativeProjectPickerAvailable()}
          onPickProjectDir={pickProjectDirectory}
          onThemePreview={(theme) => {
            setStudioTheme(theme);
            applyStudioTheme(theme);
          }}
          onCancel={() => setSettingsOpen(false)}
          onAddRuntimeHost={async (url, token) => {
            const cleanedUrl = url.trim();
            const cleanedToken = token.trim();
            if (!cleanedUrl || !cleanedToken) throw new Error("Enter both the compute host URL and bearer token");
            const normalized = cleanedUrl.replace(/\/$/, "");
            const matchingHost = runtimeHosts().find((host) => host.url.replace(/\/$/, "") === normalized);
            saveBridgeToken(cleanedToken, cleanedUrl);
            const probe = await probeRuntimeHost(cleanedUrl, matchingHost?.id || "configured");
            const host = durableRuntimeHostForSession({
              projectDir: probe.defaultProjectDir,
              hostId: matchingHost?.id || "configured",
              hostName: matchingHost?.name || "Configured host",
              hostUrl: cleanedUrl,
            }, runtimeHosts());
            if (!host) throw new Error("Studio could not create a durable record for this compute host");
            setHostCapabilities((current) => ({ ...current, [host.id]: probe.capabilities }));
            const wasSaved = runtimeHosts().some((candidate) => candidate.id === host.id && candidate.tokenRef !== "session");
            try {
              await saveRuntimeHost(host);
              await storeRuntimeHostToken(host.id, cleanedToken);
            } catch (error) {
              if (!wasSaved) await removeRuntimeHost(host.id).catch(() => undefined);
              throw error;
            }
            const hosts = await listRuntimeHosts();
            setRuntimeHosts(hosts);
            return hosts.find((candidate) => candidate.id === host.id) || host;
          }}
          onRemoveRuntimeHost={async (id) => {
            await removeRuntimeHost(id);
            setRuntimeHosts(await listRuntimeHosts());
            if (sessionHomeHostId() === id) setSessionHomeHost("local");
          }}
          onSaveStudio={async (theme, homeHostId) => {
            saveStudioTheme(theme);
            setSessionHomeHost(homeHostId);
            setStudioTheme(theme);
            setTransport(transportLabel());
            const homeHost = runtimeHosts().find((host) => host.id === homeHostId);
            const projectDir = homeHost?.url
              ? await refreshHostProjectRoot(homeHost)
              : await defaultProjectDir(undefined, "local");
            if (!homeHost?.url) setDefaultDir(projectDir);
            await Promise.all([
              refreshRuntime(),
              refreshTranscription(),
              refreshStored(),
              refreshCatalog(projectDir, homeHost?.url || undefined, homeHost?.id),
            ]);
          }}
        />
      </Show>
      <Show when={providerSetupOpen()}>
        <ProviderSetupDialog
          configure={configureProvider}
          onClose={() => setProviderSetupOpen(false)}
          onConfigured={(status) => {
            setRuntime(status);
            setRuntimeError(undefined);
            void refreshTranscription();
            void refreshCatalog(defaultDir());
          }}
        />
      </Show>
    </div>
  );

  function reportSendError(guiId: string, error: unknown) {
    update(guiId, (state) => addLocalNotice(state, cleanError(error), "error"));
  }

  function handleNativeAttachmentDrop(event: NativeAttachmentDropEvent) {
    if (event.type === "enter") {
      setWorkspaceAttachmentDrag(true);
      return;
    }
    if (event.type === "leave") {
      setWorkspaceAttachmentDrag(false);
      return;
    }
    setWorkspaceAttachmentDrag(false);
    if (event.type === "error") {
      const session = active();
      if (session) update(session.guiId, (state) => addLocalNotice(state, event.message, "warning"));
      else setRuntimeError(event.message);
      return;
    }
    const attachments = event.attachments.map((attachment, index): ComposerAttachment => ({
      ...attachment,
      id: globalThis.crypto?.randomUUID?.() || `native-attachment-${Date.now()}-${index}`,
    }));
    const session = active();
    try {
      if (session) {
        update(session.guiId, (state) => setComposerAttachments(
          state,
          appendComposerAttachments(state.composerAttachments, attachments),
        ));
      } else {
        setHomeAttachments(appendComposerAttachments(homeAttachments(), attachments));
        setRuntimeError(undefined);
      }
    } catch (error) {
      if (session) update(session.guiId, (state) => addLocalNotice(state, cleanError(error), "warning"));
      else setRuntimeError(cleanError(error));
    }
  }

  async function refreshRuntime() {
    setRuntimeChecking(true);
    setRuntimeError(undefined);
    const host = sessionHomeHost();
    await runLatestRuntimeRefresh(
      () => getRuntimeStatus(host?.url || undefined, host?.id || "local"),
      {
        commit: setRuntime,
        reject: (error) => setRuntimeError(cleanError(error)),
        finish: () => setRuntimeChecking(false),
      },
    );
  }

  async function refreshTranscription() {
    try {
      setTranscription(await getTranscriptionStatus());
    } catch (error) {
      setTranscription({ available: false, message: cleanError(error) });
    }
  }

  async function rememberRuntimeHost(guiId: string, input: NewSessionInput) {
    // Native mobile shells receive their bridge as part of the app's runtime
    // configuration. Persisting a desktop compute-pool record is a host-machine
    // action and would otherwise turn a successful mobile start into a scary,
    // unactionable error banner.
    if (isMobileRuntime()) return;
    const configuredProjectRoot = input.hostUrl
      ? await defaultProjectDir(input.hostUrl, input.hostId).catch(() => input.projectDir)
      : input.projectDir;
    const host = durableRuntimeHostForSession(input, runtimeHosts(), configuredProjectRoot);
    if (!host) return;
    const wasSaved = runtimeHosts().some((candidate) => candidate.id === host.id && candidate.tokenRef !== "session");
    try {
      await saveRuntimeHost(host);
      const token = configuredBridgeToken(host.url);
      if (host.tokenRef.startsWith("keychain:") && token.trim()) {
        try {
          await storeRuntimeHostToken(host.id, token);
        } catch (error) {
          if (!wasSaved) await removeRuntimeHost(host.id).catch(() => undefined);
          throw error;
        }
      }
      setRuntimeHosts(await listRuntimeHosts());
      if (!wasSaved) {
        update(guiId, (state) => addLocalNotice(state, `${host.name} is now available in the remote compute pool.`, "info"));
      }
    } catch (error) {
      const message = `The session is running, but Studio could not save this compute host: ${cleanError(error)}`;
      setRuntimeError(message);
      update(guiId, (state) => addLocalNotice(state, message, "error"));
    }
  }

  async function startFromHome(text: string, attachments: ComposerAttachment[]) {
    const host = sessionHomeHost();
    const remembered = host?.url
      ? await refreshHostProjectRoot(host).catch(() => knownHostProjectRoot(host))
      : knownHostProjectRoot(host);
    const projectDir = remembered || (host?.url ? undefined : await selectProjectFolder());
    if (!projectDir) throw new Error("Choose a project folder before starting the coordinator");
    await start({ projectDir, ...sessionHostInput(host) }, text, attachments);
  }

  async function chooseHomeProject() {
    if (sessionHomeHost()?.url) {
      await openNewDialog();
      return;
    }
    const remembered = localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
    const projectDir = await selectProjectFolder(remembered);
    if (!projectDir) return;
    localStorage.setItem("amplifier-studio.project-dir", projectDir);
    setDefaultDir(projectDir);
    await refreshCatalog(projectDir);
  }

  function requestStoredResume(session: StoredSession) {
    setDrawerOpen(false);
    if (storedSessionResumeBlocker(session, false)) {
      setStoredSessionDialog({ session });
      return;
    }
    void prepareStoredResume(session).catch((error) => setStoredError(cleanError(error)));
  }

  async function prepareStoredResume(session: StoredSession) {
    const alreadyOpenGuiId = openGuiIdForStoredSession(sessions(), session.sessionId, session);
    if (alreadyOpenGuiId) {
      setActiveId(alreadyOpenGuiId);
      setDrawerOpen(false);
      setStoredSessionDialog(undefined);
      return;
    }
    const detachedGuiId = openGuiIdForStoredSession(detachedSessionList(), session.sessionId, session);
    if (detachedGuiId) {
      activateSessionView(detachedGuiId);
      setDrawerOpen(false);
      setStoredSessionDialog(undefined);
      return;
    }
    const host = runtimeHostForStoredSession(session, runtimeHosts());
    if (!host) throw new Error(`The compute host for “${session.name}” is no longer available. Reconnect it in Settings to resume this session.`);
    const remembered = session.projectDir || knownHostProjectRoot(host);
    const projectDir = remembered || (host?.url ? undefined : await selectProjectFolder());
    if (!projectDir) throw new Error("Choose the original project folder before resuming this session.");
    setDrawerOpen(false);
    setStoredSessionDialog(undefined);
    await start({
      projectDir: projectDir || "",
      ...sessionHostInput(host),
      bundle: storedSessionLegacyBundleOverride(session),
      resumeId: session.sessionId,
      resumeName: session.name,
      expectedHistoryMessages: session.messageCount,
    });
  }

  async function duplicateStoredSession(session: StoredSession) {
    const source = runtimeHostForStoredSession(session, runtimeHosts());
    if (!source) throw new Error(`Reconnect ${session.hostName || "the original compute host"} before duplicating this session.`);
    if (!session.projectDir) throw new Error("Studio cannot locate the original project store for this session.");
    const destination = sessionHomeHost();
    if (!destination) throw new Error("Choose a session-home compute in Settings first.");
    const destinationProject = destination.url
      ? await refreshHostProjectRoot(destination).catch(() => knownHostProjectRoot(destination))
      : await selectProjectFolder(knownHostProjectRoot(destination));
    if (!destinationProject) throw new Error(`Choose a project folder on ${destination.name} before duplicating this session.`);

    const payload = await exportStoredSession(
      session.projectDir,
      session.sessionId,
      source.url || undefined,
      source.id,
    );
    const copyId = createGuiId();
    const copyName = `${session.name.replace(/\s+copy(?:\s+\d+)?$/i, "")} copy`;
    await importStoredSession(
      destinationProject,
      payload,
      copyId,
      copyName,
      destination.url || undefined,
      destination.id,
    );
    setStoredSessionDialog(undefined);
    await refreshStored();
    await start({
      projectDir: destinationProject,
      ...sessionHostInput(destination),
      resumeId: copyId,
      resumeName: copyName,
      expectedHistoryMessages: session.messageCount,
    });
  }

  async function selectProjectFolder(remembered?: string): Promise<string | undefined> {
    if (!nativeProjectPickerAvailable()) return remembered?.trim() || undefined;
    try {
      return await pickProjectDirectory(remembered);
    } catch (error) {
      setRuntimeError(cleanError(error));
      return undefined;
    }
  }

  async function restoreAfterUpdate() {
    let restore = [] as ReturnType<typeof takeUpdateRestorePlan>;
    try {
      restore = takeUpdateRestorePlan(localStorage);
    } catch {
      return;
    }
    await refreshStored();
    const failures: string[] = [];
    for (const saved of restore) {
      const session = hydrateLegacyUpdateRestoreEntry(saved, stored());
      try {
        await start(session);
      } catch (error) {
        // Preflight failures leave no dead tab; runtime failures keep the
        // replacement tab visible with actionable diagnostics.
        failures.push(`${session.resumeName || session.resumeId || "saved session"}: ${cleanError(error)}`);
      }
    }
    if (failures.length > 0) {
      setRuntimeError(`Studio could not restore ${failures.length === 1 ? "a session" : `${failures.length} sessions`} after the update. ${failures.join(" ")}`);
    }
  }

  async function installLocalRuntime() {
    setRuntimeInstalling(true);
    setRuntimeError(undefined);
    try {
      const installed = await installRuntime();
      setRuntime(installed);
      await Promise.all([refreshTranscription(), refreshStored(), refreshCatalog(defaultDir())]);
    } catch (error) {
      setRuntimeError(cleanError(error));
    } finally {
      setRuntimeInstalling(false);
    }
  }

  async function refreshAppUpdate(showError: boolean) {
    setAppUpdate({ status: "checking" });
    try {
      setAppUpdate(await checkForAppUpdate());
    } catch (error) {
      setAppUpdate(showError
        ? { status: "error", message: cleanError(error) }
        : { status: "disabled" });
    }
  }

  function startStatusPolling(guiId: string) {
    clearStatusPolling(guiId);
    const timer = window.setInterval(() => {
      const session = sessionForGuiId(guiId);
      if (session?.phase === "ready" && session.busy) void requestStatus(guiId);
    }, 2_500);
    statusPollers.set(guiId, timer);
  }

  function clearStatusPolling(guiId: string) {
    const timer = statusPollers.get(guiId);
    if (timer !== undefined) window.clearInterval(timer);
    statusPollers.delete(guiId);
  }

  function clearRestoreTimeout(guiId: string) {
    const timer = restoreTimers.get(guiId);
    if (timer !== undefined) window.clearTimeout(timer);
    restoreTimers.delete(guiId);
  }

  async function requestRestore(guiId: string) {
    const session = sessionForGuiId(guiId);
    if (!session?.restoreProgress) return;
    clearRestoreTimeout(guiId);
    const fail = (error: unknown) => {
      clearRestoreTimeout(guiId);
      update(guiId, (state) => markRestoreDegraded(state, `Amplifier could not request the remaining restore data: ${cleanError(error)}`));
    };
    if (!session.restoreProgress.status) {
      void sendOp(guiId, { op: "session.status" }).catch(fail);
    }
    if (!session.restoreProgress.history) {
      void sendOp(guiId, { op: "history.replay", since: 0, limit: 0 }).catch(fail);
    }
    const timer = window.setTimeout(() => {
      restoreTimers.delete(guiId);
      update(guiId, (state) => markRestoreDegraded(
        state,
        "Amplifier did not return all restore data within 15 seconds. The runtime is still connected; choose whether to retry or continue with partial state.",
      ));
    }, RESTORE_TIMEOUT_MS);
    restoreTimers.set(guiId, timer);
  }

  async function requestStatus(guiId: string) {
    try {
      await sendOp(guiId, { op: "session.status" });
    } catch {
      // The exit path owns connection errors; polling is deliberately quiet.
    }
  }

  async function applyStoredSessionTitle(guiId: string, runtimeSessionId?: string) {
    if (!runtimeSessionId) return;
    try {
      const current = sessionForGuiId(guiId);
      const match = (await listStoredSessions(undefined, current?.hostUrl, current?.hostId))
        .find((session) => session.sessionId === runtimeSessionId);
      if (!match?.name || /^Session [a-z0-9-]{1,12}$/i.test(match.name)) return;
      update(guiId, (state) => ({ ...state, title: match.name }));
    } catch {
      // Title enrichment is optional; the active runtime is already usable.
    }
  }
}

function sessionHostInput(host?: RuntimeHost): Pick<NewSessionInput, "hostId" | "hostName" | "hostUrl"> {
  if (!host || host.id === "local" || !host.url) {
    return { hostId: "local", hostName: host?.name || "This computer" };
  }
  return { hostId: host.id, hostName: host.name, hostUrl: host.url };
}

function runtimeHostForSession(session: SessionViewState, hosts: RuntimeHost[]): RuntimeHost | undefined {
  const sessionUrl = session.hostUrl?.replace(/\/$/, "");
  return hosts.find((host) => host.id === session.hostId
    || Boolean(sessionUrl && host.url.replace(/\/$/, "") === sessionUrl))
    || (session.hostUrl ? {
      id: session.hostId || "configured",
      name: session.hostName || "Connected host",
      url: session.hostUrl,
      tokenRef: "session",
      defaultProjectRoot: session.projectDir,
    } : undefined);
}

function runtimeHostForStoredSession(session: StoredSession, hosts: RuntimeHost[]): RuntimeHost | undefined {
  const sessionUrl = session.hostUrl?.replace(/\/$/, "");
  const configured = hosts.find((host) => host.id === session.hostId
    || Boolean(sessionUrl && host.url.replace(/\/$/, "") === sessionUrl));
  if (configured) return configured;
  if (session.hostId === "local" || (!session.hostId && !session.hostUrl)) {
    return hosts.find((host) => host.id === "local");
  }
  return session.hostUrl ? {
    id: session.hostId || "configured",
    name: session.hostName || "Connected host",
    url: session.hostUrl,
    tokenRef: "session",
    defaultProjectRoot: session.projectDir,
  } : undefined;
}

function cleanError(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}
