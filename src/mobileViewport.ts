type StyleReader = (element: Element) => Pick<CSSStyleDeclaration, "paddingTop" | "paddingBottom">;

/**
 * iOS WKWebView can report safe-area env() values as zero after focusing a
 * field. Capture the native insets before focus so fixed app chrome does not
 * jump underneath the status bar or home indicator while the keyboard is up.
 */
export function captureMobileSafeAreaInsets(
  doc: Document = document,
  readStyle: StyleReader = (element) => getComputedStyle(element),
): void {
  if (!doc.body) return;

  const capture = () => {
    const probe = doc.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = [
      "position:fixed",
      "visibility:hidden",
      "pointer-events:none",
      "padding-top:env(safe-area-inset-top, 0px)",
      "padding-bottom:env(safe-area-inset-bottom, 0px)",
    ].join(";");
    doc.body.appendChild(probe);

    const style = readStyle(probe);
    if (Number.parseFloat(style.paddingTop) > 0) {
      doc.documentElement.style.setProperty("--studio-safe-area-top", style.paddingTop);
    }
    if (Number.parseFloat(style.paddingBottom) > 0) {
      doc.documentElement.style.setProperty("--studio-safe-area-bottom", style.paddingBottom);
    }
    probe.remove();
  };

  // The first WKWebView style pass can still report zero. Preserve the env()
  // fallback, then snapshot again after the native viewport has painted.
  capture();
  doc.defaultView?.requestAnimationFrame(() => {
    doc.defaultView?.requestAnimationFrame(capture);
  });

  // WKWebView keeps a layout viewport behind the software keyboard and pans
  // that viewport to reveal the focused field. Mirror the *visible* viewport
  // into CSS so the whole phone shell (header, content, and composer) can stay
  // inside the portion of the screen that is actually usable.
  const visualViewport = doc.defaultView?.visualViewport;
  if (visualViewport) {
    const syncVisualViewport = () => {
      doc.documentElement.style.setProperty(
        "--studio-visual-viewport-height",
        `${Math.round(visualViewport.height)}px`,
      );
      doc.documentElement.style.setProperty(
        "--studio-visual-offset-top",
        `${Math.max(0, Math.round(visualViewport.offsetTop))}px`,
      );
    };

    syncVisualViewport();
    visualViewport.addEventListener("resize", syncVisualViewport);
    visualViewport.addEventListener("scroll", syncVisualViewport);
  }
}
