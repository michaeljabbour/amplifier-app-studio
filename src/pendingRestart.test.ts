import { describe, expect, it } from "vitest";
import { createSessionState, reduceRecord } from "./reducer";
import type { ProtocolRecord } from "./protocol";

const decision: ProtocolRecord = {
  type: "runtime.event",
  event: {
    kind: "notification", event_id: "old-decision", session_id: "root",
    level: "decision", decision_id: "dead-owner-1", question: "Deploy?",
    choices: ["Yes", "No"],
  },
};
const status: ProtocolRecord = {
  type: "session.status", state: "idle", turn: { active: false },
  pending: { approval: null, decisions: [] },
};
const fresh = () => createSessionState("gui", { projectDir: "/tmp/project", mode: "chat" });

describe("pending requests after owner restart", () => {
  it("never presents a replayed decision while authoritative status is unavailable", () => {
    const state = reduceRecord(fresh(), { ...decision, replay: true });
    expect(state.acceptedReplayEvents).toBe(1);
    expect(state.pendingDecision).toBeUndefined();
  });

  it("keeps live decisions actionable and clears old attention on empty owner status", () => {
    let state = reduceRecord(fresh(), decision);
    expect(state.pendingDecision?.decisionId).toBe("dead-owner-1");
    state = reduceRecord(state, {
      type: "approval.required", ticket_id: "dead-approval", prompt: "Allow?", options: ["Deny"],
    });
    expect(state.pendingApproval?.ticketId).toBe("dead-approval");
    state = reduceRecord(state, status);
    expect(state.pendingDecision).toBeUndefined();
    expect(state.pendingApproval).toBeUndefined();
  });

  it("restores the current owner's live requests from authoritative status after replay", () => {
    let state = reduceRecord(fresh(), { ...decision, replay: true });
    state = reduceRecord(state, {
      ...status,
      pending: {
        approval: { ticket_id: "live-approval", prompt: "Allow?", options: ["Deny"] },
        decisions: [{ decision_id: "live-owner-1", question: "Choose?", choices: ["A", "B"] }],
      },
    });
    expect(state.pendingDecision?.decisionId).toBe("live-owner-1");
    expect(state.pendingApproval?.ticketId).toBe("live-approval");
  });
});
