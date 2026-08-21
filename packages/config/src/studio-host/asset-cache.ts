/**
 * Cache policy for the studio's static assets and its SPA document, shared by
 * both hosts (the Vite middleware and the CLI `lunora dev` server) so they
 * cannot drift — like `transport-guard.ts`, this was consolidated after the
 * hosts diverged: the entry + stylesheet sit at stable, unhashed URLs, so a
 * host that sends no cache headers lets the browser heuristically cache them
 * and shadow a picked-up `@lunora/studio` rebuild until a hard reload (this
 * once masked a fixed render loop behind a stale bundle).
 */
import { headerValue } from "./transport-guard";

/**
 * Assets: force revalidation on every load. An unchanged asset costs a cheap
 * `304`; a rebuild (new stamp, new chunk names) is always fetched fresh.
 */
const STUDIO_ASSET_CACHE_CONTROL = "no-cache";

/**
 * The SPA document embeds the admin token, so it must never land in any cache
 * — not even a revalidated one (and it must never carry an ETag: a cached 304
 * for a token-bearing document would be its own bug).
 */
const STUDIO_DOCUMENT_CACHE_CONTROL = "no-store";

/** What a host should do for one asset request: the ETag to send (if any) and whether to answer `304`. */
interface StudioAssetRevalidation {
    /** The weak ETag to set, or `undefined` when there is no stamp to key it on. */
    etag?: string;
    /** True when the request's `If-None-Match` matches — answer `304` with no body. */
    notModified: boolean;
}

/**
 * Decide the revalidation response for one studio asset request. The ETag is
 * keyed on the requested file (not just its kind) so each chunk revalidates
 * independently, while the rebuild stamp busts them all at once.
 */
const studioAssetRevalidation = (fileName: string, stamp: number | undefined, ifNoneMatch: string | string[] | undefined): StudioAssetRevalidation => {
    if (stamp === undefined) {
        return { notModified: false };
    }

    const etag = `W/"${fileName}-${String(stamp)}"`;

    return { etag, notModified: headerValue(ifNoneMatch) === etag.toLowerCase() };
};

export { STUDIO_ASSET_CACHE_CONTROL, STUDIO_DOCUMENT_CACHE_CONTROL, studioAssetRevalidation };
export type { StudioAssetRevalidation };
