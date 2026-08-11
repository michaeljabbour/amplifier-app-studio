import type { SessionViewState } from "./protocol";

export interface MachinePresence {
  label: string;
  detail: string;
  tone: "ready" | "live" | "attention" | "stopped";
  live: boolean;
}

export function machinePresence(state: SessionViewState): MachinePresence {
  if (state.pendingApproval || state.pendingDecision) {
    return {
      label: "Amplifier needs you",
      detail: state.pendingApproval ? "Approval is waiting" : "A decision is waiting",
      tone: "attention",
      live: false,
    };
  }
  if (state.phase === "starting") {
    return { label: "Amplifier is starting", detail: state.bootLabel, tone: "live", live: true };
  }
  if (state.phase === "error" || state.phase === "exited" || state.phase === "closing") {
    return { label: "Amplifier is stopped", detail: state.error || state.phase, tone: "stopped", live: false };
  }

  const runningLanes = Object.values(state.lanes).filter((lane) => lane.status === "running");
  const runningTools = runningLanes.reduce(
    (count, lane) => count + lane.tools.filter((tool) => tool.status === "running").length,
    0,
  );
  if (state.autopilot || state.goal?.state === "continuing") {
    return {
      label: "Autopilot is active",
      detail: state.goal?.turn ? `Goal turn ${state.goal.turn}${state.goal.cap ? ` of ${state.goal.cap}` : ""}` : state.activity,
      tone: "live",
      live: true,
    };
  }
  if (state.busy) {
    const coordination = runningLanes.length
      ? `${runningLanes.length} agent${runningLanes.length === 1 ? "" : "s"}${runningTools ? ` · ${runningTools} operation${runningTools === 1 ? "" : "s"}` : ""}`
      : "Coordinator";
    return { label: state.activity || "Amplifier is working", detail: coordination, tone: "live", live: true };
  }
  return { label: "Amplifier is ready", detail: "Coordinator available", tone: "ready", live: false };
}
