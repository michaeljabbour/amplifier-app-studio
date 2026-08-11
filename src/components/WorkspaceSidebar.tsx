import { For, Show } from "solid-js";
import type { LaneState, SessionViewState } from "../protocol";
import { Markdown } from "./Markdown";

interface Props {
  sessions: SessionViewState[];
  activeId?: string;
  lanes: LaneState[];
  selectedLaneId?: string;
  onSelectSession: (id: string) => void;
  onSelectLane: (id: string) => void;
  onNew: () => void;
  onResume: () => void;
}

export function WorkspaceSidebar(props: Props) {
  const active = () => props.sessions.find((session) => session.guiId === props.activeId);
  const projectName = () => active()?.projectDir.split(/[\\/]/).filter(Boolean).at(-1) || "No project";

  return (
    <aside class="workbench-sidebar" aria-label="Workspace navigation">
      <div class="sidebar-project">
        <div class="section-kicker">WORKSPACE</div>
        <strong>{projectName()}</strong>
        <span title={active()?.projectDir}>{active()?.projectDir || "Choose a project to begin"}</span>
      </div>

      <section class="sidebar-section">
        <div class="sidebar-heading">
          <span>LIVE SESSIONS</span>
          <button onClick={props.onNew}>New</button>
        </div>
        <div class="sidebar-session-list">
          <For each={props.sessions}>{(session) => (
            <button
              class="sidebar-session"
              classList={{ active: session.guiId === props.activeId }}
              onClick={() => props.onSelectSession(session.guiId)}
            >
              <span class={`tab-status phase-${session.phase}`} />
              <span><strong>{session.title}</strong><small>{session.busy ? session.activity : session.phase}</small></span>
            </button>
          )}</For>
        </div>
        <button class="sidebar-secondary-action" onClick={props.onResume}>Resume any stored session</button>
      </section>

      <section class="sidebar-section agents-section">
        <div class="sidebar-heading">
          <span>AGENT WORKSPACES</span>
          <b>{props.lanes.length}</b>
        </div>
        <Show
          when={props.lanes.length > 0}
          fallback={
            <div class="agent-empty">
              <strong>{active()?.busy ? "Coordinator is working" : "No delegates this turn"}</strong>
              <p>{active()?.busy
                ? "If the coordinator creates specialists, each workspace will appear here live."
                : "Ask for parallel work when the task benefits from independent specialists."}</p>
            </div>
          }
        >
          <div class="agent-workspaces">
            <For each={props.lanes}>{(lane) => <AgentWorkspaceButton
              lane={lane}
              selected={lane.id === props.selectedLaneId}
              onSelect={() => props.onSelectLane(lane.id)}
            />}</For>
          </div>
        </Show>
      </section>
    </aside>
  );
}

function AgentWorkspaceButton(props: { lane: LaneState; selected: boolean; onSelect: () => void }) {
  const runningTools = () => props.lane.tools.filter((tool) => tool.status === "running").length;
  return (
    <button
      class={`agent-workspace ${props.lane.status}`}
      classList={{ selected: props.selected }}
      onClick={props.onSelect}
      aria-label={`Inspect ${props.lane.agent}`}
    >
      <span class="agent-status-word">{props.lane.status === "running" ? "LIVE" : props.lane.status === "completed" ? "DONE" : "CHECK"}</span>
      <span class="agent-workspace-copy">
        <strong>{props.lane.agent}</strong>
        <Markdown compact class="agent-summary" text={props.lane.activity} />
        <Show when={runningTools() > 0}><em>{runningTools()} operation{runningTools() === 1 ? "" : "s"} running</em></Show>
      </span>
      <span class="agent-open-label">Open</span>
    </button>
  );
}
