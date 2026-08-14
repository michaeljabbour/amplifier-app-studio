import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
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
import { StudioSettingsDialog } from "./components/StudioSettingsDialog";
import { TabStrip } from "./components/TabStrip";
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
import type { CapabilityCatalog, ComposerAttachment, NewSessionInput, ProtocolRecord, ProviderOption, SessionViewState, StoredSession } from "./protocol";
import {
  addLocalNotice,
  addProcessLog,
  createSessionState,
  dismissAlert,
  markClosing,
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
  configureProvider,
  configuredBridgeToken,
  defaultProjectDir,
  durableRuntimeHostForSession,
  getRuntimeStatus,
  getTranscriptionStatus,
  openLocalOutput,
  probeRuntimeHost,
  installRuntime,
  listenNativeAttachmentDrops,
  localRuntimeSettingsAvailable,
  launchSession,
  listCatalog,
  listRuntimeHosts,
  listStoredSessions,
  removeRuntimeHost,
  sendOp,
  saveBridgeToken,
  saveRuntimeHost,
  stopSession,
  storeRuntimeHostToken,
  transportLabel,
  transcribeAudio,
  usesWebBridge,
  isTauriRuntime,
  type RuntimeStatus,
  type RuntimeHost,
  type TranscriptionStatus,
  type NativeAttachmentDropEvent,
  type SessionConnection,
} from "./transport";
import { appUpdatesEnabled, checkForAppUpdate, installAppUpdate, type AppUpdateState } from "./updater";
import { clearUpdateRestorePlan, saveUpdateRestorePlan, takeUpdateRestorePlan } from "./updateContinuity";
import { toolContractFailure } from "./providerSafety";
import { applyStudioTheme, loadStudioTheme, saveStudioTheme, type StudioTheme } from "./theme";

const RESTORE_TIMEOUT_MS = 15_000;
const SESSION_HOME_HOST_KEY = "amplifier-studio.session-home-host";

export default function App() {
  const [sessions, setSessions] = createSignal<SessionViewState[]>([]);
  const [activeId, setActiveId] = createSignal<string>();
  const [dialog, setDialog] = createSignal<NewSessionInput>();
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [stored, setStored] = createSignal<StoredSession[]>([]);
  const [storedLoading, setStoredLoading] = createSignal(false);
  const [storedError, setStoredError] = createSignal<string>();
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
  const [workspaceAttachmentDrag, setWorkspaceAttachmentDrag] = createSignal(false);
  const [homeAttachments, setHomeAttachments] = createSignal<ComposerAttachment[]>([]);
  const [appUpdate, setAppUpdate] = createSignal<AppUpdateState>({ status: "disabled" });
  const [runtime, setRuntime] = createSignal<RuntimeStatus>();
  const [runtimeHosts, setRuntimeHosts] = createSignal<RuntimeHost[]>([
    { id: "local", name: "This Mac", url: "", tokenRef: "local" },
  ]);
  const [sessionHomeHostId, setSessionHomeHostId] = createSignal(localStorage.getItem(SESSION_HOME_HOST_KEY) || "local");
  const [runtimeChecking, setRuntimeChecking] = createSignal(true);
  const [runtimeInstalling, setRuntimeInstalling] = createSignal(false);
  const [runtimeError, setRuntimeError] = createSignal<string>();
  const [transcription, setTranscription] = createSignal<TranscriptionStatus>();
  const connections = new Map<string, SessionConnection>();
  const initialized = new Set<string>();
  const statusPollers = new Map<string, number>();
  const restoreTimers = new Map<string, number>();
  const pendingInitialPrompts = new Map<string, { runtimeText: string; attachments: ComposerAttachment[] }>();

  const active = createMemo(() => sessions().find((session) => session.guiId === activeId()));
  const lanes = createMemo(() => Object.values(active()?.lanes || {}));
  const selectedLane = createMemo(() => active()?.lanes[selectedLaneId() || ""]);
  const updateBlocked = createMemo(() => sessions().some((session) => session.busy || session.phase === "starting" || session.phase === "degraded" || session.phase === "closing"));
  const updateInProgress = createMemo(() => appUpdate().status === "downloading" || appUpdate().status === "installing");
  const autopilotActive = createMemo(() => active()?.autopilot === true || active()?.goal?.state === "continuing");
  const sessionHomeHost = createMemo(() => runtimeHosts().find((host) => host.id === sessionHomeHostId())
    || runtimeHosts().find((host) => host.id === "local")
    || runtimeHosts()[0]);

  const setSessionHomeHost = (id: string) => {
    const selected = runtimeHosts().some((host) => host.id === id) ? id : "local";
    setSessionHomeHostId(selected);
    localStorage.setItem(SESSION_HOME_HOST_KEY, selected);
  };

  createEffect(() => {
    const laneId = selectedLaneId();
    if (laneId && !active()?.lanes[laneId]) {
      setSelectedLaneId(undefined);
      if (inspectorTab() === "agent") setInspectorTab("run");
    }
  });

  onMount(() => {
    const rememberedProject = localStorage.getItem("amplifier-studio.project-dir")?.trim();
    if (rememberedProject) setDefaultDir(rememberedProject);
    else void defaultProjectDir().then(setDefaultDir).catch(() => undefined);
    void refreshRuntime();
    void listRuntimeHosts().then((hosts) => {
      setRuntimeHosts(hosts);
      if (!hosts.some((host) => host.id === sessionHomeHostId())) {
        setSessionHomeHost("local");
      } else if (sessionHomeHostId() !== "local") {
        void refreshStored();
        void refreshRuntime();
      }
    }).catch((error) => setRuntimeError(cleanError(error)));
    void refreshTranscription();
    queueMicrotask(() => void refreshStored());
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
    connections.forEach((connection) => connection.dispose());
    statusPollers.forEach((timer) => window.clearInterval(timer));
    restoreTimers.forEach((timer) => window.clearTimeout(timer));
  });

  const update = (guiId: string, transform: (state: SessionViewState) => SessionViewState) => {
    setSessions((items) => items.map((item) => (item.guiId === guiId ? transform(item) : item)));
  };

  const handleRecord = (guiId: string, record: ProtocolRecord) => {
    update(guiId, (state) => reduceRecord(state, record));
    if (record.type === "session.started" || record.type === "session.attached") {
      void applyStoredSessionTitle(guiId, typeof record.session_id === "string" ? record.session_id : undefined);
    }
    if (sessions().find((item) => item.guiId === guiId)?.phase === "ready") clearRestoreTimeout(guiId);
    const type = typeof record.type === "string" ? record.type : "";
    if ((type === "session.started" || type === "session.attached") && !initialized.has(guiId)) {
      initialized.add(guiId);
      void sendOp(guiId, { op: "runtime.capabilities" }).catch((error) => reportSendError(guiId, error));
      void sendOp(guiId, { op: "context.get" }).catch((error) => reportSendError(guiId, error));
      void sendOp(guiId, { op: "effort.get" }).catch((error) => reportSendError(guiId, error));
      void sendOp(guiId, { op: "goal.status" }).catch((error) => reportSendError(guiId, error));
      const session = sessions().find((item) => item.guiId === guiId);
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
          onExit: (exit) => {
            clearStatusPolling(guiId);
            clearRestoreTimeout(guiId);
            update(guiId, (current) => markExited(current, exit.code, exit.message));
          },
        },
      );
      connections.set(guiId, connection);
      startStatusPolling(guiId);
      if (input.hostUrl && input.hostId !== "local" && isTauriRuntime()) {
        void rememberRuntimeHost(guiId, input);
      }
      if (input.projectDir) {
        localStorage.setItem("amplifier-studio.project-dir", input.projectDir);
        setDefaultDir(input.projectDir);
        void refreshCatalog(input.projectDir, input.hostUrl, input.hostId);
      }
    } catch (error) {
      pendingInitialPrompts.delete(guiId);
      update(guiId, (current) => markExited(current, undefined, cleanError(error)));
      throw error;
    }
  };

  const close = async (guiId: string) => {
    const session = sessions().find((item) => item.guiId === guiId);
    if (!session) return;
    if (session.phase === "starting" || session.phase === "degraded" || session.phase === "ready") {
      update(guiId, markClosing);
      try {
        await stopSession(guiId);
      } catch (error) {
        update(guiId, (current) => addLocalNotice(current, cleanError(error), "error"));
      }
    }
    connections.get(guiId)?.dispose();
    connections.delete(guiId);
    initialized.delete(guiId);
    pendingInitialPrompts.delete(guiId);
    clearStatusPolling(guiId);
    clearRestoreTimeout(guiId);
    const remaining = sessions().filter((item) => item.guiId !== guiId);
    setSessions(remaining);
    if (activeId() === guiId) setActiveId(remaining.at(-1)?.guiId);
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
    try {
      const host = sessionHomeHost();
      setStored(await listStoredSessions(undefined, host?.url || undefined, host?.id || "local"));
    } catch (error) {
      setStoredError(cleanError(error));
    } finally {
      setStoredLoading(false);
    }
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
    const remembered = host?.url
      ? host.defaultProjectRoot || ""
      : localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
    const projectDir = host?.url ? remembered : await selectProjectFolder(remembered);
    if (!host?.url && nativeProjectPickerAvailable() && !projectDir) return;
    if (host?.url) await refreshCatalog(projectDir, host.url, host.id);
    setDialog({ projectDir: projectDir || remembered, ...sessionHostInput(host) });
  };

  const openSibling = (bundle?: string, provider?: ProviderOption) => {
    if (provider?.toolCompatible === false) return;
    void openSiblingDialog(bundle, provider);
  };

  const openSiblingDialog = async (bundle?: string, provider?: ProviderOption) => {
    const session = active();
    const host = session ? runtimeHostForSession(session, runtimeHosts()) || sessionHomeHost() : sessionHomeHost();
    const remembered = session?.projectDir || host?.defaultProjectRoot || localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
    const projectDir = host?.url ? remembered : await selectProjectFolder(remembered);
    if (!host?.url && nativeProjectPickerAvailable() && !projectDir) return;
    setDialog({
      projectDir: projectDir || remembered,
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
    const remembered = session?.projectDir || host?.defaultProjectRoot || localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
    const projectDir = host?.url ? remembered : await selectProjectFolder(remembered);
    if (!host?.url && nativeProjectPickerAvailable() && !projectDir) return;
    const provider = catalog().providers.find((item) => item.model === session?.model)
      || catalog().providers.find((item) => item.active);
    setCapabilitiesOpen(false);
    setDialog({ ...capabilitySessionInput(
      capability,
      projectDir || remembered,
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
      capabilityId: session.capabilityId,
      capabilityName: session.capabilityName,
      hostId: session.hostId,
      hostName: session.hostName,
      hostUrl: session.hostUrl,
    };
    await close(session.guiId);
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
      saveUpdateRestorePlan(localStorage, sessions(), activeId());
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
        onSelect={setActiveId}
        onClose={(id) => void close(id)}
        onNew={openNew}
        onDrawer={openDrawer}
        onSettings={() => setSettingsOpen(true)}
        inspectorOpen={rightOpen()}
        inspectorAvailable={Boolean(active())}
        onToggleInspector={() => setRightOpen((value) => !value)}
        onOpenExecution={() => openInspector("map")}
        onOpenPlan={() => openInspector("plan")}
        update={appUpdate()}
        updateBlocked={updateBlocked()}
        onUpdate={() => void applyAppUpdate()}
      />

      <Show when={workspaceAttachmentDrag()}><div class="native-drop-target">Drop files to attach</div></Show>

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
            onResume={prepareStoredResume}
            onNew={openNew}
            projectDir={sessionHomeHost()?.defaultProjectRoot || defaultDir()}
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
              parallelCount={sessions().length}
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
              onRequestContext={() => void requestContextForActive()}
              onOpenOutput={usesWebBridge() ? undefined : async (path) => {
                try {
                  await openLocalOutput(session().projectDir, path);
                } catch (error) {
                  update(session().guiId, (state) => addLocalNotice(state, String(error), "error"));
                }
              }}
            />
          </div>
        )}
      </Show>

      <Show when={dialog()} keyed>
        {(initial) => <NewSessionDialog
          initial={initial}
          catalog={catalog()}
          catalogError={catalogError()}
          hosts={runtimeHosts()}
          nativeProjectPicker={nativeProjectPickerAvailable()}
          onCancel={() => setDialog(undefined)}
          onPickProjectDir={pickProjectDirectory}
          onHostChange={(host) => refreshCatalog(undefined, host.url || undefined, host.id)}
          onStart={start}
        />}
      </Show>
      <Show when={capabilitiesOpen()}>
        <CapabilityPalette catalog={catalog()} catalogError={catalogError()} onClose={() => setCapabilitiesOpen(false)} onLaunch={openCapability} />
      </Show>
      <Show when={drawerOpen()}>
        <SessionDrawer
          sessions={stored()}
          loading={storedLoading()}
          error={storedError()}
          sourceName={sessionHomeHost()?.name || "This Mac"}
          onClose={() => setDrawerOpen(false)}
          onRefresh={() => void refreshStored()}
          onResume={(session) => void prepareStoredResume(session)}
        />
      </Show>
      <Show when={settingsOpen()}>
        <StudioSettingsDialog
          initialProjectDir={active()?.projectDir || localStorage.getItem("amplifier-studio.project-dir") || defaultDir()}
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
            const projectDir = await defaultProjectDir();
            setDefaultDir(projectDir);
            await Promise.all([
              refreshRuntime(),
              refreshTranscription(),
              refreshStored(),
              refreshCatalog(projectDir),
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
    try {
      const host = sessionHomeHost();
      setRuntime(await getRuntimeStatus(host?.url || undefined, host?.id || "local"));
    } catch (error) {
      setRuntimeError(cleanError(error));
    } finally {
      setRuntimeChecking(false);
    }
  }

  async function refreshTranscription() {
    try {
      setTranscription(await getTranscriptionStatus());
    } catch (error) {
      setTranscription({ available: false, message: cleanError(error) });
    }
  }

  async function rememberRuntimeHost(guiId: string, input: NewSessionInput) {
    const host = durableRuntimeHostForSession(input, runtimeHosts());
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
      ? host.defaultProjectRoot || ""
      : localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
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

  async function prepareStoredResume(session: StoredSession) {
    const host = sessionHomeHost();
    const remembered = session.projectDir || localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
    const projectDir = host?.url ? remembered : await selectProjectFolder(remembered);
    if (!host?.url && nativeProjectPickerAvailable() && !projectDir) return;
    setDrawerOpen(false);
    setDialog({
      projectDir: projectDir || "",
      ...sessionHostInput(host),
      resumeId: session.sessionId,
      resumeName: session.name,
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
    for (const session of restore) {
      try {
        await start(session);
      } catch {
        // start() keeps the failed tab visible with its actionable error.
      }
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
      const session = sessions().find((item) => item.guiId === guiId);
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
    const session = sessions().find((item) => item.guiId === guiId);
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
      const current = sessions().find((session) => session.guiId === guiId);
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
    return { hostId: "local", hostName: host?.name || "This Mac" };
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

function cleanError(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}
