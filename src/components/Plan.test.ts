import { describe, expect, it } from "vitest";
import type { PlanOwnerState } from "../protocol";
import { countPlanSteps } from "./Plan";

describe("plan presence counts", () => {
  it("aggregates coordinator and agent steps while retaining degraded owners", () => {
    const plans: Record<string, PlanOwnerState> = {
      coordinator: {
        ownerId: "runtime-1",
        ownerKind: "coordinator",
        toolCallId: "root-plan",
        updateStatus: "applied",
        items: [
          { content: "Done", status: "completed" },
          { content: "Next", status: "pending" },
        ],
      },
      "agent:child-1": {
        ownerId: "child-1",
        ownerKind: "agent",
        toolCallId: "child-plan",
        updateStatus: "degraded",
        items: [{ content: "Working", status: "in_progress" }],
      },
    };

    expect(countPlanSteps(plans)).toEqual({ completed: 1, total: 3, owners: 2, degraded: 1 });
  });
});
