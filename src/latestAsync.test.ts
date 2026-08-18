import { describe, expect, it, vi } from "vitest";
import { createLatestAsyncRunner } from "./latestAsync";

describe("latest async runner", () => {
  it("ignores a stale host result that finishes after the active host", async () => {
    const runLatest = createLatestAsyncRunner<string>();
    const committed = vi.fn();
    const finished = vi.fn();
    let finishLocal!: (value: string) => void;
    let finishRemote!: (value: string) => void;

    const local = runLatest(
      () => new Promise((resolve) => { finishLocal = resolve; }),
      { commit: committed, finish: finished },
    );
    const remote = runLatest(
      () => new Promise((resolve) => { finishRemote = resolve; }),
      { commit: committed, finish: finished },
    );

    finishRemote("Spark provider ready");
    await remote;
    finishLocal("Local provider missing");
    await local;

    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledWith("Spark provider ready");
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("ignores an older request error after a newer request succeeds", async () => {
    const runLatest = createLatestAsyncRunner<string>();
    const committed = vi.fn();
    const rejected = vi.fn();
    let rejectLocal!: (error: Error) => void;

    const local = runLatest(
      () => new Promise((_resolve, reject) => { rejectLocal = reject; }),
      { commit: committed, reject: rejected },
    );
    const remote = runLatest(
      () => Promise.resolve("Spark provider ready"),
      { commit: committed, reject: rejected },
    );

    await remote;
    rejectLocal(new Error("Local provider missing"));
    await local;

    expect(committed).toHaveBeenCalledWith("Spark provider ready");
    expect(rejected).not.toHaveBeenCalled();
  });
});
