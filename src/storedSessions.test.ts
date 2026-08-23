import { describe, expect, it } from "vitest";
import type { StoredSession } from "./protocol";
import { loadStoredSessionsAcrossHosts, storedHistoryFailureMessage, storedSessionMatchesQuery, storedSessionSourceLabel } from "./storedSessions";
import type { RuntimeHost } from "./transport";

const hosts: RuntimeHost[] = [
  { id: "local", name: "This computer", url: "", tokenRef: "local" },
  { id: "spark-a", name: "Spark A", url: "http://127.0.0.1:4318/", tokenRef: "keychain:spark-a" },
  { id: "spark-b", name: "Spark B", url: "http://127.0.0.1:4319/", tokenRef: "keychain:spark-b" },
];

describe("federated stored sessions", () => {
  it("merges and globally sorts history while recording its compute origin", async () => {
    const result = await loadStoredSessionsAcrossHosts(hosts, async (host) => host.id === "local"
      ? [session("local-1", 10)]
      : host.id === "spark-a"
        ? [session("remote-1", 30)]
        : [session("remote-2", 20)]);

    expect(result.sessions.map((item) => item.sessionId)).toEqual(["remote-1", "remote-2", "local-1"]);
    expect(result.sessions[0]).toMatchObject({ hostId: "spark-a", hostName: "Spark A", hostUrl: "http://127.0.0.1:4318/", sourceKind: "remote" });
    expect(result.sessions.at(-1)).toMatchObject({ hostId: "local", sourceKind: "local" });
    expect(result.failures).toEqual([]);
  });

  it("keeps identically named durable sessions when different hosts own them", async () => {
    const result = await loadStoredSessionsAcrossHosts(hosts.slice(1), async () => [session("same-id", 10)]);

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((item) => item.hostId)).toEqual(["spark-a", "spark-b"]);
  });

  it("keeps the same durable id when one host owns copies in different projects", async () => {
    const result = await loadStoredSessionsAcrossHosts(hosts.slice(1, 2), async () => [
      session("same-id", 20, { projectSlug: "project-a" }),
      session("same-id", 10, { projectSlug: "project-b" }),
    ]);

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((item) => item.projectSlug)).toEqual(["project-a", "project-b"]);
  });

  it("keeps successful history when one compute host is unavailable", async () => {
    const result = await loadStoredSessionsAcrossHosts(hosts.slice(1), async (host) => {
      if (host.id === "spark-b") throw new Error("bridge timed out");
      return [session("available", 10)];
    });

    expect(result.sessions.map((item) => item.sessionId)).toEqual(["available"]);
    expect(result.failures).toEqual([{ hostId: "spark-b", hostName: "Spark B", message: "bridge timed out" }]);
    expect(storedHistoryFailureMessage(result)).toBe("History is partial. 1 of 2 compute sources responded. Spark B: bridge timed out");
  });

  it("searches summaries and bounded conversation text with multi-term queries", () => {
    const item = session("stored-1", 10, {
      hostName: "Spark 288f",
      hostUrl: "http://127.0.0.1:4318/",
      projectDir: "/home/mjabbour/dev/runtime",
      summary: "Last update: release verification complete.",
      searchText: "Earlier we diagnosed the federated history scanner and repaired Graphviz rendering.",
    });

    expect(storedSessionMatchesQuery(item, "federated graphviz")).toBe(true);
    expect(storedSessionMatchesQuery(item, "spark runtime")).toBe(true);
    expect(storedSessionMatchesQuery(item, "release verification")).toBe(true);
    expect(storedSessionMatchesQuery(item, "remote spark")).toBe(true);
    expect(storedSessionMatchesQuery(item, "missing phrase")).toBe(false);
    expect(storedSessionSourceLabel(item)).toBe("Remote · Spark 288f");
  });
});

function session(sessionId: string, mtimeMs: number, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId,
    name: sessionId,
    bundle: "foundation",
    tags: [],
    messageCount: 1,
    mtimeMs,
    projectSlug: "project",
    state: "ok",
    summary: "Stored work",
    ...overrides,
  };
}
