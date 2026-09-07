import { existsSync } from "node:fs";

import { defineConfig, devices, firefox } from "@playwright/test";

/**
 * Playwright config for the Lunora E2E suite.
 *
 * The suite drives the `apps/playground` chat app against a Miniflare-backed
 * Worker — no Cloudflare account, no network. `globalSetup.ts` boots Miniflare
 * + the Vite dev server; `globalTeardown.ts` tears them down.
 *
 * Stability tactics:
 *   - `workers: 1` / `fullyParallel: false` — every spec talks to ONE shared
 *     backend (one Vite worker, one D1, shared DO namespaces) and each test
 *     starts with `/test/reset` truncating that shared D1. Parallel workers
 *     would race each other's resets and channel lists; this is the stability
 *     boundary, not a workaround.
 *   - Each test calls `await resetServer()` (see fixtures). That clears D1 and
 *     ONLY D1 — Durable Object state is not reset. Order-independence for
 *     shard-local rows comes from each spec minting its own channel, which is
 *     the guarantee to preserve when adding one.
 *   - We rely on Playwright auto-wait selectors; explicit `waitForTimeout`
 *     calls are forbidden by convention and only appear where wall-clock time
 *     is itself under test (scheduler delay, signed-URL expiry).
 */
const baseURL = process.env.LUNORA_E2E_BASE_URL ?? "http://localhost:5173";

const isCI = process.env.CI === "true";

/**
 * Firefox is part of the CI matrix (`playwright install chromium firefox` in
 * the workflow), but plenty of dev machines/runners only provision Chromium.
 * A missing browser binary used to hard-fail every Firefox test at launch —
 * one of the "suite flakes on some runners" modes the old skip hatch papered
 * over. Detect the executable and drop the project (loudly) instead.
 */
const firefoxAvailable = ((): boolean => {
    try {
        return existsSync(firefox.executablePath());
    } catch {
        return false;
    }
})();

if (!firefoxAvailable) {
    // eslint-disable-next-line no-console
    console.warn("[e2e] Firefox is not installed — running Chromium only. Run `playwright install firefox` for the full matrix (CI does).");
}

export default defineConfig({
    expect: {
        timeout: 5000,
    },
    forbidOnly: isCI,
    fullyParallel: false,
    globalSetup: "./globalSetup.ts",
    globalTeardown: "./globalTeardown.ts",
    outputDir: "./test-results",
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
        ...(firefoxAvailable
            ? [
                  {
                      name: "firefox",
                      use: { ...devices["Desktop Firefox"] },
                  },
              ]
            : []),
    ],
    reporter: isCI
        ? [["github"], ["html", { open: "never", outputFolder: "./playwright-report" }]]
        : [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
    retries: isCI ? 2 : 0,
    testDir: "./tests",
    timeout: 30_000,
    use: {
        actionTimeout: 5000,
        baseURL,
        navigationTimeout: 10_000,
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
        video: "retain-on-failure",
    },
    workers: 1,
});
