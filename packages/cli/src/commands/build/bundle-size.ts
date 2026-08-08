import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** Raw and compressed size of the bundle `lunora build` wrote to disk. */
interface BundleSize {
    /** How many files were counted — 0 never reaches a caller (see {@link measureBundle}). */
    files: number;

    /**
     * Sum of the per-file gzip sizes. Cloudflare states its script-size limit
     * against the compressed script, and gzip at zlib's default level is what
     * wrangler itself reports ("Total Upload: … / gzip: …") — measuring the same
     * way keeps the two numbers comparable instead of inviting a "which is
     * right?" question. Summing per file rather than gzipping the concatenation
     * is the conservative direction: separate streams share no dictionary.
     */
    gzipBytes: number;
    rawBytes: number;
}

/**
 * True for files that are part of the uploaded Worker.
 *
 * The out-dir also carries artifacts Cloudflare never sees: sourcemaps (which
 * are larger than the script itself — counting them would roughly triple the
 * number), the esbuild metafile `lunora deploy --outdir` writes alongside the
 * bundle, and the README wrangler drops in to explain the directory.
 */
const isUploaded = (name: string): boolean => !name.endsWith(".map") && name !== "bundle-meta.json" && name !== "README.md";

/**
 * Weigh the bundle in `outDir`, raw and gzipped.
 *
 * Returns `undefined` when the directory is missing or holds nothing uploadable
 * — a caller must treat that as "not measured" and never as "zero bytes": a
 * silent 0 is what a changed wrangler out-dir layout would look like, and it
 * would read as the healthiest possible result.
 */
const measureBundle = (outDirectory: string): BundleSize | undefined => {
    let entries;

    try {
        entries = readdirSync(outDirectory, { recursive: true, withFileTypes: true });
    } catch {
        return undefined;
    }

    let files = 0;
    let gzipBytes = 0;
    let rawBytes = 0;

    for (const entry of entries) {
        if (!entry.isFile() || !isUploaded(entry.name)) {
            continue;
        }

        const bytes = readFileSync(join(entry.parentPath, entry.name));

        files += 1;
        rawBytes += bytes.byteLength;
        gzipBytes += gzipSync(bytes).byteLength;
    }

    return files === 0 ? undefined : { files, gzipBytes, rawBytes };
};

export type { BundleSize };
export { measureBundle };
