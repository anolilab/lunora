/**
 * Cache headers for the studio's static assets and its SPA document, applied by
 * both hosts (the Vite middleware and the CLI `lunora dev` server) so they
 * cannot drift — like `transport-guard.ts`, this was consolidated after the
 * hosts diverged: the entry + stylesheet sit at stable, unhashed URLs, so a
 * host that sends no cache headers lets the browser heuristically cache them
 * and shadow a picked-up `@lunora/studio` rebuild until a hard reload (this
 * once masked a fixed render loop behind a stale bundle).
 *
 * Both functions WRITE the response rather than returning a decision for the
 * host to apply: a host applying it would keep its own copy of the header
 * block, which is the drift this module exists to prevent.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

/** A single header value exactly as sent; `undefined` when absent. */
const rawHeader = (raw: string | string[] | undefined): string | undefined => (Array.isArray(raw) ? raw[0] : raw);

/**
 * Set the asset cache headers, answering `304` when the request already holds
 * this version. Returns true when the response is finished, false when the
 * caller should go on to write the body.
 *
 * `no-cache` forces revalidation on every load: an unchanged asset costs a
 * cheap `304`, a rebuild (new stamp, new chunk names) is always fetched fresh.
 * The ETag is keyed on the requested file (not just its kind) so each chunk
 * revalidates independently, while the rebuild stamp busts them all at once. No
 * stamp (the studio isn't resolvable) means no ETag and no `304` — `no-cache`
 * alone.
 *
 * `If-None-Match` is compared byte-for-byte, per RFC 7232: entity tags are
 * case-sensitive, and these are keyed on file names that can differ only in
 * case (base64url chunk names), so a case-insensitive compare would cross-match
 * two distinct chunks into a wrong `304`.
 */
const applyStudioAssetCache = (request: IncomingMessage, response: ServerResponse, fileName: string, stamp: number | undefined): boolean => {
    response.setHeader("Cache-Control", "no-cache");

    if (stamp === undefined) {
        return false;
    }

    const etag = `W/"${fileName}-${String(stamp)}"`;

    response.setHeader("ETag", etag);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `headers` is typed required but partial/mocked requests omit it
    if (rawHeader(request.headers?.["if-none-match"]) !== etag) {
        return false;
    }

    response.statusCode = 304;
    response.end();

    return true;
};

type AssetEncoding = "br" | "gzip";

/** A zero quality value (`q=0`, `q=0.0`, …) — the client refuses that coding. */
const ZERO_QUALITY = /^q=0(?:\.0*)?$/;

/**
 * The encoding to answer with: brotli when the client accepts it (smaller),
 * else gzip, else none. A coding listed with `q=0` is refused, per RFC 9110.
 */
const pickEncoding = (acceptEncoding: string | undefined): AssetEncoding | undefined => {
    if (acceptEncoding === undefined) {
        return undefined;
    }

    const accepted = new Set<string>();

    for (const part of acceptEncoding.split(",")) {
        const [coding = "", ...parameters] = part.split(";").map((token) => token.trim().toLowerCase());

        if (!parameters.some((parameter) => ZERO_QUALITY.test(parameter))) {
            accepted.add(coding);
        }
    }

    if (accepted.has("br")) {
        return "br";
    }

    return accepted.has("gzip") ? "gzip" : undefined;
};

/**
 * Compressed bodies of the current studio build, keyed `${encoding}:${fileName}`.
 * The bundle is ~1 MiB of JS + CSS that every studio load re-sends, so each file
 * is compressed once per encoding, not per request. Dropped wholesale when the
 * rebuild stamp moves, so a mid-session `@lunora/studio` rebuild never serves
 * stale compressed bytes.
 */
let compressedStamp: number | undefined;
const compressedBodies = new Map<string, Buffer>();

/** Below this, the encoding overhead can outweigh the saving — send it raw. */
const MIN_COMPRESS_BYTES = 1024;

// Brotli quality 9, not the max 11: 11 costs several seconds on the entry chunk,
// paid on the developer's first studio load, for a few percent fewer bytes over
// loopback.
const BROTLI_QUALITY = 9;

const compress = (body: Buffer, encoding: AssetEncoding): Buffer =>
    encoding === "br"
        ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length } })
        : gzipSync(body, { level: zlibConstants.Z_BEST_COMPRESSION });

const compressedBody = (body: Buffer, encoding: AssetEncoding, fileName: string, stamp: number | undefined): Buffer => {
    // No stamp: the build can't be identified, so a cached body could be stale.
    if (stamp === undefined) {
        return compress(body, encoding);
    }

    if (stamp !== compressedStamp) {
        compressedBodies.clear();
        compressedStamp = stamp;
    }

    const key = `${encoding}:${fileName}`;
    let cached = compressedBodies.get(key);

    if (cached === undefined) {
        cached = compress(body, encoding);
        compressedBodies.set(key, cached);
    }

    return cached;
};

/**
 * Send a studio static asset (the stylesheet, the `studio.js` entry, a chunk or
 * a source map): cache headers and `304` via {@link applyStudioAssetCache}, then
 * the body — brotli- or gzip-compressed when the client accepts it. Neither the
 * Vite dev server nor `lunora dev` compresses on its own, so without this the
 * studio's first load is the full raw bundle.
 *
 * `Vary: Accept-Encoding` is set on every answer, `304` included, so a cache
 * never hands a compressed body to a client that didn't ask for one. The weak
 * ETag is shared across encodings: a weak tag means "semantically equivalent",
 * which a re-encoding is (the convention nginx follows too).
 */
const sendStudioAsset = (
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
    contentType: string,
    fileName: string,
    stamp: number | undefined,
): void => {
    response.setHeader("Vary", "Accept-Encoding");

    if (applyStudioAssetCache(request, response, fileName, stamp)) {
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `headers` is typed required but partial/mocked requests omit it
    const encoding = body.length < MIN_COMPRESS_BYTES ? undefined : pickEncoding(rawHeader(request.headers?.["accept-encoding"]));
    const payload = encoding === undefined ? body : compressedBody(body, encoding, fileName, stamp);

    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);

    if (encoding !== undefined) {
        response.setHeader("Content-Encoding", encoding);
    }

    response.setHeader("Content-Length", payload.length);
    response.end(payload);
};

/**
 * Send the studio's SPA document. It embeds the admin token, so it is
 * `no-store` — not merely revalidated — and carries no ETag: a cached `304` for
 * a token-bearing document would be its own bug.
 */
const sendStudioDocument = (response: ServerResponse, body: Buffer | string): void => {
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(body);
};

export { applyStudioAssetCache, sendStudioAsset, sendStudioDocument };
