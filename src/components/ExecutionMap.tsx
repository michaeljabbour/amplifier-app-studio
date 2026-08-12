import DOMPurify from "dompurify";
import { createMemo, createResource, For, Show } from "solid-js";
import type { PipelineState, SessionViewState, TurnLoopPhase, TurnLoopState } from "../protocol";
import turnLoopSvgSource from "../assets/amplifier-turn-loop.svg?raw";

export type TurnLoopNodeStatus = "pending" | "active" | "completed" | "skipped";

interface Props {
  state: SessionViewState;
}

let vizPromise: ReturnType<typeof loadViz> | undefined;

export function ExecutionMap(props: Props) {
  const pipeline = () => props.state.pipeline;
  const graphInput = createMemo(() => {
    const current = pipeline();
    if (!current?.dotSource.trim()) return undefined;
    return {
      dot: current.dotSource,
      pipeline: current,
      signature: JSON.stringify({
        nodes: Object.values(current.nodes).map((node) => [node.id, node.status]),
        edges: Object.values(current.edges).map((edge) => [edge.id, edge.selected]),
      }),
    };
  });
  const [svg] = createResource(graphInput, async (input) => renderPipelineSvg(input.dot, input.pipeline));
  const loopSvg = createMemo(() => pipeline() ? undefined : sanitizeAndAnnotateTurnLoopSvg(turnLoopSvgSource, props.state.turnLoop));

  return (
    <div class="execution-map-panel">
      <Show when={graphInput()} fallback={<TurnLoop loop={props.state.turnLoop} svg={loopSvg()} />}>
        <div class="execution-map-heading">
          <div><span>ATTRACTOR PIPELINE</span><strong>{pipeline()?.graphName || "Pipeline"}</strong></div>
          <span class={`execution-map-state ${pipeline()?.status || "running"}`}>{pipeline()?.status || "running"}</span>
        </div>
        <Show when={pipeline()?.goal}><p class="execution-map-goal">{pipeline()?.goal}</p></Show>
        <div class="pipeline-graph" aria-label={`Execution map for ${pipeline()?.graphName || "pipeline"}`}>
          <Show when={!svg.loading} fallback={<p class="execution-map-loading">Laying out pipeline…</p>}>
            <Show when={svg()} fallback={<p class="execution-map-error">The runtime supplied a pipeline graph, but it could not be rendered.</p>}>
              <div class="pipeline-svg" innerHTML={svg() || ""} />
            </Show>
          </Show>
        </div>
        <PipelineLedger pipeline={pipeline()!} />
      </Show>
    </div>
  );
}

export function ExecutionPresence(props: { state?: SessionViewState; onOpen: () => void }) {
  const pipeline = () => props.state?.pipeline;
  const loop = () => props.state?.turnLoop;
  const active = () => pipeline()?.status === "running" || Boolean(props.state?.busy);
  return (
    <button
      class="execution-presence"
      classList={{ active: active(), failed: pipeline()?.status === "failed" }}
      disabled={!props.state}
      onClick={props.onOpen}
      title={pipeline()?.dotSource ? "Open the Attractor pipeline" : "Open the live Amplifier turn loop"}
    >
      <span>{pipeline()?.dotSource ? "PIPELINE" : "LOOP"}</span>
      <strong>{pipeline()?.dotSource ? "Attractor" : turnLoopPhaseLabel(loop()?.phase || "idle")}</strong>
      <small>{pipeline()?.dotSource
        ? `${Object.keys(pipeline()?.nodes || {}).length} observed nodes`
        : `${loop()?.modelPasses || 0} model · ${loop()?.toolCalls || 0} tools`}</small>
    </button>
  );
}

function TurnLoop(props: { loop: TurnLoopState; svg?: string }) {
  const transitions = () => props.loop.transitions.slice(-10);
  return (
    <>
      <div class="execution-map-heading">
        <div><span>AMPLIFIER TURN LOOP</span><strong>{props.loop.detail}</strong></div>
        <span class={`execution-map-state ${props.loop.phase}`}>{turnLoopPhaseLabel(props.loop.phase)}</span>
      </div>
      <p class="execution-map-guidance">This is the recorded Amplifier orchestrator cycle: the model can call tools or delegates, their results return to the model, and the loop repeats until a final response closes the turn.</p>
      <div class="turn-loop-graph" aria-label="Amplifier model and tool execution loop">
        <Show when={props.svg} fallback={<p class="execution-map-error">The Amplifier loop could not be rendered.</p>}>
          <div class="turn-loop-svg" innerHTML={props.svg || ""} />
        </Show>
      </div>
      <div class="turn-loop-stats">
        <span>{props.loop.modelPasses} model pass{props.loop.modelPasses === 1 ? "" : "es"}</span>
        <span>{props.loop.toolResults}/{props.loop.toolCalls} tool results</span>
        <span>{props.loop.completedDelegates}/{props.loop.delegates} delegates</span>
        <Show when={props.loop.toolFailures}><span class="failed">{props.loop.toolFailures} recovered failure{props.loop.toolFailures === 1 ? "" : "s"}</span></Show>
      </div>
      <Show when={transitions().length} fallback={<p class="execution-map-guidance turn-loop-empty">No turn events recorded yet.</p>}>
        <ol class="turn-loop-ledger">
          <For each={transitions()}>{(transition) => (
            <li class={transition.status}>
              <span>{turnLoopPhaseLabel(transition.phase)}</span>
              <div><strong>{transition.label}</strong><small>{transition.detail}</small></div>
            </li>
          )}</For>
        </ol>
      </Show>
    </>
  );
}

export function turnLoopNodeStatuses(loop: TurnLoopState): Record<string, TurnLoopNodeStatus> {
  const beyondPrompt = loop.phase !== "idle" && loop.phase !== "prompt";
  const modelObserved = loop.modelPasses > 0;
  const complete = loop.phase === "complete";
  return {
    prompt: loop.phase === "prompt" ? "active" : beyondPrompt ? "completed" : "pending",
    model: loop.phase === "model" ? "active" : modelObserved ? "completed" : "pending",
    tools: loop.phase === "tools" ? "active" : loop.toolCalls > 0 ? "completed" : complete ? "skipped" : "pending",
    delegates: loop.phase === "delegates" ? "active" : loop.delegates > 0 ? "completed" : complete ? "skipped" : "pending",
    response: loop.phase === "response" ? "active" : complete ? "completed" : "pending",
    complete: complete ? "active" : "pending",
  };
}

function turnLoopPhaseLabel(phase: TurnLoopPhase | "idle"): string {
  const labels: Record<TurnLoopPhase | "idle", string> = {
    idle: "Ready",
    prompt: "Prompt",
    model: "Model",
    tools: "Tools",
    delegates: "Delegates",
    response: "Response",
    complete: "Complete",
  };
  return labels[phase];
}

export async function renderTurnLoopSvg(loop: TurnLoopState): Promise<string> {
  return sanitizeAndAnnotateTurnLoopSvg(turnLoopSvgSource, loop);
}

export function sanitizeAndAnnotateTurnLoopSvg(raw: string, loop: TurnLoopState): string {
  const clean = sanitizeSvg(raw);
  const documentNode = new DOMParser().parseFromString(clean, "image/svg+xml");
  const svg = documentNode.documentElement;
  if (svg.tagName.toLowerCase() !== "svg" || documentNode.querySelector("parsererror")) return "";
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Amplifier turn loop, current state ${turnLoopPhaseLabel(loop.phase)}`);
  const statuses = turnLoopNodeStatuses(loop);
  documentNode.querySelectorAll("g.node").forEach((group) => {
    const id = group.querySelector("title")?.textContent?.trim() || "";
    group.classList.add(`loop-${statuses[id] || "pending"}`);
  });
  const activeEdge = loop.phase === "tools"
    ? "model->tools"
    : loop.phase === "delegates"
      ? "tools->delegates"
      : loop.phase === "model" && loop.modelPasses > 1
        ? "tools->model"
        : loop.phase === "model"
          ? "prompt->model"
          : loop.phase === "response"
            ? "model->response"
            : loop.phase === "complete"
              ? "response->complete"
              : "";
  documentNode.querySelectorAll("g.edge").forEach((group) => {
    if (group.querySelector("title")?.textContent?.trim() === activeEdge) group.classList.add("loop-active-edge");
  });
  return new XMLSerializer().serializeToString(svg);
}

function PipelineLedger(props: { pipeline: PipelineState }) {
  const nodes = () => Object.values(props.pipeline.nodes).sort((a, b) => a.executionIndex - b.executionIndex || a.id.localeCompare(b.id));
  return (
    <div class="pipeline-ledger">
      <div class="pipeline-ledger-summary">
        <span>{props.pipeline.totalNodesExecuted || nodes().filter((node) => node.status === "completed").length} executed</span>
        <span>{props.pipeline.declaredNodeCount || nodes().length} declared</span>
        <Show when={props.pipeline.durationMs !== undefined}><span>{formatDuration(props.pipeline.durationMs!)}</span></Show>
      </div>
      <Show when={nodes().length}>
        <ul>
          <For each={nodes()}>{(node) => (
            <li class={node.status}>
              <span aria-hidden="true" /><strong>{node.id}</strong>
              <small>{node.handlerType || node.status}{node.attempt > 1 ? ` · attempt ${node.attempt}` : ""}</small>
              <Show when={node.failureReason || node.notes}><p>{node.failureReason || node.notes}</p></Show>
            </li>
          )}</For>
        </ul>
      </Show>
    </div>
  );
}

export async function renderPipelineSvg(dot: string, pipeline: PipelineState): Promise<string> {
  try {
    vizPromise ||= loadViz();
    const viz = await vizPromise;
    const raw = viz.renderString(dot, { engine: "dot", format: "svg" });
    return sanitizeAndAnnotateSvg(raw, pipeline);
  } catch {
    return "";
  }
}

async function loadViz() {
  const { instance } = await import("@viz-js/viz");
  return instance();
}

export function sanitizeAndAnnotateSvg(raw: string, pipeline: PipelineState): string {
  const clean = sanitizeSvg(raw);
  const documentNode = new DOMParser().parseFromString(clean, "image/svg+xml");
  const svg = documentNode.documentElement;
  if (svg.tagName.toLowerCase() !== "svg" || documentNode.querySelector("parsererror")) return "";
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Execution graph for ${pipeline.graphName || "pipeline"}`);
  documentNode.querySelectorAll("g.node").forEach((group) => {
    const id = group.querySelector("title")?.textContent?.trim() || "";
    const node = pipeline.nodes[id];
    group.classList.add(`pipeline-${node?.status || "pending"}`);
  });
  documentNode.querySelectorAll("g.edge").forEach((group) => {
    const title = group.querySelector("title")?.textContent?.trim() || "";
    const selected = Object.values(pipeline.edges).some((edge) => edge.selected && title === `${edge.from}->${edge.to}`);
    if (selected) group.classList.add("pipeline-selected");
  });
  // `clean` is already DOMPurify-sanitized and the only mutations above add
  // constant classes plus inert accessibility metadata. Serializing that DOM
  // directly preserves `role`/`aria-label`, which the SVG-only profile strips
  // if it is run a second time.
  return new XMLSerializer().serializeToString(svg);
}

function sanitizeSvg(source: string): string {
  return DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "style", "foreignObject", "a", "image", "use"],
    FORBID_ATTR: ["href", "xlink:href", "style"],
  });
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}
