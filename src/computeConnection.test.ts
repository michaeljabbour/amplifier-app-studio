import { describe, expect, it } from "vitest";
import { computeConnectionPrompt } from "./computeConnection";

const spark = {
  id: "spark-288f",
  name: "Spark 288f",
  url: "https://spark-288f.tail422ba7.ts.net",
  tokenRef: "session",
};

describe("compute connection copy", () => {
  it("treats a saved mobile home without a token as a reconnect, not missing compute", () => {
    expect(computeConnectionPrompt(spark, true)).toEqual({
      kind: "reconnect",
      kicker: "COMPUTE ACCESS",
      title: "Reconnect Spark 288f",
      description: "Spark 288f is still saved as Session home at spark-288f.tail422ba7.ts.net, but secure access is unavailable on this device. Enter its access token once to reconnect.",
      action: "Reconnect Spark 288f",
      composerLabel: "Spark 288f needs its access token",
      composerPlaceholder: "Reconnect Spark 288f to start",
    });
  });

  it("keeps an authenticated but unavailable saved host distinct from initial setup", () => {
    const prompt = computeConnectionPrompt(spark, false, "No response from the host.");

    expect(prompt.kind).toBe("attention");
    expect(prompt.title).toBe("Spark 288f needs attention");
    expect(prompt.action).toBe("Review Spark 288f");
    expect(prompt.description).toContain("No response from the host.");
  });

  it("uses connect language only when no compute host is saved", () => {
    expect(computeConnectionPrompt(undefined, false)).toMatchObject({
      kind: "connect",
      title: "Connect a compute host",
      action: "Connect compute host",
    });
  });
});
