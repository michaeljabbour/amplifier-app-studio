import { For, Show } from "solid-js";
import type { PlanItemState, PlanOwnerState, SessionViewState } from "../protocol";

interface PlanPresenceProps {
  state?: SessionViewState;
  onOpen: () => void;
}

export interface PlanCounts {
  completed: number;
  total: number;
  owners: number;
  degraded: number;
}

export function countPlanSteps(plans: Record<string, PlanOwnerState>): PlanCounts {
  const values = Object.values(plans);
  return {
    completed: values.reduce((count, plan) => count + plan.items.filter((item) => item.status === "completed").length, 0),
    total: values.reduce((count, plan) => count + plan.items.length, 0),
    owners: values.length,
    degraded: values.filter((plan) => plan.updateStatus === "degraded").length,
  };
}

export function PlanPresence(props: PlanPresenceProps) {
  const counts = () => countPlanSteps(props.state?.plans || {});
  const observedAgents = () => Object.keys(props.state?.lanes || {}).length;
  return (
    <button
      class="plan-presence"
      classList={{ degraded: counts().degraded > 0 }}
      disabled={!props.state}
      onClick={props.onOpen}
      aria-label={!props.state
        ? "Plan unavailable without an open session"
        : counts().total
          ? `Open plan: ${counts().completed} of ${counts().total} steps complete`
          : "Open plan: no published steps yet"}
      title={!props.state
        ? "Open or start a session to inspect its plan"
        : counts().degraded
          ? `${counts().degraded} plan update${counts().degraded === 1 ? "" : "s"} need attention`
          : "Show coordinator and agent plans"}
    >
      <span>Steps</span>
      <strong>{counts().total ? `${counts().completed}/${counts().total}` : "—"}</strong>
      <Show when={counts().owners > 1} fallback={
        <Show when={!counts().total}><small>{observedAgents() ? `${observedAgents()} agents worked` : "not published"}</small></Show>
      }><small>{counts().owners} plans</small></Show>
    </button>
  );
}

export function PlanPanel(props: { state: SessionViewState }) {
  const plans = () => Object.entries(props.state.plans).sort(([, left], [, right]) => {
    if (left.ownerKind !== right.ownerKind) return left.ownerKind === "coordinator" ? -1 : 1;
    return ownerLabel(props.state, left).localeCompare(ownerLabel(props.state, right));
  });
  const counts = () => countPlanSteps(props.state.plans);
  const observedLanes = () => Object.values(props.state.lanes);
  const observedTools = () => props.state.blocks.filter((block) => block.kind === "tool").length
    + observedLanes().reduce((total, lane) => total + lane.tools.length, 0);
  return (
    <section class="plan-inspector" aria-label="Session plan">
      <div class="plan-inspector-summary">
        <div><span>Published steps</span><strong>{counts().total ? `${counts().completed}/${counts().total}` : "None"}</strong></div>
        <div><span>Observed workers</span><strong>{observedLanes().length || (props.state.busy ? 1 : 0)}</strong></div>
        <div classList={{ degraded: counts().degraded > 0 }}><span>Updates needing attention</span><strong>{counts().degraded}</strong></div>
      </div>
      <Show when={plans().length} fallback={
        <div class="plan-empty">
          <strong>No explicit todo plan was published</strong>
          <p>The Amplifier runtime is connected, but this coordinator did not call <code>todo</code> or <code>update_plan</code>. Studio will not invent steps that the runtime did not record.</p>
          <Show when={observedLanes().length || observedTools()}>
            <div class="observed-work-summary">
              <span>{observedLanes().length} delegate{observedLanes().length === 1 ? "" : "s"}</span>
              <span>{observedTools()} recorded tool call{observedTools() === 1 ? "" : "s"}</span>
            </div>
            <ul class="observed-work-list">
              <For each={observedLanes()}>{(lane) => (
                <li><span class={lane.status} aria-hidden="true" /><div><strong>{lane.agent}</strong><small>{lane.activity}</small></div></li>
              )}</For>
            </ul>
          </Show>
        </div>
      }>
        <div class="plan-owner-list">
          <For each={plans()}>{([, plan]) => <OwnerPlan state={props.state} plan={plan} />}</For>
        </div>
      </Show>
    </section>
  );
}

function OwnerPlan(props: { state: SessionViewState; plan: PlanOwnerState }) {
  const completed = () => props.plan.items.filter((item) => item.status === "completed").length;
  return (
    <article class={`plan-owner-card ${props.plan.updateStatus}`}>
      <header>
        <div>
          <span>{props.plan.ownerKind === "coordinator" ? "COORDINATOR" : "AGENT PLAN"}</span>
          <strong>{ownerLabel(props.state, props.plan)}</strong>
        </div>
        <div class="plan-owner-count"><span>{statusLabel(props.plan.updateStatus)}</span><strong>{completed()}/{props.plan.items.length}</strong></div>
      </header>
      <Show when={props.plan.updateStatus === "degraded"}>
        <p class="plan-degraded-message">{props.plan.message || "This plan update failed. The proposed steps are retained for visibility."}</p>
      </Show>
      <ol class="plan-step-list">
        <For each={props.plan.items}>{(item) => <PlanStep item={item} />}</For>
      </ol>
      <code>{props.plan.ownerKind === "coordinator" ? props.plan.ownerId : `session ${props.plan.ownerId}`}</code>
    </article>
  );
}

function PlanStep(props: { item: PlanItemState }) {
  return (
    <li class={props.item.status}>
      <span aria-hidden="true">{props.item.status === "completed" ? "✓" : props.item.status === "in_progress" ? "▶" : "○"}</span>
      <div>
        <strong>{props.item.content}</strong>
        <Show when={props.item.status === "in_progress" && props.item.activeForm && props.item.activeForm !== props.item.content}>
          <small>{props.item.activeForm}</small>
        </Show>
      </div>
    </li>
  );
}

function ownerLabel(state: SessionViewState, plan: PlanOwnerState): string {
  if (plan.ownerKind === "coordinator") return "Coordinator";
  return state.lanes[plan.ownerId]?.agent || `Agent ${plan.ownerId.slice(0, 8)}`;
}

function statusLabel(status: PlanOwnerState["updateStatus"]): string {
  if (status === "applied") return "CURRENT";
  if (status === "degraded") return "UPDATE FAILED";
  return "PROPOSED";
}
