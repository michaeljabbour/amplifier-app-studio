import { describe, expect, it } from "vitest";
import { createSessionState } from "../reducer";
import { transcriptScrollMarker } from "./Transcript";

describe("transcript following", () => {
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
});
