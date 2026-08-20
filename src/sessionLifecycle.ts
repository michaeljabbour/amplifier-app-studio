import type { SessionViewState } from "./protocol";

export type TabCloseIntent = "detach" | "confirm-stop";

export interface RuntimeStopResult {
  stopped: boolean;
  error?: string;
}

export function sessionHasLiveRuntime(session: SessionViewState): boolean {
  return session.phase !== "exited" && session.phase !== "error";
}

export function sessionCanDetachSafely(session: SessionViewState): boolean {
  return Boolean(
    session.runtimeSessionId
    || session.resumeId
    || session.hostUrl
    || (session.hostId && session.hostId !== "local"),
  );
}

export function ordinaryTabCloseIntent(session: SessionViewState): TabCloseIntent {
  if (!sessionHasLiveRuntime(session) || sessionCanDetachSafely(session)) return "detach";
  return "confirm-stop";
}

export function adjacentTabIndex(key: string, current: number, count: number): number | undefined {
  if (count < 1) return undefined;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

export async function attemptRuntimeStop(stop: () => Promise<boolean>): Promise<RuntimeStopResult> {
  try {
    const stopped = await stop();
    return stopped
      ? { stopped: true }
      : { stopped: false, error: "The runtime reported that it is still running" };
  } catch (error) {
    return { stopped: false, error: String(error).replace(/^Error:\s*/, "") };
  }
}

export function stopRuntimeActivity(session: SessionViewState): {
  label: string;
  detail: string;
  tone: "idle" | "active" | "connecting";
} {
  if (session.busy) {
    return {
      label: "Active turn in progress",
      detail: "Stopping now interrupts the coordinator and any running child agents.",
      tone: "active",
    };
  }
  if (session.phase === "starting" || session.phase === "degraded") {
    return {
      label: "Runtime is connecting",
      detail: "Stopping now cancels startup or restoration before it completes.",
      tone: "connecting",
    };
  }
  return {
    label: "Runtime is idle",
    detail: "No turn is active. Durable conversation history remains available after the runtime stops.",
    tone: "idle",
  };
}
