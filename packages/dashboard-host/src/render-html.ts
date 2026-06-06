import type { DashboardHtmlConfig } from "./types.js";

/**
 * Serialise a string for safe inline-script embedding: JSON-encode it, then
 * neutralise `&lt;` so a `&lt;/script>` (or comment opener) in the value can't end the
 * tag early.
 */
const forInlineScript = (value: string): string => JSON.stringify(value).replaceAll("<", String.raw`\u003c`);

/** Escape a value for embedding inside a double-quoted HTML attribute. */
const forAttribute = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * Render the single-page document that boots the dashboard. Emitted verbatim —
 * never through a bundler/transform — so the dashboard stays a static tool,
 * decoupled from the host project's build. A small inline script publishes the
 * per-server config on `globalThis` before the bundle loads: the mount basepath
 * (so the router stays under its mount) and, when present, the admin token (so
 * the dashboard auto-authenticates instead of prompting).
 */
const renderDashboardHtml = (config: DashboardHtmlConfig): string => {
    const settings = [`window.__CIRRUS_BASE_PATH__=${forInlineScript(config.basePath)};`];

    if (config.adminToken !== undefined && config.adminToken !== "") {
        settings.push(`window.__CIRRUS_ADMIN_TOKEN__=${forInlineScript(config.adminToken)};`);
    }

    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Cirrus Dashboard</title>
        <script>${settings.join("")}</script>
        <link rel="stylesheet" href="${forAttribute(config.styleHref)}" />
    </head>
    <body>
        <div id="root"></div>
        <script type="module" src="${forAttribute(config.scriptSrc)}"></script>
    </body>
</html>
`;
};

export default renderDashboardHtml;
