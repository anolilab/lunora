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

export { applyStudioAssetCache, sendStudioDocument };
