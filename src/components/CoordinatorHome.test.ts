import { describe, expect, it } from "vitest";
import { projectDisplayName } from "./CoordinatorHome";

describe("coordinator home project control", () => {
  it("shows a concise project name while retaining the full path elsewhere", () => {
    expect(projectDisplayName("/Users/michael/dev/amplifier-app-studio")).toBe("amplifier-app-studio");
    expect(projectDisplayName("C:\\Users\\Michael\\Studio\\")).toBe("Studio");
    expect(projectDisplayName(" ")).toBe("Choose project");
  });
});
