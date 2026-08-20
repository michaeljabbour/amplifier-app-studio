export function terminalPlainText(value: string): string {
  return value
    // OSC runs to its BEL/ST terminator, or to the end of the chunk if it never arrives.
    // `[^\x07]*` was greedy ACROSS the ST terminator (ESC \\), so two OSC-8 hyperlinks -- which
    // cargo, gh, uv and pytest all emit routinely -- collapsed into one match and silently
    // deleted every line of real output between them.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/[\u0000\u0007\u0008]/g, "");
}
