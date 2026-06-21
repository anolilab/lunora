import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Lunora E2E suite.
 *
 * The suite drives the `apps/playground` chat app against a Miniflare-backed
 * Worker — no Cloudflare account, no network. `globalSetup.ts` boots Miniflare
 * + the Vite dev server; `globalTeardown.ts` tears them down.
 *
 * Stability tactics:
 *   - `workers: 1` — DO state is shared per-namespace; parallel workers would
 *     race on channel ids, message ordering, and the `/test/reset` route.
 *   - Each test calls `await resetServer(page)` (see fixtures) to clear DO
 *     state before exercising new behaviour.
 *   - We rely on Playwright `auto-wait` selectors; explicit `waitForTimeout`
 *     calls are forbidden by lint and only appear in the scheduler test where
 *     cron timing is the point.
 *
 * Skip gate:
 *   - Set `LUNORA_E2E=skip` to short-circuit the entire run (used by CI when
 *     the suite is flaky on a given runner).
 */
const baseURL = process.env.LUNORA_E2E_BASE_URL ?? "http://localhost:5173";

const isCI = process.env.CI === "true";

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
        {
            name: "firefox",
            use: { ...devices["Desktop Firefox"] },
        },
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
