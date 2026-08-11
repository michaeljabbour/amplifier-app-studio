import { For, Show } from "solid-js";
import type { LaneState, ProviderOption, SessionViewState } from "../protocol";
import { Markdown } from "./Markdown";

export type InspectorTab = "run" | "agent" | "build" | "outputs" | "context";

interface Props {
  state: SessionViewState;
  lane?: LaneState;
  tab: InspectorTab;
  transport: string;
  recentBundles: string[];
  providers: ProviderOption[];
  onTab: (tab: InspectorTab) => void;
  onSelectLane: (id: string) => void;
  onDismissAlert: (id: string) => void;
  onCycleEffort: () => void;
  onStartSibling: (bundle?: string, provider?: ProviderOption) => void;
  onRequestContext: () => void;
}

export function Inspector(props: Props) {
  return (
    <aside class="machine-inspector" aria-label="Machine inspector">
      <div class="inspector-heading">
        <div><span>MACHINE INSPECTOR</span><strong>{props.lane && props.tab === "agent" ? props.lane.agent : props.state.title}</strong></div>
      </div>
      <nav class="inspector-tabs" aria-label="Inspector views">
        <button classList={{ active: props.tab === "run" }} onClick={() => props.onTab("run")}>Run</button>
        <Show when={props.lane}><button classList={{ active: props.tab === "agent" }} onClick={() => props.onTab("agent")}>Agent</button></Show>
        <button classList={{ active: props.tab === "build" }} onClick={() => props.onTab("build")}>Build</button>
        <button classList={{ active: props.tab === "outputs" }} onClick={() => props.onTab("outputs")}>Outputs</button>
        <button classList={{ active: props.tab === "context" }} onClick={() => props.onTab("context")}>Context</button>
      </nav>
      <div class="inspector-body">
        <Show when={props.tab === "run"}><RunPanel {...props} /></Show>
        <Show when={props.tab === "agent" && props.lane}><AgentPanel lane={props.lane!} /></Show>
        <Show when={props.tab === "build"}><BuildPanel {...props} /></Show>
        <Show when={props.tab === "outputs"}><OutputsPanel state={props.state} /></Show>
        <Show when={props.tab === "context"}><ContextPanel {...props} /></Show>
      </div>
    </aside>
  );
}

function RunPanel(props: Props) {
  const lanes = () => Object.values(props.state.lanes);
  const complete = () => props.state.blocks.some((block) => block.kind === "answer" && block.final);
  return (
    <>
      <InspectorSection title="Progress" meta={props.state.busy ? "LIVE" : props.state.phase.toUpperCase()}>
        <div class="progress-list">
          <ProgressRow label="Runtime prepared" status={props.state.phase === "starting" ? "live" : "done"} detail={props.state.bundle} />
          <ProgressRow label="Coordinator" status={props.state.busy ? "live" : complete() ? "done" : "next"} detail={props.state.activity} />
          <ProgressRow label="Agent workspaces" status={lanes().some((lane) => lane.status === "running") ? "live" : lanes().length ? "done" : "next"} detail={lanes().length ? `${lanes().length} created` : "Created only when useful"} />
          <ProgressRow label="Final response" status={complete() ? "done" : "next"} detail={complete() ? "Returned to session" : "Waiting on the machine"} />
        </div>
      </InspectorSection>

      <Show when={props.state.goal} keyed>{(goal) => (
        <InspectorSection title="Autonomous goal" meta={goal.state.toUpperCase()}>
          <div class={`goal-progress-card ${goal.state}`}>
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

      <InspectorSection title="Agent workspaces" meta={String(lanes().length)}>
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
  return (
    <>
      <div class={`agent-inspector-hero ${props.lane.status}`}>
        <span>{props.lane.status}</span><h2>{props.lane.agent}</h2><Markdown compact class="agent-hero-summary" text={props.lane.activity} />
        <code>{props.lane.id}</code>
      </div>
      <Show when={props.lane.tail}>
        <InspectorSection title={props.lane.tailKind === "thinking" ? "Live reasoning" : "Live response"} meta="LIVE">
          <Markdown class={`agent-live-copy ${props.lane.tailKind}`} text={props.lane.tail} />
        </InspectorSection>
      </Show>
      <InspectorSection title="Timeline" meta={String(props.lane.events.length)}>
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
          <button class="primary-button" onClick={() => props.onStartSibling()}>Start configured sibling</button>
          <button class="secondary-button" onClick={props.onCycleEffort}>Cycle effort now</button>
        </div>
        <p class="inspector-guidance">Compare another provider, model, mode, or bundle in a parallel tab without stopping this runtime.</p>
      </InspectorSection>
      <InspectorSection title="Available bundles" meta={String(props.recentBundles.length)}>
        <Show when={props.recentBundles.length} fallback={<p class="inspector-empty">Open stored sessions to discover previously used bundles.</p>}>
          <div class="bundle-list">
            <For each={props.recentBundles}>{(bundle) => <button onClick={() => props.onStartSibling(bundle)}><strong>{bundle}</strong><span>Start in new tab</span></button>}</For>
          </div>
        </Show>
      </InspectorSection>
      <InspectorSection title="Providers" meta={String(props.providers.length)}>
        <Show when={props.providers.length} fallback={<p class="inspector-empty">No provider routes were discovered.</p>}>
          <div class="bundle-list provider-list">
            <For each={props.providers}>{(provider) => <button onClick={() => props.onStartSibling(undefined, provider)}><strong>{provider.name}</strong><span>{provider.model || provider.module}</span></button>}</For>
          </div>
        </Show>
      </InspectorSection>
    </>
  );
}

function OutputsPanel(props: { state: SessionViewState }) {
  return (
    <InspectorSection title="Turn outputs" meta={String(props.state.outputs.length)}>
      <Show when={props.state.outputs.length} fallback={
        <div class="outputs-empty"><strong>A place for what the machine makes</strong><p>Generated images, diagrams, datasets, and files will appear here when tools return concrete output paths.</p></div>
      }>
        <div class="output-list">
          <For each={[...props.state.outputs].reverse()}>{(output) => (
            <div class={`output-item ${output.kind}`}><span>{output.kind}</span><strong>{output.title}</strong><code>{output.path}</code><small>via {output.source}</small></div>
          )}</For>
        </div>
      </Show>
    </InspectorSection>
  );
}

function ContextPanel(props: Props) {
  const tokens = () => props.state.context.tokens.toLocaleString();
  const window = () => props.state.context.window.toLocaleString();
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
          <div><dt>Cost</dt><dd>${Number(props.state.context.costUsd || 0).toFixed(4)}</dd></div>
        </dl>
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

function ProgressRow(props: { label: string; detail: string; status: "done" | "live" | "next" }) {
  return <div class={`progress-row ${props.status}`}><span>{props.status === "done" ? "Done" : props.status === "live" ? "Live" : "Next"}</span><div><strong>{props.label}</strong><small>{props.detail}</small></div></div>;
}
