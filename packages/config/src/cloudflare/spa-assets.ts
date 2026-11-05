/**
 * How Lunora routes a single-page app (`not_found_handling:
 * "single-page-application"`) through Workers Static Assets.
 *
 * Once `run_worker_first` is a list, Cloudflare keeps the SPA fallback for every
 * request no rule names, fetches and POSTs included: the router asks the asset
 * worker's `canFetch`, which keeps `not_found_handling` whenever static routing
 * is configured (`has_static_routing`), so the request gets `index.html` and the
 * Worker never runs (workers-sdk `router-worker/src/worker.ts`,
 * `asset-worker/src/handler.ts` `canFetch`). A list that names only the routes
 * Lunora can see therefore sends a webhook mounted on a Hono `httpRouter`, or a
 * computed auth `basePath`, to `index.html`.
 *
 * So an SPA with an assets binding runs the Worker first for everything (`/*`)
 * and exempts the static output it can name. The Worker serves what it does not
 * route from that binding: a real file as is, the SPA shell for a page
 * navigation, and its own 404 for anything else (`spaAssets` in
 * `@lunora/runtime`). Without a binding the Worker cannot reach the shell, so
 * the narrow list stays.
 */
import { readdirSync } from "node:fs";

import { isPlainObject } from "../../../../shared/is-plain-object";
import join from "../path";

/**
 * Directories bundlers fill with content-hashed files (Vite, Rsbuild, Astro).
 * Exempting one that a project does not have costs nothing: a negative rule only
 * sends its paths to the assets, which still answer a miss with the SPA shell.
 */
const HASHED_DIRECTORIES: ReadonlyArray<string> = ["assets", "static", "_astro"];

/** Files Cloudflare reads as configuration and never serves. */
const ASSET_CONFIG_FILES: ReadonlySet<string> = new Set(["_headers", "_redirects", "_routes.json"]);

/** A name a rule can hold as written: no `*`, `!`, space or other character a rule pattern would read. */
const PLAIN_NAME = /^[\w.~@%+-]+$/u;

/**
 * The binding an `assets` block exposes to the Worker when it falls back to a
 * single-page app, else `undefined`. The one decision reconcile (`/*` list) and
 * codegen (`spaAssets` wiring) must make the same way.
 */
const spaAssetsBinding = (assets: unknown): string | undefined => {
    if (!isPlainObject(assets) || assets["not_found_handling"] !== "single-page-application") {
        return undefined;
    }

    const { binding } = assets;

    return typeof binding === "string" && binding !== "" ? binding : undefined;
};

/**
 * The paths a build copies verbatim from `public/`, as rules: a directory as
 * `/<name>/*`, a file as `/<name>`. Read from the source folder rather than the
 * build output, so dev and deploy write the same list.
 */
const publicAssetPaths = (projectRoot: string): string[] => {
    try {
        return readdirSync(join(projectRoot, "public"), { withFileTypes: true })
            .filter((entry) => PLAIN_NAME.test(entry.name) && !ASSET_CONFIG_FILES.has(entry.name))
            .map((entry) => (entry.isDirectory() ? `/${entry.name}/*` : `/${entry.name}`));
    } catch {
        return [];
    }
};

/** The static paths an SPA list exempts from the Worker, before the Worker's own routes are taken out. */
const spaStaticPaths = (projectRoot: string): string[] => [...HASHED_DIRECTORIES.map((directory) => `/${directory}/*`), ...publicAssetPaths(projectRoot)];

export { spaAssetsBinding, spaStaticPaths };
