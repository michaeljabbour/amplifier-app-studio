import { describe, expect, it } from "vitest";
import { terminalPlainText } from "./TerminalWorkSurface";

describe("terminal work surface", () => {
  it("renders terminal output as text without ANSI control sequences", () => {
    expect(terminalPlainText("\u001b[32mready\u001b[0m\n\u001b]0;title\u0007$ ")).toBe("ready\n$ ");
  });
});
