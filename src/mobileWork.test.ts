import { describe, expect, it } from "vitest";
import { createSessionState } from "./reducer";
import type { LaneState, SessionViewState } from "./protocol";
import { sessionPlacement, workAttentionItems, workAttentionSummary } from "./mobileWork";

function lane(id: string, status: LaneState["status"], activity: string): LaneState {
  return {
    id,
    agent: id,
    status,
    activity,
    tail: "",
    tailKind: "text",
    thinking: "",
    tools: [],
    events: [],
  };
}

function session(id: string, title: string): SessionViewState {
  return { ...createSessionState(id, { projectDir: "/Users/michael/dev/studio" }), title };
}

describe("mobile Work summaries", () => {
  it("surfaces the exact names of approvals, decisions, and waiting agents", () => {
    const state: SessionViewState = {
      ...session("alpha", "Release follow-up"),
      pendingApproval: { ticketId: "approval", prompt: "Allow the release upload?", options: ["Allow once"] },
      pendingDecision: {
        decisionId: "decision",
        question: "Which rollout ring should go first?",
        reason: "",
        choices: ["Internal"],
        descriptions: [],
        multiple: false,
        custom: false,
      },
      lanes: {
        review: lane("Accessibility review", "attention", "Needs contrast confirmation"),
        done: lane("Completed review", "completed", "Done"),
      },
    };

    expect(workAttentionItems(state).map((item) => item.name)).toEqual([
      "Allow the release upload?",
      "Which rollout ring should go first?",
      "Accessibility review · Needs contrast confirmation",
    ]);
    expect(workAttentionSummary([state])).toEqual({ count: 3, name: "Allow the release upload?" });
  });

  it("keeps host and full project placement explicit", () => {
    expect(sessionPlacement({ ...session("remote", "Remote"), hostId: "spark", hostName: "Spark 288f" }))
      .toEqual({ host: "Spark 288f", project: "/Users/michael/dev/studio" });
    expect(sessionPlacement({ ...session("local", "Local"), hostId: "local" }).host).toBe("This computer");
  });
});
