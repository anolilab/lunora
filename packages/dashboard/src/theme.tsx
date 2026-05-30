import type { ReactElement } from "react";

/** Root class the batteries-included app sets so the styles below stay scoped. */
export const DASHBOARD_ROOT_CLASS = "cirrus-dashboard-root";

/**
 * Scoped dashboard stylesheet. Every rule is prefixed with
 * `.cirrus-dashboard-root` so mounting the dashboard never leaks styles into a
 * host page, and panels composed under a host's own provider (without this
 * root class) stay unstyled. Targets semantic elements (`table`, `input`,
 * `button`) plus a few `data-testid` hooks the shell owns — no component markup
 * or test ids change. A `prefers-color-scheme: dark` block flips the CSS
 * variables for dark mode.
 */
const CSS = `
.${DASHBOARD_ROOT_CLASS} {
    --c-bg: #ffffff;
    --c-fg: #1f2328;
    --c-muted: #6e7781;
    --c-border: #d0d7de;
    --c-surface: #f6f8fa;
    --c-accent: #0969da;
    --c-accent-fg: #ffffff;
    --c-danger: #cf222e;
    --c-radius: 6px;
    --c-gap: 12px;

    color: var(--c-fg);
    background: var(--c-bg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    min-height: 100vh;
    box-sizing: border-box;
}

.${DASHBOARD_ROOT_CLASS} *,
.${DASHBOARD_ROOT_CLASS} *::before,
.${DASHBOARD_ROOT_CLASS} *::after {
    box-sizing: inherit;
}

/* Header */
.${DASHBOARD_ROOT_CLASS} [data-testid="dash-app-header"] {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--c-gap);
    padding: 12px 16px;
    border-bottom: 1px solid var(--c-border);
    background: var(--c-surface);
    position: sticky;
    top: 0;
    z-index: 1;
}

.${DASHBOARD_ROOT_CLASS} [data-testid="dash-app-header"] strong {
    font-size: 16px;
    margin-right: auto;
}

/* Tabs */
.${DASHBOARD_ROOT_CLASS} [data-testid="dash-tabs"] {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px 16px 0;
    border-bottom: 1px solid var(--c-border);
}

.${DASHBOARD_ROOT_CLASS} [data-testid="dash-tabs"] [role="tab"] {
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: var(--c-radius) var(--c-radius) 0 0;
    background: transparent;
    color: var(--c-muted);
    padding: 6px 12px;
    cursor: pointer;
    font: inherit;
}

.${DASHBOARD_ROOT_CLASS} [data-testid="dash-tabs"] [role="tab"]:hover {
    color: var(--c-fg);
    background: var(--c-surface);
}

.${DASHBOARD_ROOT_CLASS} [data-testid="dash-tabs"] [role="tab"][aria-selected="true"] {
    color: var(--c-fg);
    background: var(--c-bg);
    border-color: var(--c-border);
    margin-bottom: -1px;
    font-weight: 600;
}

/* Panel surface */
.${DASHBOARD_ROOT_CLASS} [data-testid="dash-panel"] {
    padding: 16px;
}

/* Controls */
.${DASHBOARD_ROOT_CLASS} input,
.${DASHBOARD_ROOT_CLASS} select,
.${DASHBOARD_ROOT_CLASS} textarea {
    font: inherit;
    color: inherit;
    background: var(--c-bg);
    border: 1px solid var(--c-border);
    border-radius: var(--c-radius);
    padding: 5px 8px;
}

.${DASHBOARD_ROOT_CLASS} input:focus,
.${DASHBOARD_ROOT_CLASS} select:focus,
.${DASHBOARD_ROOT_CLASS} textarea:focus {
    outline: 2px solid var(--c-accent);
    outline-offset: -1px;
    border-color: var(--c-accent);
}

.${DASHBOARD_ROOT_CLASS} button {
    font: inherit;
    cursor: pointer;
    background: var(--c-surface);
    color: var(--c-fg);
    border: 1px solid var(--c-border);
    border-radius: var(--c-radius);
    padding: 5px 12px;
}

.${DASHBOARD_ROOT_CLASS} button:hover:not(:disabled) {
    background: var(--c-border);
}

.${DASHBOARD_ROOT_CLASS} button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}

/* Confirm/cancel + danger affordances */
.${DASHBOARD_ROOT_CLASS} [data-testid$="-confirm"] {
    background: var(--c-danger);
    color: var(--c-accent-fg);
    border-color: var(--c-danger);
}

/* Toolbars: the leading <div> inside each panel groups its controls */
.${DASHBOARD_ROOT_CLASS} [data-testid^="cirrus-"] > div:first-child {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: var(--c-gap);
}

/* Tables */
.${DASHBOARD_ROOT_CLASS} table {
    border-collapse: collapse;
    width: 100%;
    font-variant-numeric: tabular-nums;
}

.${DASHBOARD_ROOT_CLASS} th,
.${DASHBOARD_ROOT_CLASS} td {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid var(--c-border);
}

.${DASHBOARD_ROOT_CLASS} thead th {
    background: var(--c-surface);
    position: sticky;
    top: 0;
    font-weight: 600;
}

.${DASHBOARD_ROOT_CLASS} tbody tr:hover {
    background: var(--c-surface);
}

/* Definition lists (metrics) */
.${DASHBOARD_ROOT_CLASS} dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    align-items: baseline;
}

.${DASHBOARD_ROOT_CLASS} dt {
    color: var(--c-muted);
}

.${DASHBOARD_ROOT_CLASS} dd {
    margin: 0;
}

/* Error / alert text */
.${DASHBOARD_ROOT_CLASS} [role="alert"] {
    color: var(--c-danger);
}

/* Code / NDJSON blobs */
.${DASHBOARD_ROOT_CLASS} pre {
    background: var(--c-surface);
    border: 1px solid var(--c-border);
    border-radius: var(--c-radius);
    padding: 10px;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* Narrow viewports: stack the header, tighten padding, let tables scroll */
@media (max-width: 640px) {
    .${DASHBOARD_ROOT_CLASS} [data-testid="dash-app-header"] {
        align-items: stretch;
        flex-direction: column;
    }

    .${DASHBOARD_ROOT_CLASS} [data-testid="dash-app-header"] strong {
        margin-right: 0;
    }

    .${DASHBOARD_ROOT_CLASS} [data-testid="dash-panel"] {
        padding: 12px 8px;
        overflow-x: auto;
    }
}

@media (prefers-color-scheme: dark) {
    .${DASHBOARD_ROOT_CLASS} {
        --c-bg: #0d1117;
        --c-fg: #e6edf3;
        --c-muted: #8b949e;
        --c-border: #30363d;
        --c-surface: #161b22;
        --c-accent: #4493f8;
        --c-accent-fg: #ffffff;
        --c-danger: #f85149;
    }
}
`;

/**
 * Injects the scoped dashboard stylesheet. Rendered once by the batteries-
 * included {@link DashboardApp}; a stable `data-testid` makes it assertable and
 * keeps React from duplicating it. Consumers composing panels by hand can render
 * this under a `.${DASHBOARD_ROOT_CLASS}` wrapper to opt in.
 */
export function DashboardStyles(): ReactElement {
    // eslint-disable-next-line react/no-danger -- a static, in-package stylesheet string; no user input.
    return <style data-testid="dash-styles" dangerouslySetInnerHTML={{ __html: CSS }} />;
}
