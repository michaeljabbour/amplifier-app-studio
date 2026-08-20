import { For, Show } from "solid-js";
import { Activity, Menu, Settings2, SquareTerminal } from "lucide-solid";
import { appUpdateButtonTitle } from "../appUpdateCopy";
import { adjacentTabIndex, ordinaryTabCloseIntent } from "../sessionLifecycle";
import type { SessionViewState } from "../protocol";
import type { AppUpdateState } from "../updater";
import { startNativeWindowDrag } from "../windowDrag";
import { PlanPresence } from "./Plan";
import { ExecutionPresence } from "./ExecutionMap";
import { workAttentionSummary } from "../mobileWork";

interface Props {
  sessions: SessionViewState[];
  activeId?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onDrawer: () => void;
  onSettings: () => void;
  inspectorOpen: boolean;
  inspectorAvailable: boolean;
  onToggleInspector: (attentionSessionId?: string) => void;
  onOpenPlan: () => void;
  onOpenExecution: () => void;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  update: AppUpdateState;
  updateBlocked: boolean;
  onUpdate: () => void;
}

export function TabStrip(props: Props) {
  const active = () => props.sessions.find((session) => session.guiId === props.activeId);
  const attention = () => workAttentionSummary(props.sessions);
  const selectAdjacentTab = (event: KeyboardEvent, index: number) => {
    const target = adjacentTabIndex(event.key, index, props.sessions.length);
    if (target === undefined) return;
    event.preventDefault();
    const currentTab = event.currentTarget as HTMLButtonElement;
    const tabs = currentTab.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs?.item(target).focus();
    props.onSelect(props.sessions[target].guiId);
  };
  return (
    <header class="tab-strip" data-tauri-drag-region onMouseDown={startNativeWindowDrag}>
      <div class="mobile-topbar" onMouseDown={(event) => event.stopPropagation()}>
        <button class="mobile-topbar-button" aria-label="Open navigation" onClick={props.onDrawer}>
          <Menu aria-hidden="true" />
        </button>
        <div class="mobile-agent-title">Amplifier Agent</div>
        <button
          class="mobile-topbar-button mobile-work-button"
          classList={{ active: props.inspectorAvailable && props.inspectorOpen, attention: attention().count > 0 }}
          aria-label={attention().count
            ? `Open Work, ${attention().count} item${attention().count === 1 ? "" : "s"} need attention: ${attention().name}`
            : props.inspectorAvailable ? "Open Work" : "Work is unavailable without an open session"}
          aria-pressed={props.inspectorAvailable ? props.inspectorOpen : undefined}
          disabled={!props.inspectorAvailable}
          onClick={() => props.onToggleInspector(attention().sessionId)}
        >
          <Activity aria-hidden="true" />
          <span class="mobile-work-label">Work</span>
          <span class={`mobile-runtime-dot phase-${active()?.connectivity?.status === "reconnecting" ? "reconnecting" : active()?.phase || "idle"}`} aria-hidden="true" />
          <Show when={attention().count > 0}>
            <span class="mobile-work-attention-count" aria-hidden="true">{attention().count}</span>
          </Show>
        </button>
      </div>
      <div class="traffic-light-space" data-tauri-drag-region />
      <button class="icon-button drawer-button" aria-label="Open session drawer" onClick={props.onDrawer}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M4 10h12M4 14h12" /></svg>
      </button>
      <div class="tabs" classList={{ empty: props.sessions.length === 0 }} role="tablist" aria-label="Open sessions" data-tauri-drag-region>
        <For each={props.sessions}>
          {(session, index) => (
            <div class="session-tab-shell" classList={{ active: props.activeId === session.guiId }} role="presentation">
              <button
                class="session-tab"
                type="button"
                role="tab"
                id={`session-tab-${session.guiId}`}
                aria-controls={`session-panel-${session.guiId}`}
                aria-selected={props.activeId === session.guiId}
                tabIndex={props.activeId === session.guiId || (!props.activeId && index() === 0) ? 0 : -1}
                onClick={() => props.onSelect(session.guiId)}
                onKeyDown={(event) => selectAdjacentTab(event, index())}
                title={`${session.title}\n${session.projectDir}`}
              >
                <span class={`tab-status phase-${session.connectivity?.status === "reconnecting" ? "reconnecting" : session.phase}`} aria-hidden="true" />
                <span class="tab-title">{session.title}</span>
                <Show when={session.hostName && session.hostId !== "local"}>
                  <span class="tab-host" title={`Runtime host: ${session.hostName}`}>{session.hostName}</span>
                </Show>
                {session.busy && <span class="tab-pulse" aria-label="Working" />}
              </button>
              <button
                class="tab-close"
                type="button"
                aria-label={ordinaryTabCloseIntent(session) === "detach" ? `Detach view from ${session.title}` : `Close ${session.title}`}
                title={ordinaryTabCloseIntent(session) === "detach" ? "Detach view — runtime keeps running" : "Close session"}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClose(session.guiId);
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
      <button class="new-tab-button" onClick={props.onNew} aria-label="New parallel session" title="New independent parallel session">
        +
      </button>
      <div class="top-workbench-actions">
        <Show when={props.terminalAvailable}>
          <button
            type="button"
            class="terminal-toggle"
            classList={{ active: props.terminalOpen }}
            onClick={props.onToggleTerminal}
            aria-label={props.terminalOpen ? "Return to Amplifier Agent" : "Open terminal sessions"}
            aria-pressed={props.terminalOpen}
            title={props.terminalOpen ? "Return to Amplifier Agent" : "Open durable local terminal sessions"}
          >
            <SquareTerminal aria-hidden="true" />
            <span>{props.terminalOpen ? "Agent" : "Terminal"}</span>
          </button>
        </Show>
        <ExecutionPresence state={active()} onOpen={props.onOpenExecution} />
        <PlanPresence state={active()} onOpen={props.onOpenPlan} />
        <button
          class="inspector-toggle"
          classList={{ active: props.inspectorAvailable && props.inspectorOpen }}
          disabled={!props.inspectorAvailable}
          onClick={() => props.onToggleInspector()}
          aria-label={!props.inspectorAvailable ? "Session inspector unavailable without an open session" : props.inspectorOpen ? "Hide session inspector" : "Show session inspector"}
          title={!props.inspectorAvailable ? "Open or start a session to inspect its run" : props.inspectorOpen ? "Hide session inspector" : "Show run, plan, agents, setup, outputs, and context"}
        >
          <span class="inspector-toggle-glyph" aria-hidden="true"><i /><i /><i /></span>
          <span>Inspect</span>
        </button>
      </div>
      <Show when={["available", "downloading", "installing", "error"].includes(props.update.status)}>
        <button
          class={`app-update-button ${props.update.status}`}
          disabled={props.updateBlocked || props.update.status === "downloading" || props.update.status === "installing"}
          onClick={props.onUpdate}
          title={appUpdateButtonTitle(props.update, props.updateBlocked)}
        >
          <span aria-hidden="true" />
          {updateLabel(props.update)}
        </button>
      </Show>
      <Show when={props.update.status === "error" && props.update.message}>
        <div class="app-update-error" role="alert" onMouseDown={(event) => event.stopPropagation()}>
          <strong>Studio update did not install</strong>
          <span>{props.update.message}</span>
          <small>Retry checks the release again before another install attempt.</small>
        </div>
      </Show>
      <button class="icon-button settings-button" aria-label="Studio settings" onClick={props.onSettings} title="Studio and Amplifier settings">
        <Settings2 aria-hidden="true" />
      </button>
      <div class="brand-mark" data-tauri-drag-region>
        <span class="brand-diamond" aria-hidden="true" />
        <span class="brand-wordmark">AMPLIFIER</span>
        <span class="brand-ticks" aria-hidden="true"><i /><i /><i /><i /></span>
      </div>
    </header>
  );
}

function updateLabel(update: AppUpdateState): string {
  if (update.status === "downloading") return update.progress === undefined ? "Downloading update" : `Update ${update.progress}%`;
  if (update.status === "installing") return "Restarting…";
  if (update.status === "error") return "Retry update";
  return `Update ${update.version || "available"}`;
}
