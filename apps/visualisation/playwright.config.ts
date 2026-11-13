import { defineConfig, devices } from "@playwright/test";

/** Its own port, so a gateway running on 8080 during development does not get in the way. */
const PORT = Number(process.env.E2E_PORT ?? 8090);
/** The demo application Syn_Visu_Demo, running on the local user-mode runtime (ADR 0020). */
const AMS_NET_ID = process.env.E2E_AMS_NET_ID ?? "127.0.0.1.1.1";
const ADS_PORT = Number(process.env.E2E_ADS_PORT ?? 852);

/**
 * Browser tests of the built visualisation (`pnpm test:e2e` builds it first). The gateway reads the demo application
 * Syn_Visu_Demo, which must be running (`docs/demo-plc.md`), and serves `dist`, as on an IPC. On Windows the installed
 * Edge is used, so no browser download is needed; elsewhere, or with `E2E_CHANNEL=chromium`, Playwright's own Chromium (`pnpm exec playwright install chromium`).
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    channel: process.env.E2E_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined),
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node ../gateway/node_modules/tsx/dist/cli.mjs ../gateway/src/main.ts --ams-net-id ${AMS_NET_ID} --ads-port ${ADS_PORT} --allow-write --port ${PORT} --host 127.0.0.1 --static-dir dist`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
