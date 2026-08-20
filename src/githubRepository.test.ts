import { describe, expect, it } from "vitest";
import { githubCloneDestination, parseGithubRepositoryUrl } from "./githubRepository";

describe("GitHub repository URLs", () => {
  it("derives one safe repository destination", () => {
    expect(parseGithubRepositoryUrl("https://github.com/microsoft/amplifier.git")).toEqual({
      owner: "microsoft",
      name: "amplifier",
      repository: "microsoft/amplifier",
    });
    expect(githubCloneDestination("https://github.com/microsoft/amplifier")).toBe("~/dev/amplifier");
    expect(githubCloneDestination("https://github.com/microsoft/amplifier", "Spark")).toBe("Spark · dev/amplifier");
  });

  it.each([
    "git@github.com:microsoft/amplifier.git",
    "http://github.com/microsoft/amplifier",
    "https://user:secret@github.com/microsoft/amplifier",
    "https://github.com/microsoft/amplifier/tree/main",
    "https://github.com/microsoft/amplifier?tab=readme",
    "https://github.com.evil.test/microsoft/amplifier",
    "https://github.com/microsoft/%2E%2E",
  ])("rejects unsafe or non-repository input: %s", (value) => {
    expect(() => parseGithubRepositoryUrl(value)).toThrow();
  });
});
