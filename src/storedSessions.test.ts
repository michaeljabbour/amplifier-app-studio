import { describe, expect, it } from "vitest";
import type { StoredSession } from "./protocol";
import { loadStoredSessionsAcrossHosts, storedHistoryFailureMessage } from "./storedSessions";
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
    expect(result.sessions[0]).toMatchObject({ hostId: "spark-a", hostName: "Spark A", hostUrl: "http://127.0.0.1:4318/" });
    expect(result.failures).toEqual([]);
  });

  it("keeps identically named durable sessions when different hosts own them", async () => {
    const result = await loadStoredSessionsAcrossHosts(hosts.slice(1), async () => [session("same-id", 10)]);

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((item) => item.hostId)).toEqual(["spark-a", "spark-b"]);
  });

  it("keeps successful history when one compute host is unavailable", async () => {
    const result = await loadStoredSessionsAcrossHosts(hosts.slice(1), async (host) => {
      if (host.id === "spark-b") throw new Error("bridge timed out");
      return [session("available", 10)];
    });

    expect(result.sessions.map((item) => item.sessionId)).toEqual(["available"]);
    expect(result.failures).toEqual([{ hostId: "spark-b", hostName: "Spark B", message: "bridge timed out" }]);
    expect(storedHistoryFailureMessage(result)).toBe("History is partial. Could not reach Spark B.");
  });
});

function session(sessionId: string, mtimeMs: number): StoredSession {
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
  };
}
