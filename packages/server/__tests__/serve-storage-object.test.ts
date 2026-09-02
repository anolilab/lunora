import { describe, expect, expectTypeOf, it } from "vitest";

import type { ReadOnlyStorage, StorageObjectBody, StorageServeAuthorizer } from "../src/index";
import { serveStorageObject } from "../src/index";

interface FakeObjectOptions {
    contentType?: string;
    etag?: string;
    sha256Base64?: string;
}

/** A single-use object view; `body` streams `bytes` (a fresh stream per download). */
const fakeObject = (bytes: Uint8Array, size: number, options: FakeObjectOptions) => {
    return {
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
        }),
        etag: options.etag ?? "etag-1",
        httpMetadata: { contentType: options.contentType ?? "application/octet-stream" }, // gitleaks:allow -- "octet-stream" mime, not a Stream API key
        key: "k",
        sha256Base64: options.sha256Base64,
        // `size` is always the full object size, even for a ranged read (mirrors R2).
        size,
    };
};

/** What each ctx double was asked to do, so a test can assert on the reads themselves. */
interface StorageCalls {
    /** One entry per `download`: the requested window, or `undefined` for a whole-object read. */
    downloads: ({ length: number; offset: number } | undefined)[];
    /** One entry per body-free `head`. */
    heads: number;
}

/**
 * Build a ctx whose `download` mirrors R2's ranged-read contract: a plain
 * `download(key)` streams the whole object, while `download(key, { range })`
 * streams only the requested window (but still reports the full `size`). A fresh
 * stream is produced on every call so reads never share a consumed body. `head`
 * mirrors R2's HEAD — the same metadata with no body at all.
 *
 * The returned `calls` record is what pins the round-trip count: a ranged
 * request must never start a whole-object `download` just to learn the size.
 */
const ctxWith = (bytes: Uint8Array | null, options: FakeObjectOptions = {}) => {
    const calls: StorageCalls = { downloads: [], heads: 0 };

    return {
        calls,
        ctx: {
            storage: {
                download: async (_key: string, downloadOptions?: { range?: { length: number; offset: number } }) => {
                    calls.downloads.push(downloadOptions?.range);

                    if (bytes === null) {
                        return null;
                    }

                    const range = downloadOptions?.range;
                    const slice = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;

                    return fakeObject(slice, bytes.byteLength, options);
                },
                head: async (_key: string) => {
                    calls.heads += 1;

                    if (bytes === null) {
                        return null;
                    }

                    const object = fakeObject(new Uint8Array(), bytes.byteLength, options);

                    // A real HEAD carries no body at all — dropping it here is what
                    // makes a test fail if `serveStorageObject` ever reads one off a
                    // head result.
                    return { ...object, body: undefined };
                },
            },
        },
    };
};

const BODY = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

/** The gate every non-authorization test passes: already-verified, serve it. */
const ALLOW: StorageServeAuthorizer = () => true;

describe("serveStorageObject — authorization", () => {
    it("streams nothing and answers 403 when the gate denies — never touching storage", async () => {
        expect.assertions(3);

        const { calls, ctx } = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"), () => false);

        expect(response.status).toBe(403);
        expect(calls.downloads).toHaveLength(0);
        expect(calls.heads).toBe(0);
    });

    it("treats a throwing gate as a denial, not a 500 (fail closed)", async () => {
        expect.assertions(2);

        const { calls, ctx } = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"), () => {
            throw new Error("verifier exploded");
        });

        expect(response.status).toBe(403);
        expect(calls.downloads).toHaveLength(0);
    });

    it("hands the gate the key and the request so a signed-URL check can run", async () => {
        expect.assertions(3);

        const { ctx } = ctxWith(BODY);
        const seen: { key: string; url: string }[] = [];

        const response = await serveStorageObject(ctx, "avatars/1.png", new Request("https://x/avatars/1.png?sig=abc"), ({ key, request }) => {
            seen.push({ key, url: request.url });

            return new URL(request.url).searchParams.get("sig") === "abc";
        });

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toStrictEqual({ key: "avatars/1.png", url: "https://x/avatars/1.png?sig=abc" });
    });

    // A gate is mandatory in the type — there is no "forgot to pass one" shape
    // that still compiles, which is what keeps a mounted route from being an
    // open object store.
    it("requires the authorizer at the type level", () => {
        expect.assertions(1);

        expectTypeOf<Parameters<typeof serveStorageObject>[3]>().toEqualTypeOf<StorageServeAuthorizer>();

        expect(true).toBe(true);
    });
});

describe("serveStorageObject — response hardening", () => {
    it("forces a download for a renderable type and never lets the browser sniff", async () => {
        expect.assertions(3);

        const { ctx } = ctxWith(BODY, { contentType: "text/html; charset=utf-8" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"), ALLOW);

        // The uploader pinned `text/html` into the signed PUT; serving it inline
        // on the app's own origin is stored XSS.
        expect(response.headers.get("content-disposition")).toBe("attachment");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    });

    it("forces a download for image/svg+xml — an image that is also a scriptable document", async () => {
        expect.assertions(1);

        const { ctx } = ctxWith(BODY, { contentType: "image/svg+xml" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"), ALLOW);

        expect(response.headers.get("content-disposition")).toBe("attachment");
    });

    it("renders a raster image inline, still with nosniff", async () => {
        expect.assertions(2);

        const { ctx } = ctxWith(BODY, { contentType: "image/png" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"), ALLOW);

        expect(response.headers.get("content-disposition")).toBeNull();
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("hardens the 206 the same way as the 200", async () => {
        expect.assertions(2);

        const { ctx } = ctxWith(BODY, { contentType: "text/html" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=2-5" } }), ALLOW);

        expect(response.status).toBe(206);
        expect(response.headers.get("content-disposition")).toBe("attachment");
    });
});

describe("serveStorageObject", () => {
    it("returns 200 with full body + metadata headers when no Range is sent", async () => {
        expect.assertions(5);

        const { ctx } = ctxWith(BODY, { contentType: "text/plain", etag: "abc", sha256Base64: "3q2+7w==" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"), ALLOW);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/plain");
        // RFC 7232: ETag must be a quoted-string. R2's `etag` is unquoted hex, so
        // `serveStorageObject` wraps it.
        expect(response.headers.get("etag")).toBe('"abc"');
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        // RFC 9530 representation digest: base64 byte-sequence wrapped in colons.
        expect(response.headers.get("repr-digest")).toBe("sha-256=:3q2+7w==:");
    });

    it("does not double-quote an already-quoted (weak) ETag", async () => {
        expect.assertions(1);

        const { ctx } = ctxWith(BODY, { etag: 'W/"weak"' });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"), ALLOW);

        expect(response.headers.get("etag")).toBe('W/"weak"');
    });

    it("rejects a CRLF-bearing Content-Type to prevent header injection", async () => {
        expect.assertions(2);

        const { ctx } = ctxWith(BODY, { contentType: "text/html\r\nset-cookie: pwned=1" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"), ALLOW);

        // Falls back to the safe default rather than reflecting the injected value.
        expect(response.headers.get("content-type")).toBe("application/octet-stream");
        expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("returns 404 when the object is absent", async () => {
        expect.assertions(1);

        const response = await serveStorageObject(ctxWith(null).ctx, "missing", new Request("https://x/missing"), ALLOW);

        expect(response.status).toBe(404);
    });

    it("resolves a range with one head + one ranged download, never a whole-object read", async () => {
        expect.assertions(3);

        const { calls, ctx } = ctxWith(BODY);

        await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=2-5" } }), ALLOW);

        expect(calls.heads).toBe(1);
        // Exactly one download, and it is the window — not a full-object body
        // fetched for its size and then thrown away.
        expect(calls.downloads).toStrictEqual([{ length: 4, offset: 2 }]);
        expect(calls.downloads).not.toContain(undefined);
    });

    it("skips the head entirely when no Range is sent", async () => {
        expect.assertions(2);

        const { calls, ctx } = ctxWith(BODY);

        await serveStorageObject(ctx, "k", new Request("https://x/k"), ALLOW);

        expect(calls.heads).toBe(0);
        expect(calls.downloads).toStrictEqual([undefined]);
    });

    it("skips the head for a Range that cannot produce a 206 anyway", async () => {
        expect.assertions(4);

        // Multi-range and malformed headers both degrade to the whole object, so
        // paying for a metadata read would only add a round trip — and a window in
        // which the object can vanish between the two, turning a 200 into a 404.
        const served = await Promise.all(
            ["bytes=0-1,4-5", "furlongs=1-2"].map(async (range) => {
                const { calls, ctx } = ctxWith(BODY);
                const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range } }), ALLOW);

                return { heads: calls.heads, status: response.status };
            }),
        );

        for (const { heads, status } of served) {
            expect(status).toBe(200);
            expect(heads).toBe(0);
        }
    });

    it("answers an unsatisfiable range from the head alone, with no download at all", async () => {
        expect.assertions(2);

        const { calls, ctx } = ctxWith(BODY);

        await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=50-60" } }), ALLOW);

        expect(calls.heads).toBe(1);
        expect(calls.downloads).toStrictEqual([]);
    });

    it("returns 404 from the head when a ranged request names an absent object", async () => {
        expect.assertions(2);

        const { calls, ctx } = ctxWith(null);
        const response = await serveStorageObject(ctx, "gone", new Request("https://x/gone", { headers: { range: "bytes=0-1" } }), ALLOW);

        expect(response.status).toBe(404);
        expect(calls.downloads).toStrictEqual([]);
    });

    it("builds the 206 headers from the head, not the ranged read — one coherent representation", async () => {
        expect.assertions(3);

        // Model an object replaced between the two reads: the head sees the
        // representation the window was resolved against, the ranged read sees a
        // newer one. The validator, digest and Content-Range total must all
        // describe the SAME representation, or the response lies about what it is.
        const ctx = {
            storage: {
                download: async (_key: string) => {
                    return { ...fakeObject(BODY.subarray(2, 6), 10, { etag: "new", sha256Base64: "AAAA" }) };
                },
                head: async (_key: string) => {
                    return { ...fakeObject(new Uint8Array(), 10, { etag: "old", sha256Base64: "3q2+7w==" }), body: undefined };
                },
            },
        };

        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=2-5" } }), ALLOW);

        expect(response.headers.get("etag")).toBe('"old"');
        expect(response.headers.get("repr-digest")).toBe("sha-256=:3q2+7w==:");
        expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    });

    it("returns 206 with Content-Range/Content-Length for a byte range", async () => {
        expect.assertions(4);

        const { ctx } = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=2-5" } }), ALLOW);

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
        expect(response.headers.get("content-length")).toBe("4");

        const buffer = new Uint8Array(await response.arrayBuffer());

        expect([...buffer]).toEqual([2, 3, 4, 5]);
    });

    it("clamps an open-ended range (bytes=7-) to the object end", async () => {
        expect.assertions(2);

        const { ctx } = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=7-" } }), ALLOW);

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 7-9/10");
    });

    it("serves a suffix range (bytes=-3) as the final bytes", async () => {
        expect.assertions(2);

        const { ctx } = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=-3" } }), ALLOW);

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 7-9/10");
    });

    it("returns 416 with Content-Range */size for an out-of-bounds range", async () => {
        expect.assertions(4);

        const { ctx } = ctxWith(BODY, { contentType: "video/mp4", sha256Base64: "3q2+7w==" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=50-60" } }), ALLOW);

        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */10");
        // The error body is plain text — it must not be mislabelled with the
        // object's Content-Type, nor carry the object's representation digest.
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(response.headers.get("repr-digest")).toBeNull();
    });

    it("ignores a multi-range request and serves the whole object (200)", async () => {
        expect.assertions(1);

        const { ctx } = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=0-1,4-5" } }), ALLOW);

        expect(response.status).toBe(200);
    });
});

describe("ctx.storage.download contract", () => {
    // `download()` resolves the R2 OBJECT (metadata plus a `body` stream), not a
    // bare stream — `types.ts` declared the opposite, which made
    // `return new Response(await ctx.storage.download(key))` typecheck and then
    // serve the literal text `[object Object]` with a 200. These are compile-time
    // assertions: `lint:types` type-checks `__tests__/`.
    it("is declared as the object-returning shape a real ctx implements", () => {
        expect.assertions(1);

        expectTypeOf<Awaited<ReturnType<ReadOnlyStorage["download"]>>>().toEqualTypeOf<StorageObjectBody | null>();

        // And a real read-only ctx satisfies the surface `serveStorageObject`
        // reads through, so the helper is reachable from a query/mutation ctx.
        const usable: Parameters<typeof serveStorageObject>[0] = { storage: {} as ReadOnlyStorage };

        expect(usable).toBeDefined();
    });
});
