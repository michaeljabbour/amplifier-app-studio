import { popoverDismiss } from "./popoverDismiss";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { ProviderOption, SessionViewState } from "../protocol";
import { formatSessionCost } from "../costEstimate";
import { ModeControl } from "./ModeControl";
import { EffortControl } from "./EffortControl";

export function Footer(props: {
  state: SessionViewState;
  providers?: ProviderOption[];
  onRequestModes?: () => void;
  onSetModes?: (names: string[]) => void;
  onSelectModel?: (provider: ProviderOption) => void;
  onCycleEffort: () => void;
  onSetEffort: (effort: string) => void;
  onContext: () => void;
  onBuild: () => void;
  onOutputs: () => void;
  onToggleWorkspace: () => void;
}) {
  const [modelOpen, setModelOpen] = createSignal(false);
  let popoverRoot: HTMLDivElement | undefined;
  const dismiss = popoverDismiss(() => popoverRoot, modelOpen, () => setModelOpen(false));
  let modelSessionId: string | undefined;
  createEffect(() => { const id = props.state.guiId; if (id !== modelSessionId) setModelOpen(false); modelSessionId = id; });
  const liveModelSelection = () => Boolean(props.state.runtimeCapabilities?.operations["model.set"]);
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
      <button class="footer-status" onClick={props.onToggleWorkspace}><span class="footer-dot" classList={{ active: props.state.phase === "ready" }} />{props.state.phase}</button>
      <ModeControl state={props.state} onRefresh={props.onRequestModes} onSet={props.onSetModes} />
      <div class="footer-grow footer-project" title={props.state.projectDir}>{props.state.projectDir}</div>
      <div ref={popoverRoot} class="footer-model-control" onFocusOut={dismiss} onKeyDown={(event) => { if (event.key === "Escape") setModelOpen(false); }}>
        <button class="footer-model" aria-label="Choose model" aria-haspopup="dialog" aria-expanded={modelOpen()} onClick={() => setModelOpen((value) => !value)}>{props.state.model} ⌃</button>
        <Show when={modelOpen()}><div class="model-popover" role="dialog" aria-label={liveModelSelection() ? "Choose session model" : "Choose model for a new session"}>
          <strong>Model</strong><p>{liveModelSelection() ? "Choose the model for the next turn in this session." : "Choose a model for a new session in this directory. This session keeps its current model."}</p>
          <Show when={props.state.modelPending}><p role="status">Applying model…</p></Show>
          <Show when={props.state.modelError}><p role="alert">{props.state.modelError}</p></Show>
          <Show when={liveModelSelection() && props.state.busy}><p role="status">Available after this turn finishes.</p></Show>
          <For each={(props.providers || []).filter((provider) => provider.toolCompatible !== false)}>{(provider) => <button type="button" disabled={liveModelSelection() && (props.state.busy || Boolean(props.state.modelPending))} onClick={() => { if (!liveModelSelection()) setModelOpen(false); props.onSelectModel?.(provider); }}><strong>{provider.model}</strong><small>{provider.name}{provider.model === props.state.model ? " · current" : ""}</small></button>}</For>
          <Show when={!props.providers?.length}><button type="button" onClick={() => { setModelOpen(false); props.onBuild(); }}>View model setup</button></Show>
        </div></Show>
      </div>
      <EffortControl state={props.state} onCycle={props.onCycleEffort} onSet={props.onSetEffort} />
      <button class="footer-context" onClick={props.onContext}>context <strong>{contextLabel()}</strong></button>
      <button class="footer-outputs" onClick={props.onOutputs}>outputs <strong>{props.state.outputs.length}</strong></button>
      <div class="footer-cost" title={costDetail()}>{cost()}</div>
    </footer>
  );
}
