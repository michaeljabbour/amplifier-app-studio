// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { attentionControlsUnavailable, attentionResponseFor, decisionChoiceRows, goalAlignedRecommendedChoice } from "./AttentionBar";
import { createSessionState } from "../reducer";

describe("decision automation", () => {
  it("uses only an explicit Amplifier recommendation when automatic decision-making is active", () => {
    expect(goalAlignedRecommendedChoice({
      recommendedChoice: "All four changes (Recommended)",
      multiple: false,
    }, true)).toBe("All four changes (Recommended)");
    expect(goalAlignedRecommendedChoice({
      recommendedChoice: "All four changes (Recommended)",
      multiple: false,
    }, false)).toBeUndefined();
    expect(goalAlignedRecommendedChoice({
      recommendedChoice: "First",
      multiple: true,
    }, true)).toBeUndefined();
  });

  it("retains every action, explanation, and recommendation for rendering", () => {
    expect(decisionChoiceRows({
      choices: ["All four changes (Recommended)", "Diagnosis only"],
      descriptions: ["Make the complete coherent change", "Stop before editing"],
      recommendedChoice: "All four changes (Recommended)",
    })).toEqual([
      {
        choice: "All four changes (Recommended)",
        description: "Make the complete coherent change",
        recommended: true,
      },
      {
        choice: "Diagnosis only",
        description: "Stop before editing",
        recommended: false,
      },
    ]);
  });

  it("routes simultaneous attention to the blocking approval instead of sending a decision answer", () => {
    const state = {
      ...createSessionState("gui", { projectDir: "/tmp/project" }),
      pendingApproval: {
        ticketId: "approval-1",
        prompt: "Run command?",
        options: ["Allow once", "Allow always", "Deny"],
      },
      pendingDecision: {
        decisionId: "decision-1",
        question: "Which rename result?",
        reason: "",
        choices: ["The redirect is fine — the rename is complete (Recommended)"],
        descriptions: [],
        multiple: false,
        custom: false,
      },
    };
    expect(attentionResponseFor(state, "Allow once")).toEqual({
      kind: "approval",
      ticketId: "approval-1",
      choice: "Allow once",
    });
  });

  it("keeps decisions pending but disables answers while compute reconnects", () => {
    const state = createSessionState("gui", { projectDir: "/tmp/project" });
    expect(attentionControlsUnavailable(state)).toBe(false);
    expect(attentionControlsUnavailable({
      ...state,
      connectivity: { status: "reconnecting", message: "Trying again" },
    })).toBe(true);
  });
});
