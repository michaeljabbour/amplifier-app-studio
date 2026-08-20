import type { SessionViewState, StoredSession } from "./protocol";

/** Return the already-open Studio tab for a durable runtime session, if any. */
export function openGuiIdForStoredSession(
  openSessions: SessionViewState[],
  storedSessionId: string,
  origin?: Pick<StoredSession, "hostId" | "hostUrl">,
): string | undefined {
  return openSessions.find((session) => {
    if (session.phase === "error" || session.phase === "exited") return false;
    const durableIdMatches = session.runtimeSessionId === storedSessionId || session.resumeId === storedSessionId;
    if (!durableIdMatches || (!origin?.hostId && !origin?.hostUrl)) return durableIdMatches;
    if (origin.hostId && session.hostId === origin.hostId) return true;
    const originUrl = normalizedHostUrl(origin.hostUrl);
    return Boolean(originUrl && normalizedHostUrl(session.hostUrl) === originUrl);
  })?.guiId;
}

/** Describe actual runtime state rather than counting diagnostic tabs as live
 * parallel sessions. */
export function parallelSessionSummary(sessions: Pick<SessionViewState, "phase">[]): string {
  const stopped = sessions.filter((session) => session.phase === "exited" || session.phase === "error").length;
  const active = sessions.length - stopped;
  if (!stopped) return `${active} ACTIVE`;
  if (!active) return `${stopped} STOPPED`;
  return `${active} ACTIVE · ${stopped} STOPPED`;
}

function normalizedHostUrl(value?: string): string {
  return value?.trim().replace(/\/$/, "") || "";
}
