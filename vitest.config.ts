import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The same JSX transform the application build uses.
  //
  // tsconfig sets `jsx: "preserve"` because vite-plugin-solid owns that transform, so a test
  // config without the plugin left JSX in the source Vitest parsed. Vitest 3 tolerated it;
  // Vitest 4's import analysis rejects it outright ("invalid JS syntax ... do not set jsx to
  // preserve"). Keeping the two configs in step is the actual fix -- they were describing
  // different pipelines for the same files.
  plugins: [solid()],
  test: {
    // Individual suites opt into jsdom with `// @vitest-environment jsdom`. With the plugin
    // present, solid-js resolves to its browser build and touches `window` at import time, so a
    // suite that imports a component needs a DOM even when it only calls pure functions.
    environment: "node",
  },
});
