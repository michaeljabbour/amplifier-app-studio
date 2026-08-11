import { For, Show } from "solid-js";
import type { LaneState, SessionViewState } from "../protocol";
import { Markdown } from "./Markdown";

interface Props {
  state: SessionViewState;
  parallelCount: number;
  lanes: LaneState[];
  selectedLaneId?: string;
  onSelectLane: (id: string) => void;
  onNew: () => void;
  onResume: () => void;
}

export function WorkspaceSidebar(props: Props) {
  const projectName = () => props.state.projectDir.split(/[\\/]/).filter(Boolean).at(-1) || "No project";

  return (
    <aside class="workbench-sidebar" aria-label="Workspace navigation">
      <div class="sidebar-project">
        <div class="section-kicker">WORKSPACE</div>
        <strong>{projectName()}</strong>
        <span title={props.state.projectDir}>{props.state.projectDir || "Choose a project to begin"}</span>
      </div>

      <section class="sidebar-section">
        <div class="sidebar-heading">
          <span>PARALLEL SESSIONS</span>
          <b>{props.parallelCount} OPEN</b>
        </div>
        <p class="sidebar-section-hint">Each tab above is an independent Amplifier runtime. Switching tabs does not stop the others.</p>
        <div class="sidebar-session-actions">
          <button class="primary" onClick={props.onNew}>+ New parallel session</button>
          <button onClick={props.onResume}>Resume stored</button>
        </div>
      </section>

      <section class="sidebar-section agents-section">
        <div class="sidebar-heading">
          <span>THIS SESSION'S AGENTS</span>
          <b>{props.lanes.length}</b>
        </div>
        <Show
          when={props.lanes.length > 0}
          fallback={
            <div class="agent-empty">
              <strong>{props.state.busy ? "Coordinator is working" : "No child agents this turn"}</strong>
              <p>{props.state.busy
                ? "If this session creates specialists, each child workspace will appear here live."
                : "Child agents belong to the active session; top tabs are separate parallel runtimes."}</p>
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
