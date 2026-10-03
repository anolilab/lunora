/**
 * A stored release on the box (plan 458 D6, W4 `deploy` steps 1–2): download
 * it with a signed request, check its size and shape, and lay it out as a
 * directory `celld deploy` takes — the bundle, the static assets and the
 * Wrangler config `celldConfigFromRelease` derives from its binding manifest.
 *
 * The release is the control plane's `StoredRelease` JSON, byte for byte:
 * `{ bundle (base64), manifest, assets? }`. Everything in it is checked before
 * a byte is written, and no asset path may leave the release directory.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import type { CelldReleaseAssetsConfig, CelldReleaseManifest } from "@lunora/config/celld";
import { CELLD_RELEASE_ASSETS_DIRECTORY, CELLD_RELEASE_MAIN, celldConfigFromRelease, CelldReleaseConfigError } from "@lunora/config/celld";

import { isRecord } from "../values";
import type { DeployJob } from "../wire/types";
import { JobError } from "./job-error";
import type { SignedFetch } from "./signed-fetch";

/** The largest release the box downloads: the control plane's 100 MiB deploy cap, plus JSON and base64 overhead. */
const MAX_RELEASE_BYTES = 160 * 1024 * 1024;

/** The config file `celld deploy` reads in the release directory. */
const RELEASE_CONFIG_FILE = "wrangler.json";

interface ReleaseAsset {
    content: string;
    path: string;
}

/** A downloaded release, checked. */
interface StoredRelease {
    assets?: { config?: CelldReleaseAssetsConfig; files: ReleaseAsset[] };
    bundle: string;
    manifest: CelldReleaseManifest;
}

const BASE64_PATTERN = /^[\d+/A-Za-z]*={0,2}$/u;

const invalid = (message: string): JobError => new JobError("RELEASE_INVALID", `the release ${message}`);

/** An asset path: `/` then non-empty segments, none `.` or `..`, no backslash or NUL. */
const isAssetPath = (path: string): boolean =>
    path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
        .slice(1)
        .split("/")
        .every((segment) => segment !== "" && segment !== "." && segment !== "..");

const HTML_HANDLING = new Set(["auto-trailing-slash", "drop-trailing-slash", "force-trailing-slash", "none"]);

const NOT_FOUND_HANDLING = new Set(["404-page", "none", "single-page-application"]);

/**
 * Only the three serving options the deploy request carries, each checked —
 * anything else (a `directory`, say) never reaches the celld config.
 */
const pickAssetsConfig = (config: Record<string, unknown>): CelldReleaseAssetsConfig => {
    const { html_handling: html, not_found_handling: notFound, run_worker_first: workerFirst } = config;
    const isPatternList = Array.isArray(workerFirst) && workerFirst.every((pattern) => typeof pattern === "string");

    return {
        ...(typeof html === "string" && HTML_HANDLING.has(html) ? { html_handling: html as CelldReleaseAssetsConfig["html_handling"] } : {}),
        ...(typeof notFound === "string" && NOT_FOUND_HANDLING.has(notFound)
            ? { not_found_handling: notFound as CelldReleaseAssetsConfig["not_found_handling"] }
            : {}),
        ...(typeof workerFirst === "boolean" || isPatternList ? { run_worker_first: workerFirst } : {}),
    };
};

/** The `assets` of a stored release, checked: every path safe, every content base64. */
const parseAssets = (source: unknown): NonNullable<StoredRelease["assets"]> => {
    const files = isRecord(source) ? source["files"] : undefined;

    if (!Array.isArray(files) || !files.every((file) => isRecord(file) && typeof file["path"] === "string" && typeof file["content"] === "string")) {
        throw invalid("assets.files is not a list of {path, content}");
    }

    for (const file of files as ReleaseAsset[]) {
        if (!isAssetPath(file.path) || !BASE64_PATTERN.test(file.content)) {
            throw invalid(`asset ${JSON.stringify(file.path.slice(0, 200))} has an unsafe path or non-base64 content`);
        }
    }

    const config = isRecord(source) ? source["config"] : undefined;

    return { files: files as ReleaseAsset[], ...(isRecord(config) ? { config: pickAssetsConfig(config) } : {}) };
};

/** Check the shape of a release's JSON. Only what the box uses is read; unknown fields are ignored. */
const parseRelease = (raw: unknown): StoredRelease => {
    if (!isRecord(raw) || typeof raw["bundle"] !== "string" || !isRecord(raw["manifest"])) {
        throw invalid("is not a stored release ({bundle, manifest, assets?})");
    }

    const { bundle, manifest } = raw;

    if (bundle === "" || !BASE64_PATTERN.test(bundle)) {
        throw invalid("bundle is not base64");
    }

    const { bindings } = manifest;

    if (!Array.isArray(bindings) || !bindings.every((entry) => isRecord(entry) && typeof entry["binding"] === "string" && typeof entry["type"] === "string")) {
        throw invalid("manifest.bindings is not a list of {binding, type}");
    }

    return {
        ...(raw["assets"] === undefined ? {} : { assets: parseAssets(raw["assets"]) }),
        bundle,
        manifest: manifest as unknown as CelldReleaseManifest,
    };
};

/** Read a response body, refusing one over `maxBytes` before it is all in memory. */
const readCapped = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
    const declared = Number(response.headers.get("content-length") ?? "0");

    if (declared > maxBytes) {
        await response.body?.cancel();
        throw invalid(`is ${String(declared)} bytes, over the ${String(maxBytes)}-byte cap`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    if (response.body === null) {
        return new Uint8Array();
    }

    for await (const chunk of response.body) {
        total += chunk.byteLength;

        if (total > maxBytes) {
            throw invalid(`is over the ${String(maxBytes)}-byte cap`);
        }

        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
};

/**
 * Download and check the release a deploy job names.
 * @throws {JobError} `FETCH_FAILED` when the control plane does not serve it, `RELEASE_INVALID` when it is malformed or too large.
 */
const fetchRelease = async (signedFetch: SignedFetch, releaseUrl: string): Promise<{ bytes: number; release: StoredRelease }> => {
    let response: Response;

    try {
        response = await signedFetch(releaseUrl, { signal: AbortSignal.timeout(5 * 60 * 1000) });
    } catch (error) {
        if (error instanceof JobError) {
            throw error;
        }

        throw new JobError("FETCH_FAILED", `could not download the release: ${(error as Error).message}`);
    }

    if (response.status !== 200) {
        await response.body?.cancel();
        throw new JobError("FETCH_FAILED", `the control plane answered ${String(response.status)} for the release`);
    }

    const bytes = await readCapped(response, MAX_RELEASE_BYTES);
    let raw: unknown;

    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw invalid("is not JSON");
    }

    return { bytes: bytes.byteLength, release: parseRelease(raw) };
};

/**
 * Lay `release` out in `directory` (replacing anything there): the bundle as
 * `worker.js`, the assets under `assets/`, and the celld config.
 * @returns the config written
 * @throws {JobError} `RELEASE_INVALID` when the release cannot run on celld.
 */
const writeReleaseDirectory = (directory: string, release: StoredRelease, job: DeployJob): Record<string, unknown> => {
    let config: Record<string, unknown>;

    try {
        config = celldConfigFromRelease(release.manifest, {
            alias: job.alias,
            ...(release.assets?.config === undefined ? {} : { assetsConfig: release.assets.config }),
            ...(job.compatibilityDate === undefined ? {} : { compatibilityDate: job.compatibilityDate }),
            crons: job.crons,
            hasAssets: release.assets !== undefined,
            vars: job.vars,
        });
    } catch (error) {
        if (error instanceof CelldReleaseConfigError) {
            throw new JobError("RELEASE_INVALID", error.message);
        }

        throw error;
    }

    rmSync(directory, { force: true, recursive: true });
    mkdirSync(directory, { mode: 0o750, recursive: true });
    writeFileSync(join(directory, CELLD_RELEASE_MAIN), Buffer.from(release.bundle, "base64"), { mode: 0o640 });

    const assetsRoot = resolve(directory, CELLD_RELEASE_ASSETS_DIRECTORY);

    for (const file of release.assets?.files ?? []) {
        const target = resolve(assetsRoot, `.${file.path}`);

        // Checked again on the resolved path: belt and braces over `isAssetPath`.
        if (!target.startsWith(`${assetsRoot}${sep}`)) {
            throw invalid(`asset ${JSON.stringify(file.path)} resolves outside the release`);
        }

        mkdirSync(dirname(target), { mode: 0o750, recursive: true });
        writeFileSync(target, Buffer.from(file.content, "base64"), { mode: 0o640 });
    }

    // celld refuses an assets directory it cannot find, even an empty one.
    if (release.assets !== undefined) {
        mkdirSync(assetsRoot, { mode: 0o750, recursive: true });
    }

    // Mode 0600: the vars carry the app's secrets (plan 458 D10).
    writeFileSync(join(directory, RELEASE_CONFIG_FILE), `${JSON.stringify(config, undefined, 4)}\n`, { mode: 0o600 });

    return config;
};

export type { StoredRelease };
export { fetchRelease, MAX_RELEASE_BYTES, parseRelease, RELEASE_CONFIG_FILE, writeReleaseDirectory };
