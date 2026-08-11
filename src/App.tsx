import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { AttentionBar } from "./components/AttentionBar";
import { BridgeSettingsDialog } from "./components/BridgeSettingsDialog";
import { CapabilityPalette } from "./components/CapabilityPalette";
import { Composer } from "./components/Composer";
import { CoordinatorHome } from "./components/CoordinatorHome";
import { Footer } from "./components/Footer";
import { Inspector, type InspectorTab } from "./components/Inspector";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { SessionToolbar } from "./components/SessionToolbar";
import { SessionDrawer } from "./components/SessionDrawer";
import { TabStrip } from "./components/TabStrip";
import { Transcript } from "./components/Transcript";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { capabilitySessionInput, STUDIO_CAPABILITIES, type StudioCapability } from "./capabilities";
import { activeSessionAutopilotOp, canEngageAutopilot } from "./autopilot";
import type { CapabilityCatalog, NewSessionInput, ProtocolRecord, ProviderOption, SessionViewState, StoredSession } from "./protocol";
import {
  addLocalNotice,
  addProcessLog,
  createSessionState,
  dismissAlert,
  markClosing,
  markAutopilotEngaged,
  markEffortPending,
  markExited,
  markPromptSendFailed,
  markPromptSubmitted,
  queueLocalSteer,
  reduceRecord,
  resolveAttention,
} from "./reducer";
import {
  createGuiId,
  addBundle,
  configuredBridgeUrl,
  defaultProjectDir,
  getRuntimeStatus,
  installRuntime,
  launchSession,
  listCatalog,
  listStoredSessions,
  sendOp,
  saveBridgeUrl,
  stopSession,
  transportLabel,
  type RuntimeStatus,
  type SessionConnection,
} from "./transport";
import { appUpdatesEnabled, checkForAppUpdate, installAppUpdate, type AppUpdateState } from "./updater";
import { clearUpdateRestorePlan, saveUpdateRestorePlan, takeUpdateRestorePlan } from "./updateContinuity";

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
  const [capabilitiesOpen, setCapabilitiesOpen] = createSignal(false);
  const [transport, setTransport] = createSignal(transportLabel());
  const [catalog, setCatalog] = createSignal<CapabilityCatalog>({ bundles: [], providers: [] });
  const [selectedLaneId, setSelectedLaneId] = createSignal<string>();
  const [inspectorTab, setInspectorTab] = createSignal<InspectorTab>("run");
  const [leftOpen, setLeftOpen] = createSignal(window.matchMedia("(min-width: 761px)").matches);
  const [rightOpen, setRightOpen] = createSignal(false);
  const [appUpdate, setAppUpdate] = createSignal<AppUpdateState>({ status: "disabled" });
  const [runtime, setRuntime] = createSignal<RuntimeStatus>();
  const [runtimeChecking, setRuntimeChecking] = createSignal(true);
  const [runtimeInstalling, setRuntimeInstalling] = createSignal(false);
  const [runtimeError, setRuntimeError] = createSignal<string>();
  const connections = new Map<string, SessionConnection>();
  const initialized = new Set<string>();
  const statusPollers = new Map<string, number>();
  const pendingInitialPrompts = new Map<string, string>();

  const active = createMemo(() => sessions().find((session) => session.guiId === activeId()));
  const lanes = createMemo(() => Object.values(active()?.lanes || {}));
  const selectedLane = createMemo(() => active()?.lanes[selectedLaneId() || ""]);
  const updateBlocked = createMemo(() => sessions().some((session) => session.busy || session.phase === "starting" || session.phase === "closing"));
  const updateInProgress = createMemo(() => appUpdate().status === "downloading" || appUpdate().status === "installing");
  const autopilotActive = createMemo(() => active()?.autopilot === true || active()?.goal?.state === "continuing");

  createEffect(() => {
    const laneId = selectedLaneId();
    if (laneId && !active()?.lanes[laneId]) {
      setSelectedLaneId(undefined);
      if (inspectorTab() === "agent") setInspectorTab("run");
    }
  });

  onMount(() => {
    void defaultProjectDir().then(setDefaultDir).catch(() => undefined);
    void refreshRuntime();
    queueMicrotask(() => void refreshStored());
    queueMicrotask(() => void refreshCatalog());
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const session = active();
      if (session?.pendingApproval) {
        event.preventDefault();
        void chooseAttention("Deny");
      }
    };
    window.addEventListener("keydown", keydown);
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
    onCleanup(() => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("focus", checkForUpdates);
      document.removeEventListener("visibilitychange", visibility);
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
      if (updateInterval !== undefined) window.clearInterval(updateInterval);
    });
  });

  onCleanup(() => {
    connections.forEach((connection) => connection.dispose());
    statusPollers.forEach((timer) => window.clearInterval(timer));
  });

  const update = (guiId: string, transform: (state: SessionViewState) => SessionViewState) => {
    setSessions((items) => items.map((item) => (item.guiId === guiId ? transform(item) : item)));
  };

  const handleRecord = (guiId: string, record: ProtocolRecord) => {
    update(guiId, (state) => reduceRecord(state, record));
    const type = typeof record.type === "string" ? record.type : "";
    if ((type === "session.started" || type === "session.attached") && !initialized.has(guiId)) {
      initialized.add(guiId);
      void requestStatus(guiId);
      void sendOp(guiId, { op: "context.get" }).catch((error) => reportSendError(guiId, error));
      void sendOp(guiId, { op: "effort.get" }).catch((error) => reportSendError(guiId, error));
      const session = sessions().find((item) => item.guiId === guiId);
      if (session?.resumeId) {
        void sendOp(guiId, { op: "history.replay", since: 0, limit: 0 }).catch((error) => reportSendError(guiId, error));
      }
      const initialPrompt = pendingInitialPrompts.get(guiId);
      if (initialPrompt) {
        pendingInitialPrompts.delete(guiId);
        void sendOp(guiId, { op: "submit", text: initialPrompt }).catch((error) => {
          update(guiId, (state) => markPromptSendFailed(state, cleanError(error)));
        });
      }
    }
  };

  const start = async (input: NewSessionInput, initialPrompt?: string) => {
    if (updateInProgress()) throw new Error("Finish the Amplifier Studio update before starting another machine");
    const guiId = createGuiId();
    const state = initialPrompt?.trim()
      ? markPromptSubmitted(createSessionState(guiId, input), initialPrompt)
      : createSessionState(guiId, input);
    setSessions((items) => [...items, state]);
    setActiveId(guiId);
    setDialog(undefined);
    if (initialPrompt?.trim()) pendingInitialPrompts.set(guiId, initialPrompt.trim());
    try {
      const connection = await launchSession(
        { guiId, ...input },
        {
          onRecord: (record) => handleRecord(guiId, record),
          onLog: (log) => update(guiId, (current) => addProcessLog(current, log.stream, log.message)),
          onExit: (exit) => {
            clearStatusPolling(guiId);
            update(guiId, (current) => markExited(current, exit.code, exit.message));
          },
        },
      );
      connections.set(guiId, connection);
      startStatusPolling(guiId);
      if (input.projectDir) {
        localStorage.setItem("amplifier-studio.project-dir", input.projectDir);
        setDefaultDir(input.projectDir);
        void refreshCatalog(input.projectDir);
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
    if (session.phase === "starting" || session.phase === "ready") {
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
    const remaining = sessions().filter((item) => item.guiId !== guiId);
    setSessions(remaining);
    if (activeId() === guiId) setActiveId(remaining.at(-1)?.guiId);
  };

  const submit = async (text: string) => {
    const session = active();
    if (!session) return;
    if (updateInProgress()) {
      update(session.guiId, (state) => addLocalNotice(state, "Amplifier Studio is updating; this runtime is being prepared for a clean restart", "warning"));
      return;
    }
    if (session.busy) {
      if (session.queuedSteers >= 32) {
        update(session.guiId, (state) => addLocalNotice(state, "Steering queue is full (32 items)", "warning"));
        return;
      }
      await sendOp(session.guiId, { op: "steer", text });
      update(session.guiId, queueLocalSteer);
      return;
    }
    update(session.guiId, (state) => markPromptSubmitted(state, text));
    try {
      await sendOp(session.guiId, { op: "submit", text });
    } catch (error) {
      update(session.guiId, (state) => markPromptSendFailed(state, cleanError(error)));
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

  const chooseAttention = async (choice: string) => {
    const session = active();
    if (!session) return;
    const expected = {
      approvalTicketId: session.pendingApproval?.ticketId,
      decisionId: session.pendingDecision?.decisionId,
    };
    try {
      if (session.pendingApproval) {
        await sendOp(session.guiId, {
          op: "approve",
          ticket_id: session.pendingApproval.ticketId,
          choice,
        });
      } else if (session.pendingDecision) {
        await sendOp(session.guiId, {
          op: "decision",
          decision_id: session.pendingDecision.decisionId,
          answer: choice,
        });
      }
      update(session.guiId, (state) => resolveAttention(state, expected));
      void requestStatus(session.guiId);
    } catch (error) {
      reportSendError(session.guiId, error);
    }
  };

  const refreshStored = async () => {
    setStoredLoading(true);
    setStoredError(undefined);
    try {
      setStored(await listStoredSessions());
    } catch (error) {
      setStoredError(cleanError(error));
    } finally {
      setStoredLoading(false);
    }
  };

  const refreshCatalog = async (projectDir?: string) => {
    try {
      setCatalog(await listCatalog(projectDir));
    } catch {
      // Discovery is additive; names can still be entered manually if the CLI is unavailable.
    }
  };

  const openDrawer = () => {
    setDrawerOpen(true);
    void refreshStored();
  };

  const openNew = () => {
    const remembered = localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
    setDialog({ projectDir: remembered });
  };

  const openSibling = (bundle?: string, provider?: ProviderOption) => {
    const session = active();
    const remembered = session?.projectDir || localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
    setDialog({
      projectDir: remembered,
      bundle: bundle || (session?.bundle && session.bundle !== "default bundle" ? session.bundle : undefined),
      provider: provider?.name,
      model: provider?.model,
      mode: session?.mode,
    });
  };

  const openCapability = (capability: StudioCapability) => {
    if (capability.activation === "included") {
      setCapabilitiesOpen(false);
      if (active()) openInspector("run");
      return;
    }
    const session = active();
    const remembered = session?.projectDir || localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
    const provider = catalog().providers.find((item) => item.model === session?.model)
      || catalog().providers.find((item) => item.active);
    setCapabilitiesOpen(false);
    setDialog(capabilitySessionInput(
      capability,
      remembered,
      provider ? { provider: provider.name, model: provider.model } : undefined,
    ));
  };

  const engageAutopilot = async () => {
    const session = active();
    if (!session || !canEngageAutopilot(session)) return;
    if (autopilotActive()) {
      openInspector("run");
      return;
    }
    if (session.pendingApproval || session.pendingDecision) {
      update(session.guiId, (state) => addLocalNotice(
        state,
        "Autopilot is waiting at a consequential decision. Resolve it before autonomous work continues.",
        "warning",
      ));
      openInspector("run");
      return;
    }
    if (session.busy && session.queuedSteers >= 32) {
      update(session.guiId, (state) => addLocalNotice(state, "Steering queue is full (32 items)", "warning"));
      return;
    }
    try {
      await sendOp(session.guiId, activeSessionAutopilotOp(session));
      update(session.guiId, (state) => {
        const engaged = markAutopilotEngaged(state);
        return session.busy ? queueLocalSteer(engaged) : engaged;
      });
      openInspector("run");
    } catch (error) {
      reportSendError(session.guiId, error);
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
  };

  const reloadCatalog = async () => {
    setCatalog(await listCatalog(active()?.projectDir || defaultDir()));
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
        onToggleInspector={() => setRightOpen((value) => !value)}
        update={appUpdate()}
        updateBlocked={updateBlocked()}
        onUpdate={() => void applyAppUpdate()}
      />

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
            onResume={resumeStored}
            onNew={openNew}
            onDrawer={openDrawer}
            onInstall={() => void installLocalRuntime()}
            onSettings={() => setSettingsOpen(true)}
          />
        }
      >
        {(session) => (
          <div class="workspace" classList={{ "left-open": leftOpen(), "right-open": rightOpen() }}>
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
              <Transcript state={session()} onInterrupt={() => void interrupt()} />
              <div class="input-zone">
                <Show
                  when={session().pendingApproval || session().pendingDecision}
                  fallback={<Composer
                    state={session()}
                    onSend={submit}
                    onAutopilot={() => void engageAutopilot()}
                    autopilotActive={autopilotActive()}
                    autopilotAvailable={canEngageAutopilot(active())}
                  />}
                >
                  <AttentionBar state={session()} onChoose={(choice) => void chooseAttention(choice)} />
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
              onTab={setInspectorTab}
              onSelectLane={selectLane}
              onDismissAlert={(id) => update(session().guiId, (state) => dismissAlert(state, id))}
              onCycleEffort={() => void cycleEffort()}
              onStartSibling={openSibling}
              onAddBundle={registerBundle}
              onRefreshBundles={reloadCatalog}
              onCapabilities={() => setCapabilitiesOpen(true)}
              onRequestContext={() => void requestContextForActive()}
            />
          </div>
        )}
      </Show>

      <Show when={dialog()} keyed>
        {(initial) => <NewSessionDialog initial={initial} catalog={catalog()} onCancel={() => setDialog(undefined)} onStart={start} />}
      </Show>
      <Show when={capabilitiesOpen()}>
        <CapabilityPalette catalog={catalog()} onClose={() => setCapabilitiesOpen(false)} onLaunch={openCapability} />
      </Show>
      <Show when={drawerOpen()}>
        <SessionDrawer
          sessions={stored()}
          loading={storedLoading()}
          error={storedError()}
          onClose={() => setDrawerOpen(false)}
          onRefresh={() => void refreshStored()}
          onResume={(session) => {
            setDrawerOpen(false);
            setDialog({
              projectDir: session.projectDir || "",
              resumeId: session.sessionId,
              resumeName: session.name || `Session ${session.sessionId.slice(0, 8)}`,
            });
          }}
        />
      </Show>
      <Show when={settingsOpen()}>
        <BridgeSettingsDialog
          initialUrl={configuredBridgeUrl()}
          locked={sessions().length > 0}
          onCancel={() => setSettingsOpen(false)}
          onSave={(url) => {
            saveBridgeUrl(url);
            setTransport(transportLabel());
            setSettingsOpen(false);
            void defaultProjectDir().then(setDefaultDir).catch(() => setDefaultDir(""));
          }}
        />
      </Show>
    </div>
  );

  function reportSendError(guiId: string, error: unknown) {
    update(guiId, (state) => addLocalNotice(state, cleanError(error), "error"));
  }

  async function refreshRuntime() {
    setRuntimeChecking(true);
    setRuntimeError(undefined);
    try {
      setRuntime(await getRuntimeStatus());
    } catch (error) {
      setRuntimeError(cleanError(error));
    } finally {
      setRuntimeChecking(false);
    }
  }

  async function startFromHome(text: string) {
    const projectDir = localStorage.getItem("amplifier-studio.project-dir") || defaultDir();
    if (!projectDir) throw new Error("Choose a project folder before starting the coordinator");
    await start({ projectDir }, text);
  }

  async function resumeStored(session: StoredSession) {
    if (!session.projectDir) throw new Error("Choose the original project folder before resuming this session");
    await start({
      projectDir: session.projectDir,
      resumeId: session.sessionId,
      resumeName: session.name || `Session ${session.sessionId.slice(0, 8)}`,
    });
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
      await Promise.all([refreshStored(), refreshCatalog(defaultDir())]);
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

  async function requestStatus(guiId: string) {
    try {
      await sendOp(guiId, { op: "session.status" });
    } catch {
      // The exit path owns connection errors; polling is deliberately quiet.
    }
  }
}

function cleanError(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}
