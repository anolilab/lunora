import { defineConfig, devices } from "@playwright/test";

import { devPortsFor, shiftedPort } from "../../shared/dev-ports";

/**
 * Browser smoke for the SaaS kit (`templates/saas`): sign up → create an
 * organization → invite → accept, against the template as this checkout has it.
 *
 * Separate from the playground and examples configs because the thing under
 * test is not a workspace: `saas-app.mjs` materializes the template first, then
 * Vite serves it. Its own config also keeps the kit's cold boot (Vite
 * dep-optimisation of React, TanStack Start, better-auth and Stripe, plus the
 * first workerd init) out of the other suites' budgets.
 *
 * 5281 is not in `shared/dev-ports.ts`'s pinned list, and does not need to be:
 * its distance to every pinned base is not a multiple of the 200-port offset
 * stride, and no blocked port sits a stride multiple above it, so every
 * checkout's shifted copy stays distinct and loadable.
 */
const port = shiftedPort(5281, devPortsFor(process.env));
const baseURL = `http://localhost:${String(port)}`;
const isCI = process.env.CI === "true";

export default defineConfig({
    expect: { timeout: 15_000 },
    forbidOnly: isCI,
    fullyParallel: false,
    outputDir: "./test-results-saas",
    projects: [{ name: "saas", use: { ...devices["Desktop Chrome"], baseURL } }],
    reporter: isCI ? [["github"], ["html", { open: "never", outputFolder: "./playwright-report-saas" }]] : [["list"]],
    retries: isCI ? 2 : 0,
    testDir: "./saas",
    // The first page pays Vite dep-optimisation on a cold cache.
    timeout: 180_000,
    use: { actionTimeout: 15_000, navigationTimeout: 120_000, screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: {
        command: `node saas-app.mjs ${String(port)} && cd .saas-app && ./node_modules/.bin/vite --port ${String(port)} --strictPort`,
        // A server left over from another run would be serving a stale copy of the template.
        reuseExistingServer: false,
        timeout: 240_000,
        url: `${baseURL}/`,
    },
    workers: 1,
});
