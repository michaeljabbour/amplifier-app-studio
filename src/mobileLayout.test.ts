import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const mobileCss = readFileSync(new URL("./mobile.css", import.meta.url), "utf8");
const settingsCss = readFileSync(new URL("./settings.css", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./components/StudioSettingsDialog.tsx", import.meta.url), "utf8");
const mobileViewportSource = readFileSync(new URL("./mobileViewport.ts", import.meta.url), "utf8");
const tabStripSource = readFileSync(new URL("./components/TabStrip.tsx", import.meta.url), "utf8");
const transcriptSource = readFileSync(new URL("./components/Transcript.tsx", import.meta.url), "utf8");
const inspectorSource = readFileSync(new URL("./components/Inspector.tsx", import.meta.url), "utf8");
const drawerSource = readFileSync(new URL("./components/SessionDrawer.tsx", import.meta.url), "utf8");
const coordinatorHomeSource = readFileSync(new URL("./components/CoordinatorHome.tsx", import.meta.url), "utf8");
const madeThemeCss = readFileSync(new URL("./madeTheme.css", import.meta.url), "utf8");

describe("mobile layout contracts", () => {
  it("exposes iOS safe-area insets without disabling user zoom", () => {
    expect(indexHtml).toContain("viewport-fit=cover");
    expect(indexHtml).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i);
  });

  it("loads the mobile contract after theme and settings styles", () => {
    expect(mainSource.indexOf('import "./mobile.css"')).toBeGreaterThan(mainSource.indexOf('import "./settings.css"'));
  });

  it("prevents focus zoom and reserves safe-area chrome", () => {
    expect(mobileCss).toMatch(/input,[\s\S]*textarea,[\s\S]*select\s*\{[\s\S]*font-size:\s*16px\s*!important/);
    expect(mainSource).toContain("captureMobileSafeAreaInsets();");
    expect(mobileViewportSource).toContain("--studio-safe-area-top");
    expect(mobileViewportSource).toContain("--studio-safe-area-bottom");
    expect(mobileViewportSource).toContain("requestAnimationFrame(capture)");
    expect(mobileViewportSource).toContain("Number.parseFloat(style.paddingTop) > 0");
    expect(mobileViewportSource).toContain("visualViewport.addEventListener(\"resize\"");
    expect(mobileViewportSource).toContain("--studio-visual-viewport-height");
    expect(mobileViewportSource).toContain("--studio-visual-offset-top");
    expect(mobileCss).toContain("calc(48px + var(--studio-safe-area-top");
    expect(mobileCss).toContain("calc(44px + var(--studio-safe-area-bottom");
  });

  it("keeps transcript, composer, and footer inside the phone viewport", () => {
    expect(mobileCss).toMatch(/body\s*\{[\s\S]*position:\s*fixed/);
    expect(mobileCss).toMatch(/\.tab-strip\s*\{[\s\S]*position:\s*fixed/);
    expect(mobileCss).toMatch(/body:has\(input:focus, textarea:focus, select:focus\) \.app-shell[\s\S]*height:\s*var\(--studio-visual-viewport-height[\s\S]*transform:\s*none/);
    expect(mobileCss).not.toMatch(/body:has\(input:focus, textarea:focus, select:focus\) \.app-shell[\s\S]*translateY\(/);
    expect(mobileCss).toMatch(/body:has\(\.home-composer textarea:focus\) \.home-conversation-intro[\s\S]*justify-content:\s*flex-start/);
    expect(mobileCss).toMatch(/\.coordinator-home,[\s\S]*\.workspace\s*\{[\s\S]*grid-row:\s*2/);
    expect(mobileCss).toMatch(/\.transcript-inner,[\s\S]*width:\s*100%/);
    expect(mobileCss).toMatch(/\.composer-actions\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
    expect(mobileCss).toMatch(/\.footer-bar\s*\{[\s\S]*position:\s*fixed[\s\S]*grid-template-columns:\s*repeat\(4/);
    expect(mobileCss).toMatch(/\.footer-project,[\s\S]*\.footer-model,[\s\S]*display:\s*none/);
  });

  it("uses compact session chrome and one native touch-scroll settings surface", () => {
    expect(mobileCss).toMatch(/\.tab-host,[\s\S]*\.tab-close\s*\{[\s\S]*display:\s*none/);
    expect(mobileCss).toMatch(/\.session-tab-shell\.active \.tab-close\s*\{[\s\S]*display:\s*grid/);
    expect(mobileCss).toMatch(/\.session-tab-shell\s*\{[\s\S]*flex:\s*1 1 168px/);
    expect(settingsCss).toMatch(/\.settings-window\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column/);
    expect(settingsCss).toMatch(/\.settings-layout\s*\{[\s\S]*flex:\s*1 1 0;[\s\S]*overflow-y:\s*auto;[\s\S]*touch-action:\s*pan-y;[\s\S]*-webkit-overflow-scrolling:\s*touch/);
    expect(settingsCss).toMatch(/\.settings-navigation\s*\{[\s\S]*position:\s*sticky/);
    expect(settingsCss).toMatch(/\.settings-content\s*\{[\s\S]*height:\s*auto;[\s\S]*overflow:\s*visible/);
    expect(settingsSource).not.toContain("settings-scroll-controls");
    expect(settingsSource).not.toContain("More&nbsp;↓");
    expect(settingsCss).toMatch(/\.settings-footer\s*\{[\s\S]*flex:\s*0 0 auto/);
  });

  it("uses one unified Amplifier Agent surface instead of a disabled Chat and Work split", () => {
    expect(tabStripSource).toContain("Amplifier Agent");
    expect(tabStripSource).not.toContain("mobile-mode-switch");
    expect(mobileCss).toContain("--mobile-header-height: 56px");
  });

  it("opens a full-screen Work hub from Activity with explicit return controls", () => {
    expect(tabStripSource).toContain('class="mobile-topbar-button mobile-work-button"');
    expect(tabStripSource).toContain('class="mobile-work-label">Work');
    expect(tabStripSource).toContain("onClick={() => props.onToggleInspector(attention().sessionId)}");
    expect(inspectorSource).toContain('aria-label="Back to session"');
    expect(inspectorSource).toContain('aria-label="Close Work"');
    expect(inspectorSource).toContain("{props.state.title}");
    expect(inspectorSource).toContain("{placement().host}");
    expect(inspectorSource).toContain("{placement().project}");
    for (const label of ["Run", "Loop", "Plan", "Setup", "Bundles", "Outputs", "Context"]) {
      expect(inspectorSource).toContain(`>${label}</button>`);
    }
    expect(mobileCss).toMatch(/\.machine-inspector,[\s\S]*top:\s*0;[\s\S]*height:\s*100dvh;[\s\S]*display:\s*flex/);
    expect(mobileCss).toMatch(/\.inspector-tabs button,[\s\S]*min-height:\s*48px/);
  });

  it("routes Android system Back through the topmost Studio overlay", () => {
    expect(appSource).toContain('import { onBackButtonPress } from "@tauri-apps/api/app"');
    expect(appSource).toContain("onBackButtonPress(() => dismissTopMobileOverlay())");
    const dismiss = appSource.slice(
      appSource.indexOf("const dismissTopMobileOverlay"),
      appSource.indexOf("createEffect(() =>", appSource.indexOf("const dismissTopMobileOverlay")),
    );
    for (const close of [
      "setStopRuntimeRequest(undefined)",
      "setStoredSessionDialog(undefined)",
      "setProviderSetupOpen(false)",
      "setCapabilitiesOpen(false)",
      "setSettingsOpen(false)",
      "setDialog(undefined)",
      "setRightOpen(false)",
      "setDrawerOpen(false)",
    ]) expect(dismiss).toContain(close);
    expect(dismiss).toContain("if (!dialogBusy()) setDialog(undefined)");
    expect(appSource).toContain("onBusyChange={setDialogBusy}");
  });

  it("keeps open-session lifecycle actions explicit and touch sized", () => {
    expect(drawerSource).toContain("props.onDetachOpen(session.guiId)");
    expect(drawerSource).toContain("props.onStopOpen(session.guiId)");
    expect(mobileCss).toMatch(/\.mobile-open-session-more\s*\{[\s\S]*width:\s*48px;[\s\S]*height:\s*52px/);
    expect(mobileCss).toMatch(/\.mobile-open-session-menu > button\s*\{[\s\S]*min-height:\s*52px/);
  });

  it("gives the transcript its own touch scroll surface and keeps jump outside it", () => {
    expect(mobileCss).toMatch(/\.session-column,[\s\S]*display:\s*flex[\s\S]*flex-direction:\s*column/);
    expect(mobileCss).toMatch(/\.transcript-frame\s*\{[\s\S]*flex:\s*1 1 auto/);
    expect(mobileCss).toMatch(/\.transcript\s*\{[\s\S]*overflow-y:\s*scroll[\s\S]*touch-action:\s*pan-y/);
    expect(mobileCss).toMatch(/body:has\(\.input-zone textarea:focus\) \.transcript\s*\{[\s\S]*touch-action:\s*none/);
    expect(transcriptSource.indexOf("</main>")).toBeLessThan(transcriptSource.indexOf('class="transcript-jump-latest"'));
    expect(transcriptSource).toContain("scrollTranscriptToLatest(scroller, latestAnchor)");
    expect(transcriptSource).toContain("onPointerDown={beginPointerPan}");
    expect(transcriptSource).toContain("onPointerMove={continuePointerPan}");
    expect(transcriptSource).toContain("setPointerCapture?.(event.pointerId)");
    expect(transcriptSource).toContain("transcriptPointerScrollTop(");
    expect(transcriptSource).toContain('addEventListener("touchstart", preserveFocusedComposer, { passive: false })');
  });

  it("does not report desktop host persistence as a mobile session error", () => {
    expect(appSource).toMatch(/async function rememberRuntimeHost[\s\S]*if \(isMobileRuntime\(\)\) return;/);
  });

  it("hydrates the real mobile compute id before checking runtime readiness", () => {
    expect(appSource).toContain("if (!isMobileRuntime()) void refreshRuntime();");
    expect(appSource).toContain('setSessionHomeHost(hosts[0]?.id || (isMobileRuntime() ? "" : "local"))');
    expect(appSource).toMatch(/void listRuntimeHosts\(\)\.then\(\(hosts\) => \{[\s\S]*void refreshRuntime\(\);/);
  });

  it("uses one legible compute-host action when mobile has no local installer", () => {
    const engineSetup = coordinatorHomeSource.slice(
      coordinatorHomeSource.indexOf("ENGINE SETUP"),
      coordinatorHomeSource.indexOf("RUNTIME UPDATE"),
    );
    expect(engineSetup).toContain("Connect compute host");
    expect(engineSetup).not.toContain("Configure bridge");
    expect(madeThemeCss).toMatch(/:root\[data-theme="made"\] \.runtime-setup-card \{[^}]*background:\s*rgba\(182,130,53,\.055\)/);
    expect(madeThemeCss).toMatch(/:root\[data-theme="made"\] \.runtime-setup-card p \{[^}]*color:\s*#605d5d/);
  });
});
