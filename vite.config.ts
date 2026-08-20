import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";
import { assertSafeBridgeBuild } from "./scripts/build-security.mjs";

export default defineConfig(({ command, mode }) => {
  const environment = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  assertSafeBridgeBuild(command, environment);
  return {
    plugins: [solid()],
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:4317",
          ws: true,
        },
      },
    },
    build: { target: "es2022" },
  };
});
