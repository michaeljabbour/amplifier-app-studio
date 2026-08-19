import type { StoredSession } from "./protocol";
import type { RuntimeHost } from "./transport";

export interface StoredSessionHostFailure {
  hostId: string;
  hostName: string;
  message: string;
}

export interface FederatedStoredSessions {
  sessions: StoredSession[];
  failures: StoredSessionHostFailure[];
  hostsQueried: number;
}

export type StoredSessionLoader = (host: RuntimeHost) => Promise<StoredSession[]>;

/**
 * Read durable history from every configured compute host while keeping each
 * session pinned to the machine that owns it. One unreachable host must not
 * hide sessions returned by the rest of the pool.
 */
export async function loadStoredSessionsAcrossHosts(
  hosts: RuntimeHost[],
  load: StoredSessionLoader,
): Promise<FederatedStoredSessions> {
  const uniqueHosts = dedupeHosts(hosts);
  const results = await Promise.allSettled(uniqueHosts.map(async (host) => ({
    host,
    sessions: await load(host),
  })));
  const sessions = new Map<string, StoredSession>();
  const failures: StoredSessionHostFailure[] = [];

  results.forEach((result, index) => {
    const host = uniqueHosts[index];
    if (result.status === "rejected") {
      failures.push({
        hostId: host.id,
        hostName: host.name,
        message: cleanError(result.reason),
      });
      return;
    }
    for (const session of result.value.sessions) {
      const annotated = {
        ...session,
        hostId: host.id,
        hostName: host.name,
        hostUrl: host.url || undefined,
      };
      const key = `${host.id}\u0000${session.sessionId}`;
      const existing = sessions.get(key);
      if (!existing || annotated.mtimeMs > existing.mtimeMs) sessions.set(key, annotated);
    }
  });

  return {
    sessions: [...sessions.values()].sort((left, right) => right.mtimeMs - left.mtimeMs),
    failures,
    hostsQueried: uniqueHosts.length,
  };
}

export function storedHistoryFailureMessage(result: FederatedStoredSessions): string | undefined {
  if (!result.failures.length) return undefined;
  const names = result.failures.map((failure) => failure.hostName).join(", ");
  if (result.failures.length === result.hostsQueried) {
    return `Could not read history from ${names}.`;
  }
  return `History is partial. Could not reach ${names}.`;
}

function dedupeHosts(hosts: RuntimeHost[]): RuntimeHost[] {
  const seen = new Set<string>();
  return hosts.filter((host) => {
    const key = host.id || host.url.replace(/\/$/, "") || "local";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanError(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}
