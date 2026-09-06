import { describe, expect, it } from "vitest";
import { assertOutputHostMatchesSession } from "./outputAccess";

const local = { hostId: "local", hostUrl: undefined, hostName: "My Mac" };
const remote = { hostId: "spark-288f", hostUrl: "https://spark.example.test/", hostName: "Spark 288f" };

describe("output opening host ownership", () => {
  it.each([undefined, "", "   "])("uses the session owner when output provenance has no host: %s", (runtimeHost) => {
    expect(() => assertOutputHostMatchesSession({ runtimeHost }, remote)).not.toThrow();
    expect(() => assertOutputHostMatchesSession({ runtimeHost }, local)).not.toThrow();
  });

  it.each(["spark-288f", "Spark 288f", "https://spark.example.test", "https://SPARK.example.test:443/", "wss://spark.example.test/"])(
    "accepts the recorded session host identity: %s", (runtimeHost) => {
      expect(() => assertOutputHostMatchesSession({ runtimeHost }, remote)).not.toThrow();
    },
  );

  it.each(["local", " LOCAL ", "localhost", "This computer", "native", "Native desktop", "My Mac"])(
    "accepts local aliases only for a proven local owner: %s", (runtimeHost) => {
      expect(() => assertOutputHostMatchesSession({ runtimeHost }, local)).not.toThrow();
      expect(() => assertOutputHostMatchesSession({ runtimeHost }, remote)).toThrow("owning compute");
    },
  );

  it("rejects an explicit foreign host without guessing a project mapping", () => {
    expect(() => assertOutputHostMatchesSession({ runtimeHost: "https://other.example.test" }, remote))
      .toThrow('recorded on "https://other.example.test/", but this session belongs to "Spark 288f"');
    expect(() => assertOutputHostMatchesSession({ runtimeHost: "different-host-id" }, local))
      .toThrow("select the output's project there");
  });

  it("keeps explicit local ownership authoritative over a stale restored remote URL", () => {
    const restored = { ...local, hostUrl: remote.hostUrl };
    expect(() => assertOutputHostMatchesSession({ runtimeHost: "local" }, restored)).not.toThrow();
    expect(() => assertOutputHostMatchesSession({ runtimeHost: remote.hostUrl }, restored)).toThrow();
  });

  it("uses the same local default as catalog context for legacy sessions without host metadata", () => {
    const legacy = { hostId: undefined, hostUrl: undefined, hostName: undefined };
    expect(() => assertOutputHostMatchesSession({ runtimeHost: "local" }, legacy)).not.toThrow();
    expect(() => assertOutputHostMatchesSession({ runtimeHost: remote.hostUrl }, legacy)).toThrow();
  });

  it("does not treat a loopback bridge URL as local compute", () => {
    const forwarded = { hostId: "spark-forward", hostUrl: "http://127.0.0.1:4319/", hostName: "Forwarded Spark" };
    expect(() => assertOutputHostMatchesSession({ runtimeHost: "http://127.0.0.1:4319" }, forwarded)).not.toThrow();
    expect(() => assertOutputHostMatchesSession({ runtimeHost: "http://127.0.0.1:4319" }, local)).toThrow();
    expect(() => assertOutputHostMatchesSession({ runtimeHost: "http://localhost:4319" }, local)).toThrow();
    expect(() => assertOutputHostMatchesSession({ runtimeHost: "http://127.0.0.1:4320" }, forwarded)).toThrow();
  });

  it("does not grant remote outputs local access through a misleading display name", () => {
    expect(() => assertOutputHostMatchesSession({ runtimeHost: "This computer" }, { ...remote, hostName: "This computer" })).toThrow();
    expect(() => assertOutputHostMatchesSession({ runtimeHost: remote.hostUrl }, { ...local, hostName: remote.hostUrl })).toThrow();
  });

  it("does not match prefixes, guess hostnames, or discard meaningful URL paths", () => {
    for (const runtimeHost of ["spark.example.test", "https://spark.example.test.evil.test", "https://spark.example.test/other-bridge"]) {
      expect(() => assertOutputHostMatchesSession({ runtimeHost }, remote)).toThrow();
    }
  });

  it("rejects credential-bearing provenance without including its credentials in errors", () => {
    let message = "";
    try {
      assertOutputHostMatchesSession({ runtimeHost: "https://user:secret@other.example.test/?token=sensitive" }, remote);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("other.example.test");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("sensitive");
  });
});
