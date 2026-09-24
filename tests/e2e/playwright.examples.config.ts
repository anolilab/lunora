import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { CLOUDFLARE_AUTH_AVAILABLE, EXAMPLES, installDevVars } from "./examples-setup";

/**
 * Browser-level smoke suite for `examples/*`.
 *
 * Separate from the playground config on purpose: this one boots five apps, not
 * one, and Playwright's own `webServer` array already does the spawn/wait/kill
 * that `globalSetup.ts` hand-rolls for the playground. The only setup left is
 * writing a deterministic `.dev.vars` per example, which happens at import time
 * below — so this config declares no `globalSetup`/`globalTeardown` at all.
 *
 * The examples ship no `/test/reset` route, so nothing wipes state between
 * runs. Every spec therefore creates its own uniquely-named rows and asserts on
 * those rather than on an empty board — which is what a real user's second visit
 * looks like anyway.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const isCI = process.env.CI === "true";

installDevVars();

/**
 * Boot only the servers the selected projects need.
 *
 * Each example is a Vite process plus its own workerd; starting all five when
 * `--project=chess` was asked for costs about a gigabyte and gets the run OOM
 * killed on a modest machine. Playwright has no per-project `webServer`, so the
 * selection is read off the command line.
 */
const selected = process.argv.reduce<string[]>((names, argument, index) => {
    if (argument === "--project" || argument === "-p") {
        const next = process.argv[index + 1];

        return next ? [...names, next] : names;
    }

    if (argument.startsWith("--project=")) {
        return [...names, argument.slice("--project=".length)];
    }

    return names;
}, []);

const chosen = selected.length > 0 ? EXAMPLES.filter(({ name }) => selected.includes(name)) : EXAMPLES;

/**
 * Which examples get a dev server.
 *
 * The ones needing a Cloudflare account cannot boot without one — the Workers
 * AI binding is proxied to Cloudflare even under `vite dev`, and a failed
 * `webServer` fails the whole run rather than one project. So their server is
 * left unstarted, but their PROJECT stays in the list below: the spec skips
 * itself under the same condition, which puts the omission in the reporter's
 * skip count instead of in a `console.warn` nothing reads.
 */
const bootable = chosen.filter((example) => !("needsCloudflareAuth" in example) || CLOUDFLARE_AUTH_AVAILABLE);

export default defineConfig({
    expect: { timeout: 10_000 },
    forbidOnly: isCI,
    // One Vite + workerd tree per example is already five processes; running the
    // specs in parallel on top of that starves slower runners.
    fullyParallel: false,
    outputDir: "./test-results-examples",
    projects: chosen.map(({ name, port }) => ({
        name,
        testMatch: `${name}.spec.ts`,
        use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${port}` },
    })),
    reporter: isCI ? [["github"], ["html", { open: "never", outputFolder: "./playwright-report-examples" }]] : [["list"]],
    retries: isCI ? 2 : 0,
    testDir: "./examples",
    // A cold example pays Vite dep-optimisation on the first browser request;
    // only the first test of each project sees it, but it can exceed 30s.
    timeout: 150_000,
    use: { actionTimeout: 10_000, navigationTimeout: 90_000, screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: bootable.map(({ name, port }) => ({
        command: `pnpm exec vite --port ${port} --strictPort`,
        cwd: join(ROOT, "examples", name),
        reuseExistingServer: !isCI,
        // A cold boot pays Vite dep-optimisation plus the first workerd init.
        timeout: 180_000,
        url: `http://localhost:${port}/`,
    })),
    workers: 1,
});
