import { Show } from "solid-js";
import type { SessionViewState } from "../protocol";

export function SessionToolbar(props: {
  state: SessionViewState;
  onDismissAlert: (id: string) => void;
}) {
  const agents = () => Object.values(props.state.lanes);
  const running = () => agents().filter((lane) => lane.status === "running").length;
  return (
    <div class="session-toolbar">
      <div class="session-identity">
        <small>COORDINATOR CHAT</small>
        <strong>{props.state.title}</strong>
        <span>
          {props.state.busy ? props.state.activity : "Ready for the next turn"}
          <Show when={agents().length || props.state.outputs.length}>
            {" · "}{agents().length} agents<Show when={running() > 0}> ({running()} live)</Show>{" · "}{props.state.outputs.length} outputs
          </Show>
        </span>
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
