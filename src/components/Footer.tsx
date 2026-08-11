import type { SessionViewState } from "../protocol";

export function Footer(props: {
  state: SessionViewState;
  onCycleEffort: () => void;
  onContext: () => void;
  onBuild: () => void;
  onOutputs: () => void;
  onToggleWorkspace: () => void;
}) {
  const contextLabel = () => props.state.context.window > 0 ? `${Math.round(props.state.context.percent)}%` : "—";
  const cost = () => {
    const numeric = Number(props.state.context.costUsd);
    return Number.isFinite(numeric) ? `$${numeric.toFixed(numeric < 0.1 ? 4 : 2)}` : `$${props.state.context.costUsd}`;
  };
  return (
    <footer class="footer-bar">
      <button onClick={props.onToggleWorkspace}><span class="footer-dot" classList={{ active: props.state.phase === "ready" }} />{props.state.phase}</button>
      <button onClick={props.onBuild}>{props.state.mode}</button>
      <div class="footer-grow" title={props.state.projectDir}>{props.state.projectDir}</div>
      <button onClick={props.onBuild}>{props.state.model}</button>
      <button onClick={props.onCycleEffort} title="Cycle effort">effort <strong>{props.state.effort || "none"}</strong></button>
      <button onClick={props.onContext}>context <strong>{contextLabel()}</strong></button>
      <button onClick={props.onOutputs}>outputs <strong>{props.state.outputs.length}</strong></button>
      <div class="footer-cost">{cost()}</div>
    </footer>
  );
}
