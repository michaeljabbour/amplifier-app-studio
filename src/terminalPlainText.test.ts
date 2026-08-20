import { describe, expect, it } from "vitest";
import { terminalPlainText } from "./terminalPlainText";

const ST = "\x1b\\";
const BEL = "\x07";
const hyperlink = (url: string, label: string) => `\x1b]8;;${url}${ST}${label}\x1b]8;;${ST}`;

describe("terminalPlainText", () => {
  // Regression: the OSC pattern was `\x1b\][^\x07]*(?:\x07|\x1b\\)`. With no BEL anywhere in the
  // chunk, `[^\x07]*` ran greedily past the first ST terminator and backtracked to the LAST one,
  // so a single match spanned from the opening hyperlink to the closing one and deleted every
  // diagnostic line in between. cargo, gh, uv and pytest all emit OSC-8 hyperlinks by default.
  it("keeps the output between two OSC-8 hyperlinks", () => {
    const raw = [
      hyperlink("https://doc.rust-lang.org/error_codes/E0308.html", "error[E0308]"),
      ": mismatched types",
      "\n  --> src/main.rs:4:9",
      "\n   = note: expected `u32`, found `&str`\n",
      hyperlink("https://example.invalid/help", "help"),
      ": run `cargo fix`\n",
    ].join("");

    const plain = terminalPlainText(raw);

    expect(plain).toContain("error[E0308]: mismatched types");
    expect(plain).toContain("--> src/main.rs:4:9");
    expect(plain).toContain("expected `u32`, found `&str`");
    expect(plain).toContain("help: run `cargo fix`");
    expect(plain).not.toContain("https://doc.rust-lang.org");
    expect(plain).not.toContain("\x1b");
  });

  it("strips BEL-terminated and ST-terminated OSC sequences alike", () => {
    expect(terminalPlainText(`\x1b]0;window title${BEL}ready`)).toBe("ready");
    expect(terminalPlainText(`\x1b]0;window title${ST}ready`)).toBe("ready");
  });

  it("drops an unterminated OSC rather than leaking its payload as text", () => {
    expect(terminalPlainText("done\n\x1b]8;;https://example.invalid/partial")).toBe("done\n");
  });

  it("still strips CSI colour codes and rewrites bare carriage returns only", () => {
    expect(terminalPlainText("\x1b[31mred\x1b[0m\r\nnext\rrewritten")).toBe("red\r\nnext\nrewritten");
  });
});
