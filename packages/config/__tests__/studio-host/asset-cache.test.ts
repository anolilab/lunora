/**
 * The shared studio asset cache policy: revalidation decisions both hosts
 * (Vite middleware + CLI dev server) route through, so neither can drift back
 * to serving the unhashed studio bundle without cache headers.
 */
import { describe, expect, it } from "vitest";

import { STUDIO_ASSET_CACHE_CONTROL, STUDIO_DOCUMENT_CACHE_CONTROL, studioAssetRevalidation } from "../../src/studio-host/asset-cache";

describe("studioAssetRevalidation", () => {
    it("keys a weak ETag on the file name and the rebuild stamp", () => {
        expect.assertions(1);

        expect(studioAssetRevalidation("studio.js", 1234.5, undefined)).toStrictEqual({ etag: 'W/"studio.js-1234.5"', notModified: false });
    });

    it("answers not-modified when If-None-Match echoes the ETag (case-insensitively, as the header helper lower-cases)", () => {
        expect.assertions(2);

        expect(studioAssetRevalidation("styles.css", 7, 'W/"styles.css-7"')).toStrictEqual({ etag: 'W/"styles.css-7"', notModified: true });
        // node:http can surface a repeated header as an array; the first value wins.
        expect(studioAssetRevalidation("styles.css", 7, ['w/"styles.css-7"', "other"])).toStrictEqual({ etag: 'W/"styles.css-7"', notModified: true });
    });

    it("issues a fresh ETag when the stamp moved on", () => {
        expect.assertions(1);

        expect(studioAssetRevalidation("chunk-abc.js", 8, 'W/"chunk-abc.js-7"')).toStrictEqual({ etag: 'W/"chunk-abc.js-8"', notModified: false });
    });

    it("emits no ETag and never matches without a stamp", () => {
        expect.assertions(1);

        expect(studioAssetRevalidation("studio.js", undefined, 'W/"studio.js-1"')).toStrictEqual({ notModified: false });
    });

    it("pins the two cache policies: revalidated assets, uncacheable token-bearing document", () => {
        expect.assertions(2);

        expect(STUDIO_ASSET_CACHE_CONTROL).toBe("no-cache");
        expect(STUDIO_DOCUMENT_CACHE_CONTROL).toBe("no-store");
    });
});
