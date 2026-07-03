import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { BrowserUrlAccessIR } from "./ir";

/**
 * The `ctx.browser.&lt;method>(url, …)` navigation methods whose first argument is
 * the URL to fetch. All four take the target URL as `arguments[0]`; the
 * page-driving `page.goto(url)` low-level method has a different receiver (a
 * page handle, not `ctx.browser`) and is not matched here.
 */
const BROWSER_URL_METHODS = new Set(["content", "pdf", "scrape", "screenshot"]);

/**
 * The `ctx.browser` method name for a call whose receiver TEXT is exactly
 * `ctx.browser` and whose method is one of {@link BROWSER_URL_METHODS}, else
 * `undefined`. Matched by shape (an `import`-agnostic, fail-closed convention
 * the other feeders share), so a re-export or alias still resolves.
 */
const browserUrlMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (!BROWSER_URL_METHODS.has(method) || node.getExpression().getText() !== "ctx.browser") {
        return undefined;
    }

    return method;
};

/**
 * The IR row for a `ctx.browser.&lt;method>(url, …)` call whose navigation URL
 * (`arguments[0]`) is arg-derived and unscoped, or `undefined`.
 *
 * A URL scoped by a server-trusted `ctx.*` value (`ctx.config.baseUrl`)
 * references `ctx` and is treated as scoped, so it is not flagged.
 */
const browserUrlAccessInCall = (call: CallExpression, relativePath: string): BrowserUrlAccessIR | undefined => {
    const method = browserUrlMethod(call.getExpression());

    if (method === undefined) {
        return undefined;
    }

    const url = call.getArguments()[0];

    if (!url || !isArgumentDerived(url) || isScopedByContext(url)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber(), method };
};

/** Arg-derived, unscoped `ctx.browser.&lt;method>(url)` navigations in one source file. */
const browserUrlAccessesInSourceFile = (sourceFile: SourceFile, relativePath: string): BrowserUrlAccessIR[] => {
    const found: BrowserUrlAccessIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const row = browserUrlAccessInCall(call, relativePath);

        if (row) {
            found.push(row);
        }
    }

    return found;
};

/**
 * Discover `ctx.browser.&lt;method>(url, …)` calls in `lunora/` whose navigation
 * URL is derived from the handler's `args` with no server-side scoping — the
 * `browser_user_url_without_allowlist` lint input. `@lunora/browser` blocks
 * private/internal targets by default, but a request-supplied *public* URL can
 * still turn the headless browser into an open-proxy / SSRF tool (fetching
 * arbitrary third-party URLs, DNS-rebinding to internal hosts). The lint pairs
 * this evidence with `createBrowser` config-call evidence, suppressing findings
 * when the browser is hardened with an `allowedHosts` allowlist or `resolveDns`.
 * A fixed literal URL, or one scoped by a server-trusted `ctx.*` value, is not
 * recorded; only an arg-derived, unscoped URL (directly, or through one local
 * `const` hop) reaches here.
 */
const discoverBrowserUrlAccesses = (project: Project, lunoraDirectory: string): BrowserUrlAccessIR[] => {
    const rows: BrowserUrlAccessIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        rows.push(...browserUrlAccessesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return rows;
};

export default discoverBrowserUrlAccesses;
