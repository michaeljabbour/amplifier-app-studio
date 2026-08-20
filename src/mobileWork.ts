import type { SessionViewState } from "./protocol";

export interface WorkAttentionItem {
  sessionId: string;
  sessionTitle: string;
  name: string;
}

export function workAttentionItems(state: SessionViewState): WorkAttentionItem[] {
  const items: WorkAttentionItem[] = [];
  if (state.pendingApproval) {
    items.push({ sessionId: state.guiId, sessionTitle: state.title, name: state.pendingApproval.prompt });
  }
  if (state.pendingDecision) {
    items.push({ sessionId: state.guiId, sessionTitle: state.title, name: state.pendingDecision.question });
  }
  for (const lane of Object.values(state.lanes)) {
    if (lane.status === "attention") {
      items.push({
        sessionId: state.guiId,
        sessionTitle: state.title,
        name: lane.activity ? `${lane.agent} · ${lane.activity}` : lane.agent,
      });
    }
  }
  return items;
}

export function workAttentionSummary(states: SessionViewState[]): {
  count: number;
  name?: string;
  sessionId?: string;
  sessionTitle?: string;
} {
  const items = states.flatMap(workAttentionItems);
  return {
    count: items.length,
    name: items[0]?.name,
    sessionId: items[0]?.sessionId,
    sessionTitle: items[0]?.sessionTitle,
  };
}

export function sessionPlacement(state: SessionViewState): { host: string; project: string } {
  return {
    host: state.hostName?.trim() || (state.hostId === "local" || !state.hostId ? "This computer" : "Connected compute"),
    project: state.projectDir.trim() || "Project not set",
  };
}
