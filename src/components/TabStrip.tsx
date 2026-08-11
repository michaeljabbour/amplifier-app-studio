import { For, Show } from "solid-js";
import type { SessionViewState } from "../protocol";
import type { AppUpdateState } from "../updater";

interface Props {
  sessions: SessionViewState[];
  activeId?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onDrawer: () => void;
  onSettings: () => void;
  agentCount: number;
  alertCount: number;
  inspectorOpen: boolean;
  onAgents: () => void;
  onOutputs: () => void;
  onCapabilities: () => void;
  onAutopilot: () => void;
  autopilotActive: boolean;
  autopilotAvailable: boolean;
  onToggleInspector: () => void;
  update: AppUpdateState;
  updateBlocked: boolean;
  onUpdate: () => void;
}

export function TabStrip(props: Props) {
  return (
    <header class="tab-strip" data-tauri-drag-region>
      <div class="traffic-light-space" data-tauri-drag-region />
      <button class="icon-button drawer-button" aria-label="Open session drawer" onClick={props.onDrawer}>
        <span aria-hidden="true">☰</span>
      </button>
      <div class="tabs" data-tauri-drag-region>
        <For each={props.sessions}>
          {(session) => (
            <button
              class="session-tab"
              classList={{ active: props.activeId === session.guiId }}
              onClick={() => props.onSelect(session.guiId)}
              title={session.projectDir}
            >
              <span class={`tab-status phase-${session.phase}`} aria-hidden="true" />
              <span class="tab-title">{session.title}</span>
              {session.busy && <span class="tab-pulse" aria-label="Working" />}
              <span
                class="tab-close"
                role="button"
                tabIndex={0}
                aria-label={`Close ${session.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClose(session.guiId);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.stopPropagation();
                    props.onClose(session.guiId);
                  }
                }}
              >
                ×
              </span>
            </button>
          )}
        </For>
        <button class="new-tab-button" onClick={props.onNew} aria-label="New session" title="New session">
          +
        </button>
      </div>
      <div class="top-workbench-actions">
        <button onClick={props.onCapabilities}>Machines</button>
        <button
          class="autopilot-button"
          classList={{ active: props.autopilotActive }}
          disabled={!props.autopilotAvailable}
          onClick={props.onAutopilot}
          title={props.autopilotAvailable
            ? props.autopilotActive
              ? "Autopilot is directing the active coordinator; open its progress"
              : "Continue autonomously in the active coordinator"
            : "Open a ready session to use Autopilot"}
        >
          {props.autopilotActive ? "Autopilot · active" : "Autopilot"}
        </button>
        <button classList={{ attention: props.alertCount > 0 }} onClick={props.onAgents}>
          Agents <strong>{props.agentCount}</strong>
        </button>
        <button onClick={props.onOutputs}>Outputs</button>
        <button classList={{ active: props.inspectorOpen }} onClick={props.onToggleInspector}>Inspector</button>
      </div>
      <Show when={["available", "downloading", "installing", "error"].includes(props.update.status)}>
        <button
          class={`app-update-button ${props.update.status}`}
          disabled={props.updateBlocked || props.update.status === "downloading" || props.update.status === "installing"}
          onClick={props.onUpdate}
          title={props.updateBlocked
            ? "Finish or interrupt active turns before restarting for the update"
            : props.update.notes || props.update.message || "Install the latest Amplifier Studio release"}
        >
          <span aria-hidden="true" />
          {updateLabel(props.update)}
        </button>
      </Show>
      <button class="icon-button settings-button" aria-label="Bridge settings" onClick={props.onSettings} title="Bridge settings">
        <span aria-hidden="true">⚙</span>
      </button>
      <div class="brand-mark" data-tauri-drag-region>
        <span class="brand-diamond" aria-hidden="true" />
        <span>AMPLIFIER STUDIO</span>
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
