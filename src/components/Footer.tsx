import type { SessionViewState } from "../protocol";
import { formatSessionCost } from "../costEstimate";
import { EffortControl } from "./EffortControl";

export function Footer(props: {
  state: SessionViewState;
  onCycleEffort: () => void;
  onSetEffort: (effort: string) => void;
  onContext: () => void;
  onBuild: () => void;
  onOutputs: () => void;
  onToggleWorkspace: () => void;
}) {
  const contextLabel = () => props.state.context.window > 0 ? `${Math.round(props.state.context.percent)}%` : "—";
  const cost = () => formatSessionCost(props.state.context.costUsd, props.state.context.costBasis, true);
  const costDetail = () => {
    const context = props.state.context;
    if (context.costBasis === "estimated") {
      return `${context.estimateModel || "RunPod"} · blended planning rate${context.estimateRatePerMillion === undefined ? "" : ` $${context.estimateRatePerMillion}/1M tokens`}`;
    }
    if (context.costBasis === "partial") return "Some model usage could not be priced; this is a lower bound";
    if (context.costBasis === "mixed") return "Provider-reported spend plus locally estimated RunPod usage";
    if (context.costBasis === "reported") return "Provider-reported session spend";
    return "The provider has reported usage but no usable price";
  };
  return (
    <footer class="footer-bar">
      <button onClick={props.onToggleWorkspace}><span class="footer-dot" classList={{ active: props.state.phase === "ready" }} />{props.state.phase}</button>
      <button onClick={props.onBuild}>{props.state.mode}</button>
      <div class="footer-grow" title={props.state.projectDir}>{props.state.projectDir}</div>
      <button onClick={props.onBuild}>{props.state.model}</button>
      <EffortControl state={props.state} onCycle={props.onCycleEffort} onSet={props.onSetEffort} />
      <button onClick={props.onContext}>context <strong>{contextLabel()}</strong></button>
      <button onClick={props.onOutputs}>outputs <strong>{props.state.outputs.length}</strong></button>
      <div class="footer-cost" title={costDetail()}>{cost()}</div>
    </footer>
  );
}
