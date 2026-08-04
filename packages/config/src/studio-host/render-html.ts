import type { StudioHtmlConfig } from "./types";

/**
 * Serialise a string for safe inline-script embedding: JSON-encode it, then
 * neutralise `<` so a `</script>` (or comment opener) in the value can't end the
 * tag early.
 */
const forInlineScript = (value: string): string => JSON.stringify(value).replaceAll("<", String.raw`\u003c`);

/** Escape a value for embedding inside a double-quoted HTML attribute. */
const forAttribute = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * Render the single-page document that boots the studio. Emitted verbatim —
 * never through a bundler/transform — so the studio stays a static tool,
 * decoupled from the host project's build. A small inline script publishes the
 * per-server config on `globalThis` before the bundle loads: the mount basepath
 * (so the router stays under its mount), the admin token when present (so the
 * studio auto-authenticates instead of prompting), and an editable flag when the
 * host is a loopback dev server (so the data browser allows edits).
 */
const renderStudioHtml = (config: StudioHtmlConfig): string => {
    const settings = [`window.__LUNORA_BASE_PATH__=${forInlineScript(config.basePath)};`];

    if (config.adminToken !== undefined && config.adminToken !== "") {
        settings.push(`window.__LUNORA_ADMIN_TOKEN__=${forInlineScript(config.adminToken)};`);
    }

    if (config.dataEditable === true) {
        // eslint-disable-next-line no-secrets/no-secrets -- a static JS assignment string, not a credential
        settings.push("window.__LUNORA_DATA_EDITABLE__=true;");
    }

    if (config.runAsIdentity === true) {
        // eslint-disable-next-line no-secrets/no-secrets -- a static JS assignment string, not a credential
        settings.push("window.__LUNORA_RUN_AS_IDENTITY__=true;");
    }

    if (config.schemaEditable === true) {
        // eslint-disable-next-line no-secrets/no-secrets -- a static JS assignment string, not a credential
        settings.push("window.__LUNORA_SCHEMA_EDITABLE__=true;");
    }

    if (config.rulesInstalled === false) {
        // Only emitted when explicitly missing, so a static deploy (flag unset) never nags.
        // eslint-disable-next-line no-secrets/no-secrets -- a static JS assignment string, not a credential
        settings.push("window.__LUNORA_RULES_INSTALLED__=false;");
    }

    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Lunora Studio</title>
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

export default renderStudioHtml;
