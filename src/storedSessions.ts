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
        sourceKind: runtimeHostSourceKind(host),
      };
      const key = `${host.id}\u0000${session.projectSlug}\u0000${session.sessionId}`;
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

export function storedSessionMatchesQuery(session: StoredSession, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const searchable = [
    session.name,
    session.bundle,
    session.model,
    session.sessionId,
    session.projectSlug,
    session.projectDir,
    session.hostName,
    storedSessionSourceLabel(session),
    storedSessionSourceKind(session),
    session.summary,
    session.searchText,
    ...session.tags,
  ].filter(Boolean).join("\n").toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

export function storedHistoryFailureMessage(result: FederatedStoredSessions): string | undefined {
  if (!result.failures.length) return undefined;
  const details = result.failures
    .map((failure) => `${failure.hostName}: ${failure.message}`)
    .join("; ");
  if (result.failures.length === result.hostsQueried) {
    return `Could not read history from any configured compute. ${details}`;
  }
  return `History is partial. ${result.hostsQueried - result.failures.length} of ${result.hostsQueried} compute sources responded. ${details}`;
}

export function storedSessionSourceKind(session: Pick<StoredSession, "sourceKind" | "hostId" | "hostUrl">): "local" | "remote" {
  return session.sourceKind || (session.hostId === "local" || !session.hostUrl ? "local" : "remote");
}

export function storedSessionSourceLabel(session: Pick<StoredSession, "sourceKind" | "hostId" | "hostName" | "hostUrl">): string {
  const kind = storedSessionSourceKind(session);
  const host = session.hostName || (kind === "local" ? "This computer" : "Remote compute");
  return `${kind === "local" ? "Local" : "Remote"} · ${host}`;
}

function runtimeHostSourceKind(host: RuntimeHost): "local" | "remote" {
  return host.id === "local" || !host.url ? "local" : "remote";
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
