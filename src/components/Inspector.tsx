import { createMemo, createSignal, For, Show } from "solid-js";
import { isLaneHistorical, liveAgentCount, orderAgentLanes } from "../agentLanes";
import type { BundleOption, LaneState, ProviderOption, SessionViewState } from "../protocol";
import { Markdown } from "./Markdown";
import { PlanPanel } from "./Plan";
import { ExecutionMap } from "./ExecutionMap";
import { formatSessionCost } from "../costEstimate";

export type InspectorTab = "run" | "map" | "plan" | "agent" | "build" | "bundles" | "outputs" | "context";

interface Props {
  state: SessionViewState;
  lane?: LaneState;
  tab: InspectorTab;
  transport: string;
  bundles: BundleOption[];
  providers: ProviderOption[];
  onTab: (tab: InspectorTab) => void;
  onSelectLane: (id: string) => void;
  onDismissAlert: (id: string) => void;
  onCycleEffort: () => void;
  onStartSibling: (bundle?: string, provider?: ProviderOption) => void;
  onAddBundle: (uri: string, name?: string) => Promise<void>;
  onRefreshBundles: () => Promise<void>;
  onCapabilities: () => void;
  onRequestContext: () => void;
  onOpenOutput?: (path: string) => Promise<void>;
}

export function Inspector(props: Props) {
  return (
    <aside class="machine-inspector" aria-label="Session inspector">
      <div class="inspector-heading">
        <div><span>SESSION INSPECTOR</span><strong>{props.lane && props.tab === "agent" ? props.lane.agent : props.state.title}</strong></div>
      </div>
      <nav class="inspector-tabs" aria-label="Inspector views">
        <button classList={{ active: props.tab === "run" }} onClick={() => props.onTab("run")}>Run</button>
        <button classList={{ active: props.tab === "map" }} onClick={() => props.onTab("map")}>Map</button>
        <button classList={{ active: props.tab === "plan" }} onClick={() => props.onTab("plan")}>Plan</button>
        <Show when={props.lane}><button classList={{ active: props.tab === "agent" }} onClick={() => props.onTab("agent")}>Agent</button></Show>
        <button classList={{ active: props.tab === "build" }} onClick={() => props.onTab("build")}>Setup</button>
        <button classList={{ active: props.tab === "bundles" }} onClick={() => props.onTab("bundles")}>Bundles</button>
        <button classList={{ active: props.tab === "outputs" }} onClick={() => props.onTab("outputs")}>Outputs</button>
        <button classList={{ active: props.tab === "context" }} onClick={() => props.onTab("context")}>Context</button>
      </nav>
      <div class="inspector-body">
        <Show when={props.tab === "run"}><RunPanel {...props} /></Show>
        <Show when={props.tab === "map"}><ExecutionMap state={props.state} /></Show>
        <Show when={props.tab === "plan"}><PlanPanel state={props.state} /></Show>
        <Show when={props.tab === "agent" && props.lane}><AgentPanel lane={props.lane!} /></Show>
        <Show when={props.tab === "build"}><BuildPanel {...props} /></Show>
        <Show when={props.tab === "bundles"}><BundlesPanel {...props} /></Show>
        <Show when={props.tab === "outputs"}><OutputsPanel state={props.state} onOpenOutput={props.onOpenOutput} /></Show>
        <Show when={props.tab === "context"}><ContextPanel {...props} /></Show>
      </div>
    </aside>
  );
}

function RunPanel(props: Props) {
  const lanes = () => orderAgentLanes(Object.values(props.state.lanes));
  const liveCount = () => liveAgentCount(lanes());
  const complete = () => props.state.blocks.some((block) => block.kind === "answer" && block.final);
  const detached = () => lanes().filter((lane) => lane.status === "detached").length;
  return (
    <>
      <InspectorSection title="Progress" meta={props.state.busy ? "LIVE" : props.state.phase.toUpperCase()}>
        <div class="progress-list">
          <ProgressRow label="Runtime prepared" status={props.state.phase === "starting" ? "live" : "done"} detail={props.state.bundle} />
          <ProgressRow label="Coordinator" status={props.state.busy ? "live" : complete() ? "done" : "next"} detail={props.state.activity} />
          <ProgressRow label="This session's agents" status={liveCount() > 0 ? "live" : lanes().length && !detached() ? "done" : "next"} detail={lanes().length ? `${liveCount()} live · ${lanes().length} total workspace${lanes().length === 1 ? "" : "s"}${detached() ? ` · ${detached()} completion unknown` : ""}` : "Created only when useful"} />
          <ProgressRow label="Final response" status={complete() ? "done" : "next"} detail={complete() ? "Returned to session" : "Waiting on the run"} />
        </div>
      </InspectorSection>

      <Show when={props.state.goal} keyed>{(goal) => (
        <InspectorSection title="Autonomous goal" meta={goal.state.toUpperCase()}>
          <div class={`goal-progress-card ${goal.state}`}>
            <Show when={goal.condition}>
              <Markdown compact class="goal-progress-copy" text={goal.condition || ""} />
            </Show>
            <div class="goal-progress-head">
              <strong>Turn {goal.turn}{goal.cap ? ` of ${goal.cap}` : ""}</strong>
              <span>{goal.continuations} continuation{goal.continuations === 1 ? "" : "s"}</span>
            </div>
            <Show when={goal.cap}>
              <div class="goal-progress-meter"><span style={{ width: `${Math.min(100, (goal.turn / (goal.cap || 1)) * 100)}%` }} /></div>
            </Show>
            <Show when={goal.summary || goal.reason}>
              <Markdown compact class="goal-progress-copy" text={goal.summary || goal.reason || ""} />
            </Show>
            <Show when={goal.stallDetail}><Markdown compact class="goal-stall-detail" text={goal.stallDetail || ""} /></Show>
          </div>
        </InspectorSection>
      )}</Show>

      <Show when={props.state.alerts.length > 0}>
        <InspectorSection title="Setup notices" meta={String(props.state.alerts.length)}>
          <For each={props.state.alerts}>{(alert) => (
            <div class={`inspector-alert ${alert.level}`}>
              <strong>{alert.title}</strong><Markdown compact text={alert.message} />
              <button onClick={() => props.onDismissAlert(alert.id)}>Dismiss</button>
            </div>
          )}</For>
        </InspectorSection>
      </Show>

      <InspectorSection title="This session's agents" meta={liveCount() > 0 ? `${liveCount()} LIVE · ${lanes().length} TOTAL` : `${lanes().length} TOTAL`}>
        <Show when={lanes().length} fallback={<p class="inspector-empty">The coordinator has not created a delegate workspace yet.</p>}>
          <div class="inspector-agent-list">
            <For each={lanes()}>{(lane) => (
              <button onClick={() => props.onSelectLane(lane.id)}>
                <span class={`mini-state ${lane.status}`}>{lane.status}</span>
                <strong>{lane.agent}</strong><Markdown compact class="agent-list-summary" text={lane.activity} />
              </button>
            )}</For>
          </div>
        </Show>
      </InspectorSection>
    </>
  );
}

function AgentPanel(props: { lane: LaneState }) {
  const historical = () => isLaneHistorical(props.lane);
  return (
    <>
      <div class={`agent-inspector-hero ${props.lane.status}`}>
        <span>{props.lane.status}</span><h2>{props.lane.agent}</h2><Markdown compact class="agent-hero-summary" text={props.lane.activity} />
        <code>{props.lane.id}</code>
      </div>
      <Show when={props.lane.instruction} keyed>{(instruction) => (
        <InspectorSection title="Requested work" meta="DELEGATED BRIEF">
          <Markdown class="agent-instruction" text={instruction} />
        </InspectorSection>
      )}</Show>
      <Show when={props.lane.model || props.lane.startedAtMs !== undefined || props.lane.completedAtMs !== undefined || props.lane.costUsd}>
        <InspectorSection title="Run facts" meta={historical() ? "HISTORICAL" : "CURRENT"}>
          <dl class="agent-run-facts">
            <Show when={props.lane.model}><div><dt>Model / role</dt><dd>{props.lane.model}</dd></div></Show>
            <Show when={props.lane.startedAtMs !== undefined}><div><dt>Started</dt><dd>{formatTimestamp(props.lane.startedAtMs!)}</dd></div></Show>
            <Show when={props.lane.completedAtMs !== undefined}><div><dt>Completed</dt><dd>{formatTimestamp(props.lane.completedAtMs!)}</dd></div></Show>
            <Show when={props.lane.costUsd}><div><dt>Attributed cost</dt><dd>{formatSessionCost(props.lane.costUsd || "0", props.lane.costBasis || "reported")}</dd></div></Show>
          </dl>
        </InspectorSection>
      </Show>
      <Show when={props.lane.tail}>
        <InspectorSection title={props.lane.tailKind === "thinking" ? historical() ? "Recorded reasoning" : "Live reasoning" : historical() ? "Recorded response" : "Live response"} meta={historical() ? "HISTORICAL" : "LIVE"}>
          <Markdown class={`agent-live-copy ${props.lane.tailKind}`} text={props.lane.tail} />
        </InspectorSection>
      </Show>
      <InspectorSection title="Timeline" meta={`${historical() ? "HISTORICAL" : "LIVE"} · ${props.lane.events.length}`}>
        <div class="agent-timeline">
          <For each={[...props.lane.events].reverse()}>{(event) => (
            <details open={event.status === "running"}>
              <summary><span class={event.status || event.kind}>{event.status || event.kind}</span><strong>{event.title}</strong></summary>
              <Show when={event.kind !== "tool"} fallback={<pre>{event.detail}</pre>}>
                <Markdown class="agent-event-markdown" text={event.detail} />
              </Show>
            </details>
          )}</For>
        </div>
      </InspectorSection>
    </>
  );
}

function BuildPanel(props: Props) {
  const activeProvider = () => props.providers.find((provider) => provider.model === props.state.model)
    || props.providers.find((provider) => provider.active);
  const safeProviders = () => props.providers.filter((provider) => provider.toolCompatible);
  const experimentalProviders = () => props.providers.filter((provider) => !provider.toolCompatible);
  return (
    <>
      <InspectorSection title="Active composition" meta="PINNED FOR TURN">
        <dl class="composition-grid">
          <div><dt>Bundle</dt><dd>{props.state.bundle}</dd></div>
          <div><dt>Mode</dt><dd>{props.state.mode}</dd></div>
          <div><dt>Model</dt><dd>{props.state.model}</dd></div>
          <div><dt>Provider</dt><dd>{activeProvider()?.name || "runtime selected"}</dd></div>
          <div><dt>Effort</dt><dd>{props.state.effort || "default"}</dd></div>
          <div class="wide"><dt>Execution</dt><dd>{props.transport}</dd></div>
        </dl>
        <div class="inspector-actions">
          <button class="primary-button" onClick={props.onCapabilities}>Browse capabilities</button>
          <button class="primary-button" onClick={() => props.onStartSibling()}>Start new session with this setup</button>
          <button class="secondary-button" onClick={props.onCycleEffort}>Cycle effort now</button>
        </div>
        <p class="inspector-guidance">Compare another provider, model, mode, or bundle in a parallel tab without stopping this runtime.</p>
      </InspectorSection>
      <InspectorSection title="Tool-compatible providers" meta={String(safeProviders().length)}>
        <Show when={safeProviders().length} fallback={<p class="inspector-empty">No tool-compatible provider routes were discovered.</p>}>
          <div class="bundle-list provider-list">
            <For each={safeProviders()}>{(provider) => <button onClick={() => props.onStartSibling(undefined, provider)}><strong>{provider.name}</strong><span>Start new session with {provider.model || provider.module}</span></button>}</For>
          </div>
        </Show>
      </InspectorSection>
      <Show when={experimentalProviders().length}>
        <InspectorSection title="Gateway experiments" meta="NOT FOR AGENT TOOLS">
          <div class="provider-experiment-list">
            <For each={experimentalProviders()}>{(provider) => <div><strong>{provider.name}</strong><span>{provider.model}</span><p>{provider.warning}</p></div>}</For>
          </div>
        </InspectorSection>
      </Show>
    </>
  );
}

function BundlesPanel(props: Props) {
  const [query, setQuery] = createSignal("");
  const [uri, setUri] = createSignal("");
  const [name, setName] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [message, setMessage] = createSignal<{ tone: "success" | "error"; text: string }>();
  const visible = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return [...props.bundles]
      .filter((bundle) => !needle || `${bundle.name} ${bundle.location} ${bundle.status}`.toLowerCase().includes(needle))
      .sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
  });

  const register = async () => {
    if (!uri().trim() || adding()) return;
    setAdding(true);
    setMessage(undefined);
    try {
      await props.onAddBundle(uri(), name().trim() || undefined);
      setMessage({ tone: "success", text: "Registered. Start a new parallel session to use this composition." });
      setUri("");
      setName("");
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <InspectorSection title="Amplifier catalog" meta={String(props.bundles.length)}>
        <p class="inspector-guidance">Discovered from Amplifier's own bundle registry—the same composition source backed by its module catalog. Starting one opens an independent parallel runtime.</p>
        <div class="bundle-catalog-controls">
          <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Filter bundles…" aria-label="Filter available bundles" />
          <button class="secondary-button" onClick={() => void props.onRefreshBundles()}>Refresh</button>
        </div>
        <Show when={visible().length} fallback={<p class="inspector-empty">No bundles match this filter.</p>}>
          <div class="bundle-list bundle-catalog-list">
            <For each={visible()}>{(bundle) => (
              <button onClick={() => props.onStartSibling(bundle.name)} title={bundle.location}>
                <span class="bundle-copy"><strong>{bundle.name}</strong><small>Start new session with this bundle</small></span>
                <span classList={{ active: bundle.active }}>{bundle.active ? "Active" : bundle.status || "Available"}</span>
              </button>
            )}</For>
          </div>
        </Show>
      </InspectorSection>
      <InspectorSection title="Add from GitHub" meta="FOR NEW SESSIONS">
        <p class="inspector-guidance">Register a trusted Amplifier bundle by repository URL. The runtime validates it; it is not injected into the current turn.</p>
        <form class="bundle-add-form" onSubmit={(event) => { event.preventDefault(); void register(); }}>
          <label><span>GitHub repository</span><input value={uri()} onInput={(event) => setUri(event.currentTarget.value)} placeholder="https://github.com/org/amplifier-bundle-name" required /></label>
          <label><span>Catalog name <small>optional</small></span><input value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder="my-bundle" /></label>
          <button class="primary-button" disabled={adding() || !uri().trim()}>{adding() ? "Validating…" : "Validate and add"}</button>
        </form>
        <Show when={message()} keyed>{(result) => <p class={`bundle-add-result ${result.tone}`}>{result.text}</p>}</Show>
      </InspectorSection>
    </>
  );
}

function OutputsPanel(props: { state: SessionViewState; onOpenOutput?: (path: string) => Promise<void> }) {
  return (
    <InspectorSection title="Turn outputs" meta={String(props.state.outputs.length)}>
      <Show when={props.state.outputs.length} fallback={
        <div class="outputs-empty"><strong>Outputs from this run</strong><p>Generated images, diagrams, datasets, and files will appear here when tools return concrete output paths.</p></div>
      }>
        <div class="output-list">
          <For each={[...props.state.outputs].reverse()}>{(output) => (
            <div class={`output-item ${output.kind}`}>
              <div class="output-item-copy">
                <div class="output-item-heading"><span>{output.kind}</span><strong>{output.title}</strong></div>
                <code title={output.path}>{output.path}</code>
                <small>{outputProvenance(output)}</small>
              </div>
              <Show when={props.onOpenOutput}>
                <button class="secondary-button output-open-button" onClick={() => void props.onOpenOutput?.(output.path)}>Open</button>
              </Show>
            </div>
          )}</For>
        </div>
      </Show>
    </InspectorSection>
  );
}

function ContextPanel(props: Props) {
  const tokens = () => props.state.context.tokens.toLocaleString();
  const window = () => props.state.context.window.toLocaleString();
  const cost = () => formatSessionCost(props.state.context.costUsd, props.state.context.costBasis);
  const usage = () => props.state.context.inputTokens + props.state.context.outputTokens;
  return (
    <>
      <InspectorSection title="Context window" meta={`${Math.round(props.state.context.percent)}%`}>
        <div class="context-meter"><span style={{ width: `${Math.min(100, props.state.context.percent)}%` }} /></div>
        <div class="context-numbers"><strong>{tokens()}</strong><span>of {window() || "unknown"} tokens</span></div>
        <button class="secondary-button inspector-refresh" onClick={props.onRequestContext}>Refresh context</button>
      </InspectorSection>
      <InspectorSection title="Session identity">
        <dl class="context-facts">
          <div><dt>Runtime session</dt><dd>{props.state.runtimeSessionId || "Starting"}</dd></div>
          <div><dt>Project</dt><dd>{props.state.projectDir}</dd></div>
          <div><dt>Cost</dt><dd>{cost()}</dd></div>
          <div><dt>Session input</dt><dd>{props.state.context.inputTokens.toLocaleString()} tokens</dd></div>
          <div><dt>Session output</dt><dd>{props.state.context.outputTokens.toLocaleString()} tokens</dd></div>
        </dl>
        <Show when={props.state.context.costBasis === "estimated"}>
          <p class="inspector-empty">
            Estimated from {usage().toLocaleString()} blended tokens using the $600k annual RunPod allocation
            {props.state.context.estimateRatePerMillion === undefined ? "" : ` at $${props.state.context.estimateRatePerMillion}/1M`}.
            This is infrastructure allocation, not provider-reported request spend.
          </p>
        </Show>
        <Show when={props.state.context.costBasis === "partial" || props.state.context.costBasis === "mixed"}>
          <p class="inspector-empty">
            This total mixes priced and unpriced usage. {props.state.context.unpricedTokens.toLocaleString()} tokens could not be assigned a rate.
          </p>
        </Show>
      </InspectorSection>
      <Show when={props.state.logs.length}>
        <InspectorSection title="Process log" meta={String(props.state.logs.length)}>
          <details class="process-log"><summary>Show recent bridge output</summary><pre>{props.state.logs.slice(-30).join("\n")}</pre></details>
        </InspectorSection>
      </Show>
    </>
  );
}

function InspectorSection(props: { title: string; meta?: string; children: unknown }) {
  return <section class="inspector-section"><div class="inspector-section-title"><h3>{props.title}</h3><span>{props.meta}</span></div>{props.children as never}</section>;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function outputProvenance(output: SessionViewState["outputs"][number]): string {
  return [
    output.source ? `via ${output.source}` : undefined,
    output.laneId ? `agent ${output.laneId}` : undefined,
    output.toolCallId ? `call ${output.toolCallId}` : undefined,
    output.eventId ? `event ${output.eventId}` : undefined,
    output.runtimeHost ? `host ${output.runtimeHost}` : undefined,
  ].filter(Boolean).join(" · ");
}

function ProgressRow(props: { label: string; detail: string; status: "done" | "live" | "next" }) {
  return <div class={`progress-row ${props.status}`}><span>{props.status === "done" ? "Done" : props.status === "live" ? "Live" : "Next"}</span><div><strong>{props.label}</strong><small>{props.detail}</small></div></div>;
}
