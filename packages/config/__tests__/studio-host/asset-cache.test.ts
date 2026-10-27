/**
 * The shared studio cache headers both hosts (Vite middleware + CLI dev server)
 * apply, so neither can drift back to serving the unhashed studio bundle
 * uncached or the token-bearing document into a disk cache.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { applyStudioAssetCache, sendStudioAsset, sendStudioDocument } from "../../src/studio-host/asset-cache";

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

describe("sendStudioAsset", () => {
    // Above the raw-send threshold, and repetitive enough to compress well.
    const body = Buffer.from("export const studio = 'lunora';\n".repeat(200));

    const send = (acceptEncoding: string | undefined, payload: Buffer = body, stamp: number | undefined = 1): ReturnType<typeof makeResponse> => {
        const made = makeResponse();
        const request = { headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding } } as unknown as IncomingMessage;

        sendStudioAsset(request, made.response, payload, "text/javascript; charset=utf-8", "studio.js", stamp);

        return made;
    };

    const sentBody = (made: ReturnType<typeof makeResponse>): Buffer => made.end.mock.calls[0]?.[0] as Buffer;

    it("prefers brotli, with Content-Encoding, Vary and the compressed Content-Length", () => {
        expect.assertions(4);

        const made = send("gzip, deflate, br");
        const sent = sentBody(made);

        expect(made.headers()).toMatchObject({ "Content-Encoding": "br", "Content-Length": sent.length, Vary: "Accept-Encoding" });
        expect(sent.length).toBeLessThan(body.length / 10);
        expect(brotliDecompressSync(sent).equals(body)).toBe(true);
        expect(made.headers().ETag).toBe('W/"studio.js-1"');
    });

    it("falls back to gzip, and honours q=0 as a refusal", () => {
        expect.assertions(2);

        const made = send("br;q=0, gzip");

        expect(made.headers()["Content-Encoding"]).toBe("gzip");
        expect(gunzipSync(sentBody(made)).equals(body)).toBe(true);
    });

    it("sends raw bytes when the client accepts no supported encoding, or the body is tiny", () => {
        expect.assertions(4);

        const identity = send(undefined);

        expect(identity.headers()["Content-Encoding"]).toBeUndefined();
        expect(identity.end).toHaveBeenCalledWith(body);

        const tiny = Buffer.from("body {}\n");
        const small = send("br, gzip", tiny);

        expect(small.headers()["Content-Encoding"]).toBeUndefined();
        expect(small.end).toHaveBeenCalledWith(tiny);
    });

    it("compresses once per file and stamp, and recompresses after a rebuild", () => {
        expect.assertions(3);

        const first = sentBody(send("gzip", body, 42));

        // Same Buffer instance: served from the cache, not recompressed.
        expect(sentBody(send("gzip", body, 42))).toBe(first);

        const rebuilt = Buffer.from("export const studio = 'rebuilt';\n".repeat(200));
        const fresh = sentBody(send("gzip", rebuilt, 43));

        expect(fresh).not.toBe(first);
        expect(gunzipSync(fresh).equals(rebuilt)).toBe(true);
    });

    it("sets Vary on a 304 too, with no body", () => {
        expect.assertions(3);

        const made = makeResponse();
        const request = { headers: { "accept-encoding": "br", "if-none-match": 'W/"studio.js-1"' } } as unknown as IncomingMessage;

        sendStudioAsset(request, made.response, body, "text/javascript; charset=utf-8", "studio.js", 1);

        expect(made.response.statusCode).toBe(304);
        expect(made.headers().Vary).toBe("Accept-Encoding");
        expect(made.end).toHaveBeenCalledWith();
    });
});
