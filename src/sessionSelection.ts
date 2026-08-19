import type { SessionViewState, StoredSession } from "./protocol";

/** Return the already-open Studio tab for a durable runtime session, if any. */
export function openGuiIdForStoredSession(
  openSessions: SessionViewState[],
  storedSessionId: string,
  origin?: Pick<StoredSession, "hostId" | "hostUrl">,
): string | undefined {
  return openSessions.find((session) => {
    const durableIdMatches = session.runtimeSessionId === storedSessionId || session.resumeId === storedSessionId;
    if (!durableIdMatches || (!origin?.hostId && !origin?.hostUrl)) return durableIdMatches;
    if (origin.hostId && session.hostId === origin.hostId) return true;
    const originUrl = normalizedHostUrl(origin.hostUrl);
    return Boolean(originUrl && normalizedHostUrl(session.hostUrl) === originUrl);
  })?.guiId;
}

function normalizedHostUrl(value?: string): string {
  return value?.trim().replace(/\/$/, "") || "";
}
