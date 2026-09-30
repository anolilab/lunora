/**
 * Managed-cloud deploy client for the `lunora cloud` command group. The one
 * `lunora` binary can ship to the managed platform (Lunora Cloud control plane,
 * `POST /v1/*`) as well as run the self-host wrangler flow. This is the thin
 * HTTP client for that control-plane API: POST the prebuilt bundle + manifest
 * with the org deploy key and consume the NDJSON progress stream; roll back a
 * release. Pure over an injected `fetch`, so it is unit-testable, and it shares
 * the wire contract with the control plane's own `apps/cloud` client. Also walks
 * the app's static assets into the upload body ({@link collectAssets}).
 */

import { existsSync, readFileSync, statSync } from "node:fs";

import type { BindingRequirement } from "@lunora/config/cloudflare";
import { matcher, walkSync } from "@visulima/fs";
import { dirname, join, relative, resolve } from "@visulima/path";

type DeployEvent = Record<string, unknown>;

// The next three mirror `apps/cloud/src/provision-contract.ts` — the CLI cannot
// import that private app. Change both together.

/** What the deploy request carries about the Worker's needs. */
interface DeployManifest {
    /** Every binding the Worker reads off `env`, as `buildBindingManifest` lists them. */
    bindings: BindingRequirement[];
    /** `compatibility_date`; the platform default applies when absent. */
    compatibilityDate?: string;
    /** `compatibility_flags`; the platform default (`["nodejs_compat"]`) applies when absent. */
    compatibilityFlags?: string[];
}

/** One static file, keyed by its URL path (`/index.html`), content base64-encoded. */
interface AssetFile {
    content: string;
    path: string;
}

/** The static files behind an `assets` binding, plus the subset of wrangler's `assets` config that changes serving. */
interface AssetsUpload {
    config?: {
        html_handling?: "auto-trailing-slash" | "drop-trailing-slash" | "force-trailing-slash" | "none";
        not_found_handling?: "404-page" | "none" | "single-page-application";
        run_worker_first?: boolean | string[];
    };
    files: AssetFile[];
}

interface DeployToCloudOptions {
    apiUrl: string;
    assets?: AssetsUpload;
    branch?: string;
    /** Base64-encoded prebuilt worker module (the app's Vite build output). */
    bundle: string;
    cronSpecs?: string[];
    deployKey: string;
    fetch?: typeof globalThis.fetch;
    kind?: "dev" | "preview" | "production";
    manifest: DeployManifest;
    projectId: string; // secret-scanner:allow -- domain field name
    scriptName: string;
}

interface DeployResult {
    status: string;
}

interface RollbackOptions {
    apiUrl: string;
    deployKey: string;
    deploymentId: string;
    fetch?: typeof globalThis.fetch;
    organizationId: string;
}

const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

/** `POST /v1/deployments/rollback` — swap the project's stable URL to a retained release. */
const rollbackDeployment = async (options: RollbackOptions): Promise<{ scriptName: string; version?: number }> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;

    const response = await fetchImpl(`${stripTrailingSlashes(options.apiUrl)}/v1/deployments/rollback`, {
        body: JSON.stringify({ deploymentId: options.deploymentId, organizationId: options.organizationId }),
        headers: { authorization: `Bearer ${options.deployKey}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");

        throw new Error(`rollback failed (${String(response.status)})${detail ? `: ${detail}` : ""}`);
    }

    return (await response.json()) as { scriptName: string; version?: number };
};

interface EjectOptions {
    apiUrl: string;
    deployKey: string;
    deploymentId: string;
    fetch?: typeof globalThis.fetch;
}

/** The eject package: the data snapshot plus the identity the BYO config is named after. */
interface EjectPackage {
    projectSlug: string;
    scriptName: string;
    snapshot: string;
    url: string;
}

/**
 * `POST /v1/eject` — pull a deployment's data snapshot and BYO identity.
 *
 * The control plane holds the tenant's admin token and never hands it over: it
 * unseals it, calls the tenant's export, and returns only the bytes. So the exit
 * hatch never leaves a long-lived tenant bearer on a developer's machine.
 */
const fetchEjectPackage = async (options: EjectOptions): Promise<EjectPackage> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;

    const response = await fetchImpl(`${stripTrailingSlashes(options.apiUrl)}/v1/eject`, {
        body: JSON.stringify({ deploymentId: options.deploymentId }),
        headers: { authorization: `Bearer ${options.deployKey}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");

        throw new Error(`eject failed (${String(response.status)})${detail ? `: ${detail}` : ""}`);
    }

    return (await response.json()) as EjectPackage;
};

/** `POST /v1/deploy` — push a prebuilt bundle and stream NDJSON progress via `onEvent`. */
const deployToCloud = async (options: DeployToCloudOptions, onEvent: (event: DeployEvent) => void): Promise<DeployResult> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;

    const response = await fetchImpl(`${stripTrailingSlashes(options.apiUrl)}/v1/deploy`, {
        body: JSON.stringify({
            ...(options.assets ? { assets: options.assets } : {}),
            branch: options.branch,
            bundle: options.bundle,
            ...(options.cronSpecs && options.cronSpecs.length > 0 ? { cronSpecs: options.cronSpecs } : {}),
            kind: options.kind,
            manifest: options.manifest,
            projectId: options.projectId, // secret-scanner:allow -- domain field name
            scriptName: options.scriptName,
        }), // secret-scanner:allow -- domain field name
        headers: { authorization: `Bearer ${options.deployKey}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");

        throw new Error(`deploy request failed (${String(response.status)})${detail ? `: ${detail}` : ""}`);
    }

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let status = "unknown";

    const consume = (line: string): void => {
        const trimmed = line.trim();

        if (trimmed === "") {
            return;
        }

        const event = JSON.parse(trimmed) as DeployEvent;

        onEvent(event);

        if (event["done"] === true && typeof event["status"] === "string") {
            status = event["status"];
        }
    };

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- sequential stream reads
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf("\n");

        while (newline !== -1) {
            consume(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
        }
    }

    consume(buffer);

    return { status };
};

/** Cloudflare's per-asset limit. */
const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;

/** The whole upload rides in one JSON request body, so cap it well below what a Worker will buffer. */
const MAX_ASSETS_TOTAL_BYTES = 50 * 1024 * 1024;

const LINE_BREAK = /\r?\n/u;
const TRAILING_SLASH = /\/$/u;
const LEADING_SLASH = /^\//u;

/** The wrangler `assets` keys that change how files are served — the only ones the upload carries. */
const SERVING_CONFIG_KEYS = ["html_handling", "not_found_handling", "run_worker_first"] as const;

/** Files wrangler reads as config rather than serving; never uploaded. */
const RESERVED_ASSET_FILES = new Set([".assetsignore", "_headers", "_redirects"]);

/** The wrangler `assets` section, as far as a deploy reads it. */
interface WranglerAssets {
    binding?: string;
    directory?: string;
    html_handling?: NonNullable<AssetsUpload["config"]>["html_handling"];
    not_found_handling?: NonNullable<AssetsUpload["config"]>["not_found_handling"];
    run_worker_first?: boolean | string[];
}

/**
 * Compile `.assetsignore` into a predicate over `/`-separated relative paths.
 *
 * A subset of gitignore: one glob per line, `#` comments, a leading `/` anchors
 * to the directory root, a pattern without `/` matches at any depth, and a match
 * on a directory ignores everything under it. `!` re-includes are not supported.
 */
const readAssetsIgnore = (directory: string): ((path: string) => boolean) => {
    const file = join(directory, ".assetsignore");

    if (!existsSync(file)) {
        return () => false;
    }

    const patterns = readFileSync(file, "utf8")
        .split(LINE_BREAK)
        .map((line) => line.trim().replace(TRAILING_SLASH, ""))
        .filter((line) => line !== "" && !line.startsWith("#"));
    // gitignore anchors a pattern that has a `/` anywhere but the end; picomatch's
    // `matchBase` only floats slash-free ones, so a leading `/` must go to a
    // separate, non-floating matcher once stripped.
    const anchored = patterns.filter((pattern) => pattern.includes("/")).map((pattern) => pattern.replace(LEADING_SLASH, ""));
    const floating = patterns.filter((pattern) => !pattern.includes("/"));
    const matchers = [
        ...(anchored.length > 0 ? [matcher(anchored, { dot: true })] : []),
        ...(floating.length > 0 ? [matcher(floating, { dot: true, matchBase: true })] : []),
    ];
    const isMatch = (path: string): boolean => matchers.some((match) => match(path));

    // Test every ancestor too, so `dist` or `logs/` ignores the whole subtree.
    return (path) => path.split("/").some((_, index, segments) => isMatch(segments.slice(0, index + 1).join("/")));
};

/**
 * Walk the `assets.directory` (already resolved against the wrangler file) into
 * the upload body. Throws with a user-facing message when the directory is
 * missing or empty, or a size cap is exceeded — those are all "fix your build"
 * errors the control plane would otherwise answer much later.
 */
const collectAssets = (directory: string, wranglerAssets: WranglerAssets): AssetsUpload => {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error(`assets directory "${directory}" does not exist — build the app first`);
    }

    const ignored = readAssetsIgnore(directory);
    const files: AssetFile[] = [];
    let total = 0;

    for (const entry of walkSync(directory, { followSymlinks: true, includeDirs: false })) {
        const path = relative(directory, entry.path);

        if (RESERVED_ASSET_FILES.has(path) || ignored(path)) {
            continue;
        }

        const { size } = statSync(entry.path);

        if (size > MAX_ASSET_FILE_BYTES) {
            throw new Error(`asset "/${path}" is ${String(size)} bytes; Cloudflare caps a single asset at 25 MiB`);
        }

        total += size;

        if (total > MAX_ASSETS_TOTAL_BYTES) {
            throw new Error(`assets in "${directory}" exceed the 50 MiB upload cap`);
        }

        files.push({ content: readFileSync(entry.path).toString("base64"), path: `/${path}` });
    }

    if (files.length === 0) {
        throw new Error(`assets directory "${directory}" is empty — build the app first`);
    }

    const config: NonNullable<AssetsUpload["config"]> = Object.fromEntries(
        SERVING_CONFIG_KEYS.filter((key) => wranglerAssets[key] !== undefined).map((key) => [key, wranglerAssets[key]]),
    );

    return { ...(Object.keys(config).length > 0 ? { config } : {}), files };
};

/**
 * The built deploy config Wrangler would use, when a build left one.
 *
 * `@cloudflare/vite-plugin` writes the config it actually deploys to its output
 * directory — with the `assets` section it infers from the client build and the
 * `CLOUDFLARE_ENV` environment already applied — and points
 * `.wrangler/deploy/config.json` at it. The source `wrangler.jsonc` of a Vite app
 * usually has no `assets` section at all, so reading it would ship the Worker
 * without its frontend. Wrangler follows the same redirect.
 */
const resolveDeployConfigPath = (cwd: string): string | undefined => {
    const redirect = join(cwd, ".wrangler", "deploy", "config.json");

    if (!existsSync(redirect)) {
        return undefined;
    }

    const { configPath } = JSON.parse(readFileSync(redirect, "utf8")) as { configPath?: unknown };

    if (typeof configPath !== "string" || configPath === "") {
        return undefined;
    }

    const path = resolve(dirname(redirect), configPath);

    return existsSync(path) ? path : undefined;
};

export { collectAssets, deployToCloud, fetchEjectPackage, resolveDeployConfigPath, rollbackDeployment };
export type {
    AssetFile,
    AssetsUpload,
    DeployEvent,
    DeployManifest,
    DeployResult,
    DeployToCloudOptions,
    EjectOptions,
    EjectPackage,
    RollbackOptions,
    WranglerAssets,
};
