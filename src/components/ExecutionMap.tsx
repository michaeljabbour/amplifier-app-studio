import DOMPurify from "dompurify";
import { createMemo, createResource, For, Show } from "solid-js";
import type { PipelineState, SessionViewState, ToolBlock } from "../protocol";

export type ObservedStageStatus = "not_observed" | "pending" | "running" | "completed" | "failed";

export interface ObservedExecutionStage {
  id: "prompt" | "plan" | "agents_tools" | "verify" | "respond";
  label: string;
  status: ObservedStageStatus;
  detail: string;
}

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
  const stages = createMemo(() => observedExecutionStages(props.state));

  return (
    <div class="execution-map-panel">
      <Show when={graphInput()} fallback={<GenericExecutionLoop stages={stages()} />}>
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
  const active = () => pipeline()?.status === "running" || Boolean(props.state?.busy);
  return (
    <button
      class="execution-presence"
      classList={{ active: active(), failed: pipeline()?.status === "failed" }}
      disabled={!props.state}
      onClick={props.onOpen}
      title="Open the observed execution map"
    >
      <span>MAP</span>
      <strong>{pipeline()?.dotSource ? "Pipeline" : active() ? "Live" : "Flow"}</strong>
      <small>{pipeline()?.dotSource ? `${Object.keys(pipeline()?.nodes || {}).length} observed nodes` : "Observed stages"}</small>
    </button>
  );
}

function GenericExecutionLoop(props: { stages: ObservedExecutionStage[] }) {
  return (
    <>
      <div class="execution-map-heading">
        <div><span>GENERIC EXECUTION LOOP</span><strong>Observed session activity</strong></div>
        <span class="execution-map-state observed">evidence only</span>
      </div>
      <p class="execution-map-guidance">This is a transparent activity summary, not a claim about Amplifier's hidden workflow. Stages change only when matching runtime evidence appears.</p>
      <ol class="generic-execution-flow">
        <For each={props.stages}>{(stage, index) => (
          <li class={stage.status}>
            <span class="flow-node-state" aria-hidden="true" />
            <div><small>{String(index() + 1).padStart(2, "0")}</small><strong>{stage.label}</strong><p>{stage.detail}</p></div>
          </li>
        )}</For>
      </ol>
      <div class="execution-loop-return" aria-label="A response can begin another prompt">respond → prompt</div>
    </>
  );
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

export function observedExecutionStages(state: SessionViewState): ObservedExecutionStage[] {
  const userSeen = state.blocks.some((block) => block.kind === "user");
  const answerSeen = state.blocks.some((block) => block.kind === "answer" && block.final);
  const plans = Object.values(state.plans);
  const planItems = plans.flatMap((plan) => plan.items);
  const tools = state.blocks.filter((block): block is ToolBlock => block.kind === "tool");
  const lanes = Object.values(state.lanes);
  const workSeen = tools.length > 0 || lanes.length > 0;
  const workFailed = tools.some((tool) => tool.status === "failed") || lanes.some((lane) => lane.status === "attention");
  const workRunning = tools.some((tool) => tool.status === "running") || lanes.some((lane) => lane.status === "running");
  const verification = tools.filter((tool) => /\b(test|pytest|cargo check|npm run build|lint|verify|validate|typecheck)\b/i.test(`${tool.toolName} ${tool.summary}`));
  const verificationFailed = verification.some((tool) => tool.status === "failed");
  const verificationRunning = verification.some((tool) => tool.status === "running");
  const planFailed = plans.some((plan) => plan.updateStatus === "degraded");
  const planRunning = planItems.some((item) => item.status === "in_progress") || plans.some((plan) => plan.updateStatus === "pending");

  return [
    {
      id: "prompt",
      label: "Prompt",
      status: state.pendingPrompt ? "running" : userSeen ? "completed" : "pending",
      detail: state.pendingPrompt ? "Waiting for the runtime to accept the prompt" : userSeen ? "Prompt recorded" : "No prompt observed",
    },
    {
      id: "plan",
      label: "Plan",
      status: !plans.length ? "not_observed" : planFailed ? "failed" : planRunning ? "running" : "completed",
      detail: !plans.length ? "No structured plan event observed" : `${planItems.filter((item) => item.status === "completed").length}/${planItems.length} recorded steps complete`,
    },
    {
      id: "agents_tools",
      label: "Agents / tools",
      status: !workSeen ? "not_observed" : workFailed ? "failed" : workRunning ? "running" : "completed",
      detail: !workSeen ? "No agent or tool activity observed" : `${lanes.length} agent workspace${lanes.length === 1 ? "" : "s"} · ${tools.length} tool call${tools.length === 1 ? "" : "s"}`,
    },
    {
      id: "verify",
      label: "Verify",
      status: !verification.length ? "not_observed" : verificationFailed ? "failed" : verificationRunning ? "running" : "completed",
      detail: !verification.length ? "No explicit verification activity observed" : `${verification.length} verification action${verification.length === 1 ? "" : "s"} observed`,
    },
    {
      id: "respond",
      label: "Respond",
      status: answerSeen ? "completed" : state.liveTail ? "running" : state.busy ? "pending" : "not_observed",
      detail: answerSeen ? "Final response recorded" : state.liveTail ? "Response is streaming" : state.busy ? "Waiting for a response" : "No final response observed",
    },
  ];
}

export async function renderPipelineSvg(dot: string, pipeline: PipelineState): Promise<string> {
  try {
    vizPromise ||= loadViz();
    const viz = await vizPromise;
    const raw = viz.renderSVGElement(dot, { engine: "dot" }).outerHTML;
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
