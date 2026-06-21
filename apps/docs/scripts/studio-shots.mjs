/**
 * Capture Lunora Studio screenshots for the /studio landing page.
 *
 * Drives a running Studio dev server with Playwright, switches it to dark mode,
 * visits each view via the sidebar, and writes PNGs to src/assets/studio/dark/.
 *
 * Playwright isn't a dependency of apps/docs, so we resolve it straight out of
 * the pnpm store (it ships with @lunora/testing + @lunora/browser).
 *
 * Usage:
 *   STUDIO_URL=http://localhost:5174/__lunora node scripts/studio-shots.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pnpmDir = fileURLToPath(new URL("../../../node_modules/.pnpm/", import.meta.url));
const pwPkg = readdirSync(pnpmDir)
    .filter((d) => /^playwright@/.test(d))
    .sort()
    .pop();
const { chromium } = require(`${pnpmDir}${pwPkg}/node_modules/playwright`);

const STUDIO_URL = process.env.STUDIO_URL ?? "http://localhost:5174/__lunora";
const OUT_DIR = fileURLToPath(new URL("../src/assets/studio/dark/", import.meta.url));

const SHOTS = [
    { label: "Home", name: "home" },
    { label: "Dashboards", name: "dashboards" },
    { label: "Data", name: "data" },
    { label: "SQL editor", name: "sql-editor" },
    { label: "Schema", name: "schema" },
    { label: "Time Travel", name: "time-travel" },
    { label: "Workflows", name: "workflows" },
];

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { height: 900, width: 1440 } });

await page.goto(STUDIO_URL, { timeout: 30000, waitUntil: "networkidle" });
await page.locator(".lunora-studio-root").first().waitFor({ timeout: 30000 });

// Switch to dark mode (the root toggles a `.dark` class; default is light).
const root = page.locator(".lunora-studio-root").first();
const isDark = await root.evaluate((el) => el.classList.contains("dark"));

if (!isDark) {
    await page.locator('[data-testid="dash-app-theme"]').first().click();
    await page.waitForTimeout(400);
}

// Strip the "Lunora AI rules aren't installed" dev nag banner — it's a
// short, full-width bar and has no place in marketing screenshots.
const stripBanner = () =>
    page.evaluate(() => {
        const bar = [...document.querySelectorAll("div,section,header")].find((el) => {
            const r = el.getBoundingClientRect();

            return /AI rules aren.t installed/i.test(el.textContent ?? "") && r.width > 600 && r.height > 0 && r.height < 80;
        });

        bar?.remove();
    });

for (const shot of SHOTS) {
    try {
        await page.getByText(shot.label, { exact: true }).first().click({ timeout: 10000 });
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(900);
        await stripBanner();
        await page.screenshot({ path: `${OUT_DIR}${shot.name}.png` });
        console.log(`captured ${shot.name}`);
    } catch (error) {
        console.warn(`skipped ${shot.name}: ${error.message.split("\n")[0]}`);
    }
}

await browser.close();
console.log(`done → ${OUT_DIR}`);
