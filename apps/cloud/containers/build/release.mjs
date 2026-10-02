/**
 * The release half of a build: turning `lunora build`'s output into everything
 * the control plane needs to deploy it (GAPS.md A3).
 *
 * A Worker module alone does not deploy. The deploy path also needs the binding
 * manifest, the crons and the static assets, and the code that derives those
 * from a project's wrangler config already exists — in the CLI, behind
 * `lunora cloud deploy`. So the box runs the project's own pinned CLI with
 * `--out`, which writes the exact request body that command would upload, and
 * this module reads that file back and holds it to the control plane's caps.
 *
 * Checked HERE, not just at the control plane, so an oversized project fails
 * its BUILD with a message naming the cap, instead of building green and then
 * failing a release several steps later.
 *
 * Split out of `server.mjs` for the same reason `workspace.mjs` is: it is the
 * part with rules worth a unit test. Zero dependencies, like the rest of the box.
 */
import { readFile, stat } from "node:fs/promises";

import { BuildError } from "./workspace.mjs";

/**
 * The control plane's own caps (`MAX_BODY_BYTES`, `MAX_ASSET_FILES`,
 * `MAX_ASSETS_BYTES` in `src/deploy/handler.ts`). Change them together.
 */
const DEFAULT_LIMITS = Object.freeze({
    maxAssetFiles: 20_000,
    maxAssetsBytes: 50 * 1024 * 1024,
    maxBodyBytes: 100 * 1024 * 1024,
});

const MIB = 1024 * 1024;

/**
 * Decoded byte length of a base64 string, without decoding it.
 * @param {string} encoded Base64 text.
 * @returns {number} The decoded size in bytes.
 */
const base64Bytes = (encoded) => (encoded.length / 4) * 3 - (Number(encoded.endsWith("=")) + Number(encoded.endsWith("==")));

/**
 * @param {unknown} value Anything.
 * @returns {value is Record<string, unknown>} Whether it is a plain JSON object.
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Hold the static assets to the control plane's caps.
 * @param {unknown} assets The body's `assets`, if any.
 * @param {typeof DEFAULT_LIMITS} limits The caps.
 * @returns {void}
 */
const checkAssets = (assets, limits) => {
    if (assets === undefined) {
        return;
    }

    if (!isRecord(assets) || !Array.isArray(assets.files)) {
        throw new BuildError("`lunora cloud deploy --out` wrote assets without a `files` list");
    }

    if (assets.files.length > limits.maxAssetFiles) {
        throw new BuildError(`the build has ${String(assets.files.length)} static assets; Lunora Cloud deploys at most ${String(limits.maxAssetFiles)} files`);
    }

    let total = 0;

    for (const file of assets.files) {
        total += isRecord(file) && typeof file.content === "string" ? base64Bytes(file.content) : 0;
    }

    if (total > limits.maxAssetsBytes) {
        throw new BuildError(
            `the build's static assets total ${(total / MIB).toFixed(1)} MiB; Lunora Cloud deploys at most ${String(limits.maxAssetsBytes / MIB)} MiB`,
        );
    }
};

/**
 * Read the request body `lunora cloud deploy --out` wrote, and keep only what
 * describes the Worker.
 *
 * The routing fields (`projectId`, `kind`, `branch`) are dropped: the control
 * plane decides them from the build row, and a tenant's config must not be able
 * to steer a git build at another project or at production. `scriptName` is
 * kept as a hint — the release path claims it through the alias-ownership
 * ledger, so it can only ever name a Worker the project already owns or a new one.
 * @param {string} path The file the CLI wrote.
 * @param {typeof DEFAULT_LIMITS} [limits] The caps; the control plane's by default.
 * @returns {Promise<{ assets?: unknown, cronSpecs?: string[], manifest: Record<string, unknown>, scriptName?: string }>} The release, minus the bundle (the caller already has it).
 */
const readRelease = async (path, limits = DEFAULT_LIMITS) => {
    const { size } = await stat(path);

    if (size > limits.maxBodyBytes) {
        throw new BuildError(
            `the release (Worker bundle plus static assets) is ${(size / MIB).toFixed(1)} MiB; Lunora Cloud accepts at most ${String(limits.maxBodyBytes / MIB)} MiB per deploy`,
        );
    }

    let body;

    try {
        body = JSON.parse(await readFile(path, "utf8"));
    } catch {
        throw new BuildError("`lunora cloud deploy --out` wrote a file that is not JSON");
    }

    if (!isRecord(body) || !isRecord(body.manifest)) {
        throw new BuildError("`lunora cloud deploy --out` wrote no binding manifest");
    }

    checkAssets(body.assets, limits);

    const cronSpecs = Array.isArray(body.cronSpecs) ? body.cronSpecs.filter((cron) => typeof cron === "string") : [];

    return {
        ...(body.assets === undefined ? {} : { assets: body.assets }),
        ...(cronSpecs.length > 0 ? { cronSpecs } : {}),
        manifest: body.manifest,
        ...(typeof body.scriptName === "string" && body.scriptName !== "" ? { scriptName: body.scriptName } : {}),
    };
};

export { DEFAULT_LIMITS, readRelease };
