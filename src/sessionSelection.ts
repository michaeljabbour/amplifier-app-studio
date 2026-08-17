import type { SessionViewState } from "./protocol";

/** Return the already-open Studio tab for a durable runtime session, if any. */
export function openGuiIdForStoredSession(openSessions: SessionViewState[], storedSessionId: string): string | undefined {
  return openSessions.find((session) =>
    session.runtimeSessionId === storedSessionId || session.resumeId === storedSessionId,
  )?.guiId;
}
