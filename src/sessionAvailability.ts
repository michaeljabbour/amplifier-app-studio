import type { StoredSession } from "./protocol";

export function storedSessionResumeBlocker(session: StoredSession, requireProjectDir: boolean): string | undefined {
  if (requireProjectDir && !session.projectDir) {
    return "The original project folder could not be resolved. Use Browse all stored sessions to choose it.";
  }
  switch (session.state) {
    case "recovered":
      return "Only recovered metadata is available, so automatic resume is disabled.";
    case "indexing":
      return "This session has transcript data but no metadata record, so it cannot be resumed safely.";
    case "empty":
      return "This runtime attempt ended before it wrote a resumable conversation.";
    case "corrupt":
      return "The stored session is corrupt and cannot be resumed safely.";
    default:
      return undefined;
  }
}

export function storedSessionWarning(session: StoredSession): string | undefined {
  if (!session.projectDir) return "Choose the original project folder before resuming.";
  if (session.state === "transcript_lost") {
    return "Transcript history is damaged; Amplifier will restore only the durable data still available.";
  }
  return undefined;
}
