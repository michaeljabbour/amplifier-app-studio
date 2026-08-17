import type { SessionViewState } from "./protocol";
import type { RuntimeHost } from "./transport";

export function projectContextForHost(
  session: SessionViewState | undefined,
  host: RuntimeHost | undefined,
  fallback: string,
): string {
  if (!session || !host) return fallback;

  const sessionUrl = normalizeUrl(session.hostUrl || "");
  const hostUrl = normalizeUrl(host.url);
  if (sessionUrl || hostUrl) return sessionUrl === hostUrl ? session.projectDir : fallback;

  const sessionHostId = session.hostId || "local";
  return sessionHostId === host.id ? session.projectDir : fallback;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
