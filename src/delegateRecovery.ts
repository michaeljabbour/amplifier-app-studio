import type { LaneState, SessionViewState } from "./protocol";

/** A coordinator instruction is offered only in the child's confirmed parent session. */
export function delegateRecoveryInstruction(state: SessionViewState, lane: LaneState): string | undefined {
  if (lane.status !== "incomplete" || !lane.id || !state.runtimeSessionId
    || lane.parentId !== state.runtimeSessionId
    || !state.runtimeCapabilities?.features.includes("delegates.resume")) return undefined;
  return `In this parent session (${state.runtimeSessionId}), inspect the retained work for delegate ${lane.id}. If it is resumable, resume it and continue its unfinished work while preserving its original instructions and routing.`;
}
