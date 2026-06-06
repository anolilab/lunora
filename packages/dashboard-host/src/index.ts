/**
 * `@cirrus/dashboard-host` — internal, build-time-shared helpers for hosting the
 * prebuilt `@cirrus/dashboard` SPA during local dev.
 *
 * Two surfaces inline this code so the dev dashboard behaves identically
 * regardless of how the project is run:
 * - `@cirrus/vite` serves the dashboard from a Vite middleware at `/__cirrus`.
 * - `@cirrus/cli` (`cirrus dev`) serves it from a standalone Node HTTP server.
 *
 * Each owns its own transport (Connect middleware vs `node:http`) and routing;
 * the genuinely shared parts live here: render the host HTML with per-server
 * config injected, resolve the admin token the same way the worker does, and
 * load the prebuilt asset bytes.
 */
export { parseDevVariable, resolveAdminToken } from "./admin-token.js";
export { default as loadDashboardAssets } from "./assets.js";
export { default as renderDashboardHtml } from "./render-html.js";
export type { DashboardAssets, DashboardHtmlConfig, WarnLogger } from "./types.js";
