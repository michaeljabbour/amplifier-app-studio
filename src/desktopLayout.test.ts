import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const drawerSource = readFileSync(new URL("./components/SessionDrawer.tsx", import.meta.url), "utf8");
const tabStripSource = readFileSync(new URL("./components/TabStrip.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("desktop navigation and history contracts", () => {
  it("renders the desktop drawer icon with an explicit visible stroke", () => {
    expect(tabStripSource).toContain('class="icon-button drawer-button"');
    expect(styles).toMatch(/\.drawer-button svg\s*\{[\s\S]*stroke:\s*currentColor/);
  });

  it("keeps stored history on one bounded native scroll surface", () => {
    expect(styles).toMatch(/\.session-drawer\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.stored-list\s*\{[\s\S]*grid-row:\s*3;[\s\S]*overflow-y:\s*auto;[\s\S]*touch-action:\s*pan-y/);
    expect(drawerSource).toContain('class="stored-list" onScroll={revealMoreNearBottom}');
    expect(drawerSource).toContain("setLimit((value) => value + 500)");
  });

  it("refreshes the compute registry before federating session history", () => {
    expect(appSource).toContain("await listRuntimeHosts().catch(() => runtimeHosts())");
    expect(appSource).toContain("loadStoredSessionsAcrossHosts(hosts");
  });

  it("shows session setup before invoking the native folder picker", () => {
    const openNewDialog = appSource.slice(
      appSource.indexOf("const openNewDialog"),
      appSource.indexOf("const openSibling", appSource.indexOf("const openNewDialog")),
    );
    expect(openNewDialog).toContain("setDialog({ projectDir: remembered");
    expect(openNewDialog).not.toContain("selectProjectFolder(");
  });
});
