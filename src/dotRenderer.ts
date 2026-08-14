let vizPromise: ReturnType<typeof loadViz> | undefined;

/**
 * Render DOT with one shared Viz.js/WebAssembly instance. A failed bootstrap is
 * deliberately not cached forever: WebKit can retry after a transient memory or
 * lifecycle interruption without requiring Studio to restart.
 */
export async function renderGraphvizSvg(source: string): Promise<string> {
  const viz = await getViz();
  return viz.renderString(source, { engine: "dot", format: "svg" });
}

async function getViz() {
  vizPromise ||= loadViz().catch((error) => {
    vizPromise = undefined;
    throw error;
  });
  return vizPromise;
}

async function loadViz() {
  const { instance } = await import("@viz-js/viz");
  return instance();
}
