import type { StoredSession } from "./protocol";

export function storedSessionResumeBlocker(session: StoredSession, requireProjectDir: boolean): string | undefined {
  if (requireProjectDir && !session.projectDir) {
    return "The original project folder could not be resolved. Use Browse all stored sessions to choose it.";
  }
  switch (session.state) {
    case "recovered":
      return "The original metadata was recovered from backup. Create an independent copy before continuing.";
    case "indexing":
      return "This session has a conversation but no metadata record. Studio can reconstruct it as an independent copy.";
    case "empty":
      return "This runtime attempt ended before it wrote a resumable conversation.";
    case "corrupt":
      return "The stored session is corrupt and cannot be resumed safely.";
    default:
      return undefined;
  }
}

export function storedSessionCanDuplicate(session: StoredSession): boolean {
  return session.messageCount > 0 && !["empty", "corrupt", "transcript_lost"].includes(session.state);
}

export function storedSessionWarning(session: StoredSession): string | undefined {
  if (!session.projectDir) return "Choose the original project folder before resuming.";
  if (session.state === "transcript_lost") {
    return "Transcript history is damaged; Amplifier will restore only the durable data still available.";
  }
  return undefined;
}

/**
 * Older Amplifier releases persisted discovery identifiers such as
 * `bundle:anchors`. Current runtimes resolve the catalog name (`anchors`).
 * Supply only that compatibility override; current sessions should continue
 * to let amplifier-runtime enforce its stored-bundle resume policy.
 */
export function storedSessionLegacyBundleOverride(session: StoredSession): string | undefined {
  const legacy = session.bundle.trim().match(/^bundle:(.+)$/i)?.[1]?.trim();
  return legacy && legacy.toLowerCase() !== "unknown" ? legacy : undefined;
}
