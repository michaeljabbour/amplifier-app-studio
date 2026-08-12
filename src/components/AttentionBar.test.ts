import { describe, expect, it } from "vitest";
import { decisionChoiceRows, goalAlignedRecommendedChoice } from "./AttentionBar";

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
});
