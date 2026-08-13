import { describe, expect, it } from "vitest";
import { createSessionState } from "../reducer";
import { runtimeFailureCopy, transcriptAtBottom, transcriptScrollMarker } from "./Transcript";

describe("transcript following", () => {
  it("detaches as soon as the reader moves up instead of fighting within a bottom threshold", () => {
    expect(transcriptAtBottom(1_000, 600, 400)).toBe(true);
    expect(transcriptAtBottom(1_000, 599.75, 400)).toBe(true);
    expect(transcriptAtBottom(1_000, 599, 400)).toBe(false);
    expect(transcriptAtBottom(1_000, 597, 400)).toBe(false);
    expect(transcriptAtBottom(1_000, 520, 400)).toBe(false);
  });

  it("does not treat background session status changes as new transcript content", () => {
    const state = {
      ...createSessionState("gui", { projectDir: "/tmp/project" }),
      blocks: [{ id: "answer", kind: "answer" as const, text: "Finished", final: true }],
    };
    expect(transcriptScrollMarker({ ...state, activity: "Ready" }))
      .toBe(transcriptScrollMarker({ ...state, activity: "Status refreshed", queuedSteers: 2 }));
  });

  it("changes when visible transcript content changes", () => {
    const state = createSessionState("gui", { projectDir: "/tmp/project" });
    const next = {
      ...state,
      blocks: [{ id: "answer", kind: "answer" as const, text: "A new answer", final: false }],
    };
    expect(transcriptScrollMarker(next)).not.toBe(transcriptScrollMarker(state));
    expect(transcriptScrollMarker({ ...next, liveTail: { blockType: "text", text: "streaming" } }))
      .not.toBe(transcriptScrollMarker(next));
  });

  it("explains approval-routing and moved-project failures in recovery language", () => {
    const state = createSessionState("gui", { projectDir: "/tmp/project" });
    expect(runtimeFailureCopy({
      ...state,
      exitCode: 1,
      error: "Amplifier runtime exited with code 1",
      logs: ["ValueError: choice 'Project answer' is not one of ('Allow once', 'Deny')"],
    }).title).toContain("wrong Amplifier request");
    expect(runtimeFailureCopy({ ...state, exitCode: 4 }).title).toContain("incomplete session copy");
  });
});
