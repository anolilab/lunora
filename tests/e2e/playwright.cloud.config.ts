import { defineConfig, devices } from "@playwright/test";

import { CLOUD_BASE_URL, CLOUD_PORT, CLOUD_ROOT, CLOUD_STORAGE_STATE, cloudSkipReason } from "./cloud-setup";

/**
 * Browser suite for the Lunora Cloud control plane (`apps/cloud`).
 *
 * Separate from the playground config for the same reason `playwright.examples.config.ts`
 * is: this drives a different app on a different origin, and Playwright's own
 * `webServer` already does the spawn/wait/kill that the playground's `globalSetup.ts`
 * hand-rolls. What is left is seeding — a cold control plane has no cell, and with no
 * cell nothing else works — which `cloud-seed.ts` does after the server is up
 * (plugin setup, `webServer` included, runs before `globalSetup`).
 *
 * When the app cannot boot (it is not in this checkout, or its `.dev.vars` is missing
 * `AUTH_SECRET` / `LUNORA_ADMIN_TOKEN`) the suite reports SKIPPED with the reason
 * instead of failing: unlike the playground, whose harness owns every input it needs,
 * this one depends on secrets a checkout may legitimately not have. Everything past
 * boot still fails loudly.
 */
const isCI = process.env.CI === "true";

const skip = cloudSkipReason();

if (skip !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[cloud-e2e] skipping the control-plane suite — ${skip}`);
}

export default defineConfig({
    expect: { timeout: 15_000 },
    forbidOnly: isCI,
    fullyParallel: false,
    globalSetup: "./cloud-seed.ts",
    outputDir: "./test-results-cloud",
    projects: [{ name: "cloud", use: { ...devices["Desktop Chrome"] } }],
    reporter: isCI ? [["github"], ["html", { open: "never", outputFolder: "./playwright-report-cloud" }]] : [["list"]],
    retries: isCI ? 2 : 0,
    testDir: "./cloud",
    // The studio is server-rendered by TanStack Start on top of the Cloudflare
    // plugin: the first request to a route pays Vite's SSR transform for it, which
    // is well past the 30s the playground suite uses.
    timeout: 180_000,
    use: {
        actionTimeout: 15_000,
        baseURL: CLOUD_BASE_URL,
        navigationTimeout: 120_000,
        screenshot: "only-on-failure",
        // Every test starts from the one session `cloud-seed.ts` established. Signing
        // in per test instead trips better-auth's per-IP throttle on `/sign-in/email`
        // partway through the file, which reads as a broken test and is not one.
        storageState: CLOUD_STORAGE_STATE,
        trace: "retain-on-failure",
    },
    webServer:
        skip === undefined
            ? [
                  {
                      command: `pnpm exec vite --port ${String(CLOUD_PORT)} --strictPort`,
                      cwd: CLOUD_ROOT,
                      reuseExistingServer: !isCI,
                      // Cold boot is codegen + Vite dep-optimisation + the first
                      // workerd init, on an app with 20-odd routes.
                      timeout: 300_000,
                      url: CLOUD_BASE_URL,
                  },
              ]
            : [],
    workers: 1,
});
