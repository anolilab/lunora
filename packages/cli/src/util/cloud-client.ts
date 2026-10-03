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

/**
 * The static files behind an `assets` binding, plus the subset of wrangler's `assets` config that changes serving.
 *
 * `_headers` / `_redirects` are the raw contents of those files at the assets
 * root. They are never served as files: like wrangler, the upload carries them
 * in the asset config (Cloudflare's script-upload `metadata.assets.config`
 * fields of the same names), and the asset layer applies their rules.
 */
interface AssetsUpload {
    config?: {
        _headers?: string;
        _redirects?: string;
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

/**
 * The deploy request body without its transport: everything `POST /v1/deploy`
 * carries except the deploy key, which travels as a header. The routing fields
 * are optional because a body written to a file (`lunora cloud deploy --out`)
 * may be routed by whoever uploads it — the Lunora Cloud build box leaves them
 * to the control plane, which knows the project and branch.
 */
type DeployRequestOptions = Omit<DeployToCloudOptions, "apiUrl" | "deployKey" | "fetch" | "projectId" | "scriptName"> & {
    projectId?: string; // secret-scanner:allow -- domain field name
    scriptName?: string;
};

/** The JSON object `POST /v1/deploy` sends. */
interface DeployRequestBody {
    assets?: AssetsUpload;
    branch?: string;
    bundle: string;
    cronSpecs?: string[];
    kind?: "dev" | "preview" | "production";
    manifest: DeployManifest;
    projectId?: string; // secret-scanner:allow -- domain field name
    scriptName?: string;
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

/** `POST /v1/deployments/rollback` — re-provision a retained release onto the project's Worker. */
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

/**
 * The body `POST /v1/deploy` sends, built once for both transports: the upload
 * below, and `lunora cloud deploy --out`, which writes it to a file for the
 * Lunora Cloud build box to hand to the control plane. One builder is what keeps
 * a git-push release and a CLI release from drifting apart.
 */
const deployRequestBody = (options: DeployRequestOptions): DeployRequestBody => {
    return {
        ...(options.assets ? { assets: options.assets } : {}),
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        bundle: options.bundle,
        ...(options.cronSpecs && options.cronSpecs.length > 0 ? { cronSpecs: options.cronSpecs } : {}),
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        manifest: options.manifest,
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }), // secret-scanner:allow -- domain field name
        ...(options.scriptName === undefined ? {} : { scriptName: options.scriptName }),
    };
};

/** `POST /v1/deploy` — push a prebuilt bundle and stream NDJSON progress via `onEvent`. */
const deployToCloud = async (options: DeployToCloudOptions, onEvent: (event: DeployEvent) => void): Promise<DeployResult> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;

    const response = await fetchImpl(`${stripTrailingSlashes(options.apiUrl)}/v1/deploy`, {
        body: JSON.stringify(deployRequestBody(options)),
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

/** Files at the assets root that wrangler reads as config rather than serving; never uploaded as files. */
const RESERVED_ASSET_FILES = new Set([".assetsignore", "_headers", "_redirects"]);

/**
 * Cloudflare's documented `_headers` limits: 100 rules, 2,000 characters a line
 * (https://developers.cloudflare.com/workers/static-assets/headers/).
 */
const MAX_HEADER_RULES = 100;
const MAX_HEADERS_LINE_LENGTH = 2000;

/**
 * Cloudflare's documented `_redirects` limits: 2,000 static and 100 dynamic
 * rules, 1,000 characters a line
 * (https://developers.cloudflare.com/workers/static-assets/redirects/).
 */
const MAX_STATIC_REDIRECT_RULES = 2000;
const MAX_DYNAMIC_REDIRECT_RULES = 100;
const MAX_REDIRECTS_LINE_LENGTH = 1000;

/** The control plane's cap on either file's raw contents. */
const MAX_RULES_FILE_BYTES = 2 * 1024 * 1024;

/** A `_headers` line that starts a rule: a path (`/…`) or an absolute URL (`https://…`) — workers-shared's `parseHeaders`. */
const HEADERS_RULE_LINE = /^(?:\S+:\/\/|\/)/u;

/** A dynamic redirect source carries a splat or a `:placeholder` — workers-shared's `parseRedirects`. */
const DYNAMIC_REDIRECT_SOURCE = /\*|:[A-Za-z]\w*/u;

const WHITESPACE = /\s+/u;

/** The lines of a rules file that carry a rule, numbered from 1: neither blank nor a `#` comment. */
const ruleLines = (content: string): { line: string; number: number }[] =>
    content
        .split(LINE_BREAK)
        .map((line, index) => {
            return { line, number: index + 1 };
        })
        .filter(({ line }) => line.trim() !== "" && !line.trim().startsWith("#"));

/**
 * Refuse a `_headers` / `_redirects` file over Cloudflare's documented limits.
 * Cloudflare's own parsers (workers-shared `parseHeaders` / `parseRedirects`)
 * skip the lines past a limit rather than fail, so an over-long file would
 * deploy green and half-applied; here it fails the deploy instead. Syntax is the
 * asset layer's to judge, not ours.
 */
const checkRulesFile = (name: "_headers" | "_redirects", content: string): void => {
    if (Buffer.byteLength(content) > MAX_RULES_FILE_BYTES) {
        throw new Error(`${name} is ${String(Buffer.byteLength(content))} bytes; the upload caps it at 2 MiB`);
    }

    const maxLength = name === "_headers" ? MAX_HEADERS_LINE_LENGTH : MAX_REDIRECTS_LINE_LENGTH;
    const lines = ruleLines(content);
    const long = lines.find(({ line }) => line.length > maxLength);

    if (long !== undefined) {
        throw new Error(`${name} line ${String(long.number)} is ${String(long.line.length)} characters; Cloudflare allows ${String(maxLength)}`);
    }

    if (name === "_headers") {
        const rules = lines.filter(({ line }) => HEADERS_RULE_LINE.test(line.trim())).length;

        if (rules > MAX_HEADER_RULES) {
            throw new Error(`_headers has ${String(rules)} rules; Cloudflare allows ${String(MAX_HEADER_RULES)}`);
        }

        return;
    }

    // Counted as Cloudflare counts them: once a dynamic rule appears, every
    // later rule is dynamic too, so static rules belong at the top.
    let staticRules = 0;
    let dynamicRules = 0;

    for (const { line } of lines) {
        // The source is the first token; an inline `# comment` can only follow it.
        const [source = ""] = line.trim().split(WHITESPACE);

        if (dynamicRules === 0 && !DYNAMIC_REDIRECT_SOURCE.test(source)) {
            staticRules += 1;
        } else {
            dynamicRules += 1;
        }
    }

    if (staticRules > MAX_STATIC_REDIRECT_RULES) {
        throw new Error(`_redirects has ${String(staticRules)} static rules; Cloudflare allows ${String(MAX_STATIC_REDIRECT_RULES)}`);
    }

    if (dynamicRules > MAX_DYNAMIC_REDIRECT_RULES) {
        throw new Error(
            `_redirects has ${String(dynamicRules)} dynamic rules (a splat or :placeholder source, and every rule after the first of those); Cloudflare allows ${String(MAX_DYNAMIC_REDIRECT_RULES)}`,
        );
    }
};

/** The root `_headers` / `_redirects` files, read and checked, as asset-config fields. */
const readRulesFiles = (directory: string): Pick<NonNullable<AssetsUpload["config"]>, "_headers" | "_redirects"> => {
    const rules: Pick<NonNullable<AssetsUpload["config"]>, "_headers" | "_redirects"> = {};

    for (const name of ["_headers", "_redirects"] as const) {
        const file = join(directory, name);

        if (existsSync(file) && statSync(file).isFile()) {
            const content = readFileSync(file, "utf8");

            checkRulesFile(name, content);
            rules[name] = content;
        }
    }

    return rules;
};

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
    const anchored: string[] = [];
    const floating: string[] = [];

    for (const pattern of patterns) {
        if (pattern.includes("/")) {
            anchored.push(pattern.replace(LEADING_SLASH, ""));
        } else {
            floating.push(pattern);
        }
    }
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
 * the upload body. A root `_headers` / `_redirects` rides in the config rather
 * than as a file, as wrangler sends it. Throws with a user-facing message when
 * the directory is missing or empty, or a size cap or rules limit is exceeded —
 * those are all "fix your build" errors the control plane would otherwise answer
 * much later.
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

    const config: NonNullable<AssetsUpload["config"]> = {
        ...Object.fromEntries(SERVING_CONFIG_KEYS.filter((key) => wranglerAssets[key] !== undefined).map((key) => [key, wranglerAssets[key]])),
        ...readRulesFiles(directory),
    };

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

    let configPath: unknown;

    try {
        ({ configPath } = JSON.parse(readFileSync(redirect, "utf8")) as { configPath?: unknown });
    } catch {
        // A half-written or hand-edited redirect: fall back to the source config, as wrangler does.
        return undefined;
    }

    if (typeof configPath !== "string" || configPath === "") {
        return undefined;
    }

    const path = resolve(dirname(redirect), configPath);

    return existsSync(path) ? path : undefined;
};

export { collectAssets, deployRequestBody, deployToCloud, fetchEjectPackage, resolveDeployConfigPath, rollbackDeployment };
export type {
    AssetFile,
    AssetsUpload,
    DeployEvent,
    DeployManifest,
    DeployRequestBody,
    DeployRequestOptions,
    DeployResult,
    DeployToCloudOptions,
    EjectOptions,
    EjectPackage,
    RollbackOptions,
    WranglerAssets,
};
