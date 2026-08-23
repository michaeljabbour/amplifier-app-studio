import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { terminalInputRequest } from "../terminal/input";

const source = readFileSync(new URL("./TerminalWorkSurface.tsx", import.meta.url), "utf8");

describe("terminal work surface", () => {
  it("routes terminal bytes directly, including interrupt and EOF", () => {
    expect(terminalInputRequest("\u0003")).toEqual({ text: "\u0003", mode: "interactive" });
    expect(terminalInputRequest("\u0004")).toEqual({ text: "\u0004", mode: "interactive" });
    expect(terminalInputRequest("\u001b[A")).toEqual({ text: "\u001b[A", mode: "interactive" });
  });

  it("uses the emulator as the full right pane without a command composer", () => {
    expect(source).toContain("<TerminalEmulator");
    expect(source).not.toContain("terminal-command-bar");
    expect(source).not.toContain("COMPUTE WORKSPACE");
  });
});
