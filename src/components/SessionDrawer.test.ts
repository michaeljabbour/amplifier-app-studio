import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./SessionDrawer.tsx", import.meta.url), "utf8");

describe("mobile open-session actions", () => {
  it("keeps Detach and Stop as distinct explicit callback contracts", () => {
    expect(source).toContain("onDetachOpen: (id: string)");
    expect(source).toContain("onStopOpen: (id: string)");
    expect(source).toContain("void props.onDetachOpen(session.guiId)");
    expect(source).toContain("void props.onStopOpen(session.guiId)");
    expect(source).toContain("Leave the runtime running");
    expect(source).toContain("End the runtime and close");
  });

  it("exposes a named, keyboard-reachable overflow menu for each open session", () => {
    expect(source).toContain("aria-label={`Session actions for ${session.title}`}");
    expect(source).toContain("aria-expanded={openSessionMenu() === session.guiId}");
    expect(source).toContain('role="menu"');
    expect(source.match(/role="menuitem"/g)).toHaveLength(2);
  });

  it("exposes stored history as a named modal with an explicit search control", () => {
    expect(source).toContain('role="dialog" aria-modal="true" aria-label="Stored sessions"');
    expect(source).toContain('aria-label="Search stored sessions"');
    expect(source).toContain('if (event.key === "Escape") props.onClose()');
  });
});
