import type { SessionOutput, SessionViewState } from "./protocol";

type SessionOwner = Pick<SessionViewState, "hostId" | "hostUrl" | "hostName">;

const LOCAL_ALIASES = new Set(["local", "localhost", "this computer", "native", "native desktop"]);

/** Validate provenance before using the session's project/host to open a file.
 * An output record does not supply an independently verified project on another
 * computer, so a foreign host can never be repaired by swapping the URL alone.
 * Legacy sessions with neither id nor URL use Studio's explicit local default.
 */
export function assertOutputHostMatchesSession(
  output: Pick<SessionOutput, "runtimeHost">,
  state: SessionOwner,
): void {
  const recorded = output.runtimeHost?.trim();
  if (!recorded) return;

  const hostId = state.hostId?.trim();
  const hostUrl = state.hostUrl?.trim();
  const hostName = state.hostName?.trim();
  const local = hostId === "local" || (!hostId && !hostUrl);
  const recordedUrl = normalizeHostUrl(recorded);
  let matches = false;
  if (local) {
    // An explicit local owner overrides stale restored remote URL metadata.
    // Loopback URLs may be forwards to a remote compute and are never aliases.
    matches = !recordedUrl && !looksLikeUrl(recorded)
      && (LOCAL_ALIASES.has(recorded.toLowerCase()) || recorded === hostName);
  } else if (!LOCAL_ALIASES.has(recorded.toLowerCase())) {
    matches = recordedUrl
      ? recordedUrl === normalizeHostUrl(hostUrl)
      : !looksLikeUrl(recorded) && (recorded === hostId || recorded === hostName);
  }
  if (matches) return;

  const owner = local ? hostName || "This computer" : hostName || hostId || safeHostLabel(hostUrl || "the selected compute");
  throw new Error(
    `This output was recorded on "${safeHostLabel(recorded)}", but this session belongs to "${owner}". `
    + "Open its owning compute and select the output's project there before opening the file; Studio cannot infer that host's project from this session.",
  );
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function normalizeHostUrl(value?: string): string | undefined {
  if (!value || !/^(?:https?|wss?):\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

function safeHostLabel(value: string): string {
  if (looksLikeUrl(value)) {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch { /* Keep a bounded label for malformed provenance. */ }
  }
  return value.replace(/[\r\n\t]/g, " ").slice(0, 180);
}
