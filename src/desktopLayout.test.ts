import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const drawerSource = readFileSync(new URL("./components/SessionDrawer.tsx", import.meta.url), "utf8");
const coordinatorHomeSource = readFileSync(new URL("./components/CoordinatorHome.tsx", import.meta.url), "utf8");
const tabStripSource = readFileSync(new URL("./components/TabStrip.tsx", import.meta.url), "utf8");
const terminalSurfaceSource = readFileSync(new URL("./components/TerminalWorkSurface.tsx", import.meta.url), "utf8");
const terminalStyles = readFileSync(new URL("./components/TerminalWorkSurface.css", import.meta.url), "utf8");
const newSessionSource = readFileSync(new URL("./components/NewSessionDialog.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const packageSource = readFileSync(new URL("../package.json", import.meta.url), "utf8");

describe("desktop navigation and history contracts", () => {
  it("renders the desktop drawer icon with an explicit visible stroke", () => {
    expect(tabStripSource).toContain('class="icon-button drawer-button"');
    expect(styles).toMatch(/\.drawer-button svg\s*\{[\s\S]*stroke:\s*currentColor/);
  });

  it("keeps stored history on one bounded native scroll surface", () => {
    expect(styles).toMatch(/\.session-drawer\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.stored-list\s*\{[\s\S]*grid-row:\s*4;[\s\S]*overflow-y:\s*auto;[\s\S]*touch-action:\s*pan-y/);
    expect(drawerSource).toContain('aria-label="Filter history by compute source"');
    expect(drawerSource).toContain('class="stored-list" onScroll={revealMoreNearBottom}');
    expect(drawerSource).toContain("setLimit((value) => value + 500)");
    expect(coordinatorHomeSource).not.toContain('class="home-history"');
    expect(coordinatorHomeSource).not.toContain("Browse all stored sessions");
    expect(coordinatorHomeSource).toContain('class="home-continue"');
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

  it("requires the native folder picker before starting or resuming local work", () => {
    expect(newSessionSource).toContain('nativeProjectPicker() && !localProjectConfirmed()');
    expect(newSessionSource).toContain('await props.onPickProjectDir(projectDir())');
    expect(newSessionSource).toContain('setLocalProjectConfirmed(true)');

    const startFromHome = appSource.slice(
      appSource.indexOf("async function startFromHome"),
      appSource.indexOf("async function chooseHomeProject"),
    );
    expect(startFromHome).toContain("await selectProjectFolder(remembered)");
    expect(startFromHome).not.toContain("remembered ||");

    const prepareStoredResume = appSource.slice(
      appSource.indexOf("async function prepareStoredResume"),
      appSource.indexOf("async function duplicateStoredSession"),
    );
    expect(prepareStoredResume).toContain("await selectProjectFolder(remembered)");
    expect(prepareStoredResume).not.toContain("remembered ||");
  });

  it("keeps GitHub clone inside fresh-session setup and outside resume payloads", () => {
    expect(newSessionSource).toContain("Clone GitHub repository");
    expect(newSessionSource).toContain("!props.initial.resumeId");
    expect(newSessionSource).toContain("await props.onCloneRepository");
    expect(newSessionSource).toContain("setProjectDir(result.path)");
    expect(newSessionSource).toContain("Review setup, then start");
    expect(appSource).toContain("canCloneRepository={(host)");
    expect(appSource).toContain("onCloneRepository={async (repositoryUrl, host)");
    expect(appSource).toContain("await refreshCatalog(result.path");
  });

  it("opens native local terminal sessions inside the Studio workbench", () => {
    expect(appSource).toContain("new NativeTmuxAdapter");
    expect(appSource).toContain("isDesktopRuntime()");
    expect(appSource).toContain("<TerminalWorkSurface");
    expect(tabStripSource).toContain('<SquareTerminal aria-hidden="true" />');
    expect(tabStripSource).toContain("aria-pressed={props.terminalOpen}");
    expect(terminalSurfaceSource).toContain("project: props.project");
    expect(terminalSurfaceSource).toContain('class="terminal-back"');
    expect(terminalSurfaceSource).toContain("<TerminalEmulator");
    expect(terminalSurfaceSource).not.toContain("terminal-command-bar");
  });

  it("gives the terminal pane the remaining workbench height without duplicating desktop navigation", () => {
    expect(terminalStyles).toMatch(/\.terminal-work-surface\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column/);
    expect(terminalStyles).toMatch(/\.terminal-work-layout\s*\{[\s\S]*flex:\s*1 1 auto/);
    expect(terminalStyles).toMatch(/\.terminal-stage\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column/);
    expect(terminalStyles).toContain(".terminal-back { display: none !important; }");
    expect(terminalStyles).toMatch(/@media \(max-width: 720px\)[\s\S]*\.terminal-back \{ display: grid !important; \}/);
  });

  it("builds the isolated Peer QA app with a stable signing identity", () => {
    expect(packageSource).toContain('"macos:build:peer-qa": "./scripts/build-macos-signed.sh');
    expect(packageSource).not.toContain('"macos:build:peer-qa": "tauri build');
  });
});
