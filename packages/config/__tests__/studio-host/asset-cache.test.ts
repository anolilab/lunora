/**
 * The shared studio cache headers both hosts (Vite middleware + CLI dev server)
 * apply, so neither can drift back to serving the unhashed studio bundle
 * uncached or the token-bearing document into a disk cache.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { applyStudioAssetCache, sendStudioDocument } from "../../src/studio-host/asset-cache";

const makeResponse = (): { end: ReturnType<typeof vi.fn>; headers: () => Record<string, string>; response: ServerResponse } => {
    const setHeader = vi.fn<(name: string, value: string) => void>();
    const end = vi.fn<(chunk?: Buffer | string) => void>();
    const response = { end, setHeader, statusCode: 0 } as unknown as ServerResponse;

    return { end, headers: () => Object.fromEntries(setHeader.mock.calls as [string, string][]), response };
};

const requestWith = (ifNoneMatch?: string | string[]): IncomingMessage =>
    ({ headers: ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch } }) as unknown as IncomingMessage;

describe("applyStudioAssetCache", () => {
    it("sends no-cache plus a weak ETag keyed on the file name and rebuild stamp, leaving the body to the caller", () => {
        expect.assertions(3);

        const { end, headers, response } = makeResponse();

        expect(applyStudioAssetCache(requestWith(), response, "studio.js", 1234)).toBe(false);
        expect(headers()).toStrictEqual({ "Cache-Control": "no-cache", ETag: 'W/"studio.js-1234"' });
        expect(end).not.toHaveBeenCalled();
    });

    it("answers a bodiless 304 when If-None-Match holds this version", () => {
        expect.assertions(3);

        const { end, response } = makeResponse();

        expect(applyStudioAssetCache(requestWith('W/"styles.css-7"'), response, "styles.css", 7)).toBe(true);
        expect(response.statusCode).toBe(304);
        expect(end).toHaveBeenCalledWith();
    });

    it("compares the ETag byte-for-byte, so chunk names differing only in case never cross-match (RFC 7232)", () => {
        expect.assertions(2);

        const { response } = makeResponse();

        // `chunk-Ab.js` and `chunk-aB.js` are distinct base64url-named chunks; a
        // lower-casing comparison would serve one a 304 for the other's bytes.
        expect(applyStudioAssetCache(requestWith('W/"chunk-aB.js-7"'), response, "chunk-Ab.js", 7)).toBe(false);
        expect(applyStudioAssetCache(requestWith('w/"chunk-Ab.js-7"'), makeResponse().response, "chunk-Ab.js", 7)).toBe(false);
    });

    it("revalidates when the stamp moved on", () => {
        expect.assertions(2);

        const { headers, response } = makeResponse();

        expect(applyStudioAssetCache(requestWith('W/"chunk-abc.js-7"'), response, "chunk-abc.js", 8)).toBe(false);
        expect(headers().ETag).toBe('W/"chunk-abc.js-8"');
    });

    it("sends no ETag and never 304s without a stamp", () => {
        expect.assertions(2);

        const { headers, response } = makeResponse();

        expect(applyStudioAssetCache(requestWith('W/"studio.js-1"'), response, "studio.js", undefined)).toBe(false);
        expect(headers()).toStrictEqual({ "Cache-Control": "no-cache" });
    });
});

describe("sendStudioDocument", () => {
    it("sends the token-bearing document uncacheable and without an ETag", () => {
        expect.assertions(3);

        const { end, headers, response } = makeResponse();

        sendStudioDocument(response, "<!doctype html>");

        expect(response.statusCode).toBe(200);
        // `no-store`, not `no-cache`: the document carries the admin token, so it
        // must not reach the disk cache at all. No ETag — a cached 304 for a
        // token-bearing document would be its own bug.
        expect(headers()).toStrictEqual({ "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
        expect(end).toHaveBeenCalledWith("<!doctype html>");
    });
});
