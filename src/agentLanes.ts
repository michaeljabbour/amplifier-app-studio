import type { LaneState } from "./protocol";

const STATUS_PRIORITY: Record<LaneState["status"], number> = {
  running: 0,
  attention: 1,
  completed: 2,
};

export function orderAgentLanes(lanes: LaneState[]): LaneState[] {
  return lanes
    .map((lane, index) => ({ lane, index }))
    .sort((left, right) => STATUS_PRIORITY[left.lane.status] - STATUS_PRIORITY[right.lane.status] || left.index - right.index)
    .map(({ lane }) => lane);
}

export function liveAgentCount(lanes: LaneState[]): number {
  return lanes.filter((lane) => lane.status === "running").length;
}

export function laneLivePreview(lane: LaneState, limit = 520): { kind: "text" | "thinking"; text: string } | undefined {
  const liveTail = lane.tail.trim();
  const source = liveTail || lane.thinking.trim();
  if (!source) return undefined;
  const text = source.length > limit ? `…${source.slice(-limit)}` : source;
  return { kind: liveTail ? lane.tailKind : "thinking", text };
}
