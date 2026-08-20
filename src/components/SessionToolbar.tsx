import { Show } from "solid-js";
import type { SessionViewState } from "../protocol";

export function SessionToolbar(props: {
  state: SessionViewState;
  onDismissAlert: (id: string) => void;
  onDetach: () => void;
  onStop: () => void;
}) {
  const agents = () => Object.values(props.state.lanes);
  const running = () => agents().filter((lane) => lane.status === "running").length;
  return (
    <div class="session-toolbar">
      <div class="session-identity">
        <small>AMPLIFIER COORDINATOR</small>
        <strong>{props.state.title}</strong>
        <span>
          {sessionToolbarStatus(props.state)}
          <Show when={props.state.phase === "ready" && (agents().length || props.state.outputs.length)}>
            {" · "}{agents().length} agents<Show when={running() > 0}> ({running()} live)</Show>{" · "}{props.state.outputs.length} outputs
          </Show>
        </span>
        <div class={`runtime-proof ${runtimeProofTone(props.state)}`} role="status">
          <i aria-hidden="true" />
          <b>{runtimeProofLabel(props.state)}</b>
          <em>{coordinatorExecutionLabel(props.state)}</em>
          <Show when={props.state.runtimeSessionId}>
            <code title={props.state.runtimeSessionId}>{props.state.runtimeSessionId?.slice(0, 8)}</code>
          </Show>
        </div>
      </div>
      <div class="session-toolbar-actions" role="group" aria-label="Session runtime actions">
        <button type="button" onClick={props.onDetach} title="Close this view while leaving the runtime available">Detach view</button>
        <Show when={props.state.phase !== "exited" && props.state.phase !== "error"}>
          <button type="button" class="stop-runtime-button" onClick={props.onStop}>Stop runtime</button>
        </Show>
      </div>
      <Show when={props.state.alerts.at(-1)} keyed>{(alert) => (
        <div class={`session-recovery ${alert.level}`} role="status">
          <div><strong>{alert.title}</strong><span>{alert.message}</span></div>
          <button aria-label="Dismiss setup notice" onClick={() => props.onDismissAlert(alert.id)}>Dismiss</button>
        </div>
      )}</Show>
    </div>
  );
}

export function runtimeProofLabel(state: SessionViewState): string {
  if (state.phase === "ready") return "Amplifier runtime connected";
  if (state.phase === "starting" || state.phase === "degraded") return "Amplifier runtime connecting";
  if (state.phase === "closing") return "Amplifier runtime stopping";
  if (state.phase === "error") return "Amplifier runtime error";
  return "Amplifier runtime stopped";
}

export function coordinatorExecutionLabel(state: SessionViewState): string {
  if (state.phase !== "ready") return state.phase;
  return state.busy ? "Coordinator running" : "Coordinator idle";
}

function runtimeProofTone(state: SessionViewState): string {
  if (state.phase === "ready") return state.busy ? "running" : "connected";
  if (state.phase === "starting" || state.phase === "degraded" || state.phase === "closing") return "connecting";
  return "stopped";
}

export function sessionToolbarStatus(state: SessionViewState): string {
  switch (state.phase) {
    case "starting": return state.bootLabel;
    case "degraded": return "Restore needs attention";
    case "closing": return "Stopping runtime";
    case "exited": return "Session stopped";
    case "error": return state.error || "Session error";
    case "ready": {
      if (state.busy) return state.activity;
      if (state.restoreProgress?.history && state.restoreProgress.status) {
        return state.restoredTranscriptMessages
          ? `Ready · ${state.restoredTranscriptMessages} saved messages restored`
          : "Ready · History restored";
      }
      return "Ready for the next turn";
    }
  }
}
