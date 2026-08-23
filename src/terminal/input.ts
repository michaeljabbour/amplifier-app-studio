import type { TerminalInputRequest } from "./types";

/** Preserve xterm's bytes exactly, including control and escape sequences. */
export function terminalInputRequest(data: string): TerminalInputRequest {
  return { text: data, mode: "interactive" };
}
