/**
 * Integration coverage for the RLS-gated, non-admin resumable upload handler.
 *
 * The whole flow runs in-process: `@lunora/storage/upload`'s handler over an
 * in-memory `@visulima/storage` provider, driven by the real
 * `@visulima/storage-client` TUS adapter through a `globalThis.fetch` stub — no
 * live R2, no admin token. Proves the exit criteria: a large file uploads with
 * live progress, survives pause/resume, resumes after a dropped connection, and
 * is gated by RLS (denied uploads are rejected, no admin gating involved).
 */
import { MemoryStorage } from "@visulima/storage/provider/memory";
import { createChunkedRestAdapter, createTusAdapter, UploadControl } from "@visulima/storage-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadAuthzContext, UploadHandler, UploadSizeContext } from "../src/upload-handler";
import { createR2UploadStorage, createUploadHandler, DEFAULT_MAX_UPLOAD_BYTES } from "../src/upload-handler";
import { chunkedRest, routedFetch, uploadId } from "./chunked-rest-driver";

const ENDPOINT = "https://test.local/upload";
const B64 = (value: string): string => Buffer.from(value).toString("base64");

/** A `File` from raw bytes (Node >=20 exposes `File` globally). */
const makeFile = (bytes: number, name = "big.bin"): File => new File([new Uint8Array(bytes).fill(66)], name, { type: "application/octet-stream" });

/**
 * Route the client's `globalThis.fetch` at the in-memory handler. Returns a
 * `requests` log and an `install`/`restore` pair; `failNext` drops exactly one
 * request (simulating a mid-upload connection drop) before it reaches the
 * server, so the test can then resume from the server-recorded offset.
 */
const wireFetch = (handler: { fetch: (request: Request) => Promise<Response> }) => {
    const requests: { method: string; pathname: string }[] = [];
    let dropOne = false;

    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        requests.push({ method: request.method, pathname: url.pathname });

        if (dropOne && request.method === "PATCH") {
            dropOne = false;

            throw new TypeError("simulated network drop");
        }

        // Reconstruct against the handler's own origin so the storage path matches.
        return handler.fetch(new Request(`https://test.local${url.pathname}${url.search}`, request));
    };

    return {
        dropNextPatch: (): void => {
            dropOne = true;
        },
        install: (): void => {
            vi.stubGlobal("fetch", stub);
        },
        requests,
        restore: (): void => {
            vi.unstubAllGlobals();
        },
    };
};

/** A minimal raw-TUS driver so pause/resume and resume-after-drop are deterministic (no adapter timing). */
const rawTus = (handler: { fetch: (request: Request) => Promise<Response> }) => {
    return {
        create: async (length: number, name: string): Promise<string> => {
            const response = await handler.fetch(
                new Request(ENDPOINT, {
                    headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(length), "Upload-Metadata": `filename ${B64(name)}` },
                    method: "POST",
                }),
            );

            expect(response.status).toBe(201);

            const location = response.headers.get("location") ?? "";

            return location.startsWith("http") ? location : `https://test.local${location}`;
        },
        head: async (location: string): Promise<number> => {
            const response = await handler.fetch(new Request(location, { headers: { "Tus-Resumable": "1.0.0" }, method: "HEAD" }));

            expect(response.status).toBe(200);

            return Number(response.headers.get("upload-offset"));
        },
        patch: async (location: string, offset: number, chunk: Uint8Array): Promise<Response> =>
            handler.fetch(
                new Request(location, {
                    body: Uint8Array.from(chunk),
                    headers: { "Content-Type": "application/offset+octet-stream", "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset) },
                    method: "PATCH",
                }),
            ),
    };
};

describe("createUploadHandler (RLS-gated, non-admin)", () => {
    let handler: ReturnType<typeof createUploadHandler>;

    beforeEach(() => {
        // `silent` keeps these upload-flow tests (unrelated to the authorize
        // warning below) quiet — see the dedicated "default-open authorize"
        // describe block for coverage of the warning itself.
        handler = createUploadHandler({ silent: true, storage: new MemoryStorage({ path: "/upload" }) });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("uploads a large file with live progress to 100%", async () => {
        expect.hasAssertions();

        const wire = wireFetch(handler);

        wire.install();

        const progress: number[] = [];
        const control = new UploadControl();
        const adapter = createTusAdapter({ chunkSize: 128 * 1024, control, endpoint: ENDPOINT });

        adapter.setOnProgress((value) => progress.push(value));

        const file = makeFile(2_000_000);
        const result = await adapter.upload(file);

        wire.restore();

        expect(result.bytesWritten ?? 0).toBe(2_000_000);
        // Progress is live and monotonic. It stops one chunk short of 100:
        // `@visulima/storage`'s TUS handler answers the completing PATCH with
        // 200, the client accepts only 204, so it re-reads the offset with HEAD
        // and finishes without a last progress event: visulima/visulima#899.
        // (2.0.24's MemoryStorage marked an upload complete early and hid this.)
        expect(progress.length).toBeGreaterThan(1);
        expect(progress).toStrictEqual(progress.toSorted((a, b) => a - b));
        expect(progress.at(-1)).toBeGreaterThan(90);
        // The upload went through the RLS route (POST create + PATCH chunks), never an admin path.
        expect(wire.requests.some((entry) => entry.method === "POST")).toBe(true);
        expect(wire.requests.some((entry) => entry.method === "PATCH")).toBe(true);
    });

    it("refuses to delete a finished upload through the upload route", async () => {
        expect.hasAssertions();

        const tus = rawTus(handler);
        const location = await tus.create(4, "done.bin");

        const patched = await tus.patch(location, 0, new Uint8Array(4).fill(1));

        expect(patched.ok).toBe(true);

        const deleted = await handler.fetch(new Request(location, { headers: { "Tus-Resumable": "1.0.0" }, method: "DELETE" }));

        expect(deleted.status).toBeGreaterThanOrEqual(400);
        await expect(tus.head(location)).resolves.toBe(4);
    });

    it.each(["chunked-rest", "multipart"] as const)("refuses DELETE on a %s route before the gate (405)", async (protocol) => {
        expect.hasAssertions();

        const authorize = vi.fn<() => boolean>(() => true);
        const route = createUploadHandler({ authorize, protocol, storage: new MemoryStorage({ path: "/upload" }) });

        // Neither protocol honors disableTerminationForFinishedUploads: their
        // DELETE removes any stored file by id (chunked REST also via `?ids=`).
        const response = await route.fetch(new Request(`${ENDPOINT}?ids=a,b`, { method: "DELETE" }));

        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).not.toContain("DELETE");
        expect(authorize).not.toHaveBeenCalled();
    });

    describe("write-only route: GET never serves a stored file", () => {
        /** Store a real file through the multipart route, so GET has something it could serve. */
        const storeFile = async (storage: MemoryStorage): Promise<string> => {
            const form = new FormData();

            form.append("file", new File(["secret bytes"], "secret.txt", { type: "text/plain" }));

            const created = await createUploadHandler({ protocol: "multipart", silent: true, storage }).fetch(
                new Request(ENDPOINT, { body: form, method: "POST" }),
            );

            expect(created.status).toBe(200);

            const { id } = await created.json<{ id: string }>();

            return id;
        };

        it.each(["chunked-rest", "multipart", "tus"] as const)(
            "refuses GET /<id>, GET /<id>/metadata and the collection GET on a %s route before the gate (405)",
            async (protocol) => {
                expect.hasAssertions();

                const storage = new MemoryStorage({ path: "/upload" });
                const id = await storeFile(storage);
                const authorize = vi.fn<() => boolean>(() => true);
                const route = createUploadHandler({ authorize, protocol, storage });

                // `@visulima/storage` 2.0.24 serves all three over fetch (2.0.22's
                // Rest and Multipart answered 500; TUS served downloads already).
                for (const path of [`${ENDPOINT}/${id}`, `${ENDPOINT}/${id}.txt`, `${ENDPOINT}/${id}/metadata`, ENDPOINT, `${ENDPOINT}?page=1`]) {
                    // eslint-disable-next-line no-await-in-loop -- one path at a time
                    const response = await route.fetch(new Request(path, { headers: { "Tus-Resumable": "1.0.0", range: "bytes=0-5" }, method: "GET" }));

                    expect(response.status).toBe(405);
                    expect(response.headers.get("Allow")).not.toContain("GET");
                    // eslint-disable-next-line no-await-in-loop -- one path at a time
                    await expect(response.text()).resolves.not.toContain("secret bytes");
                }

                expect(authorize).not.toHaveBeenCalled();
            },
        );

        it("refuses GET on a public route too, which has no gate at all", async () => {
            expect.hasAssertions();

            const storage = new MemoryStorage({ path: "/upload" });
            const id = await storeFile(storage);
            const route = createUploadHandler({ protocol: "chunked-rest", public: true, storage });

            await expect(route.fetch(new Request(`${ENDPOINT}/${id}`, { method: "GET" }))).resolves.toHaveProperty("status", 405);
        });

        it.each([
            ["tus", "DELETE, HEAD, OPTIONS, PATCH, POST"],
            ["chunked-rest", "HEAD, OPTIONS, PATCH, POST, PUT"],
            ["multipart", "OPTIONS, POST"],
        ] as const)("names the refused method and advertises only the %s upload methods", async (protocol, allow) => {
            expect.hasAssertions();

            const route = createUploadHandler({ protocol, silent: true, storage: new MemoryStorage({ path: "/upload" }) });
            const response = await route.fetch(new Request(`${ENDPOINT}/abc`, { method: "PROPFIND" }));

            expect(response.status).toBe(405);
            expect(response.headers.get("Allow")).toBe(allow);
            await expect(response.json()).resolves.toMatchObject({
                error: { code: "METHOD_NOT_ALLOWED", message: expect.stringMatching(/^PROPFIND is not allowed/) },
            });
        });

        describe.each(["chunked-rest", "multipart", "tus"] as const)("method edge cases on a %s route", (protocol) => {
            it.each(["get", "Get", "gEt"])("refuses %j as GET (405) before the gate", async (method) => {
                expect.hasAssertions();

                const storage = new MemoryStorage({ path: "/upload" });
                const id = await storeFile(storage);
                const authorize = vi.fn<() => boolean>(() => true);
                const response = await createUploadHandler({ authorize, protocol, storage }).fetch(
                    new Request(`${ENDPOINT}/${id}`, { headers: { "Tus-Resumable": "1.0.0" }, method }),
                );

                expect(response.status).toBe(405);
                await expect(response.text()).resolves.not.toContain("secret bytes");
                expect(authorize).not.toHaveBeenCalled();
            });

            it.each(["patch", "Patch"])("refuses %j, which is not PATCH (405), before the gate", async (method) => {
                expect.hasAssertions();

                // `Request` upper-cases the standard methods but keeps `patch`
                // as sent; HTTP methods are case-sensitive.
                const storage = new MemoryStorage({ path: "/upload" });
                const write = vi.spyOn(storage, "write");
                const authorize = vi.fn<() => boolean>(() => true);
                const response = await createUploadHandler({ authorize, protocol, storage }).fetch(
                    new Request(`${ENDPOINT}/abc`, {
                        body: new Uint8Array(4),
                        headers: {
                            "Content-Length": "4",
                            "Content-Type": "application/offset+octet-stream",
                            "Tus-Resumable": "1.0.0",
                            "Upload-Offset": "0",
                            "X-Chunk-Offset": "0",
                        },
                        method,
                    }),
                );

                expect(response.status).toBe(405);
                await expect(response.json()).resolves.toMatchObject({
                    error: { code: "METHOD_NOT_ALLOWED", message: expect.stringMatching(new RegExp(`^${method} is not allowed`)) },
                });
                expect(authorize).not.toHaveBeenCalled();
                expect(write).not.toHaveBeenCalled();
            });

            it("refuses an unknown method (PROPFIND) before the gate (405)", async () => {
                expect.hasAssertions();

                const authorize = vi.fn<() => boolean>(() => true);
                const response = await createUploadHandler({ authorize, protocol, storage: new MemoryStorage({ path: "/upload" }) }).fetch(
                    new Request(`${ENDPOINT}/abc`, { method: "PROPFIND" }),
                );

                expect(response.status).toBe(405);
                expect(authorize).not.toHaveBeenCalled();
            });

            it.each(["X-HTTP-Method-Override", "X-HTTP-Method", "X-Method-Override"])(
                "ignores a %s: GET header: no bytes or metadata are served",
                async (header) => {
                    expect.hasAssertions();

                    const storage = new MemoryStorage({ path: "/upload" });
                    const id = await storeFile(storage);
                    const route = createUploadHandler({ protocol, silent: true, storage });

                    for (const method of ["POST", "PATCH", "HEAD"]) {
                        for (const path of [`${ENDPOINT}/${id}`, `${ENDPOINT}/${id}/metadata`]) {
                            // eslint-disable-next-line no-await-in-loop -- one request at a time
                            const response = await route.fetch(new Request(path, { headers: { [header]: "GET", "Tus-Resumable": "1.0.0" }, method }));
                            // eslint-disable-next-line no-await-in-loop -- one request at a time
                            const body = await response.text();

                            expect(body).not.toContain("secret bytes");
                            expect(body).not.toContain("secret.txt");
                            expect(response.headers.get("content-disposition")).toBeNull();
                        }
                    }
                },
            );
        });

        describe("tus route", () => {
            const tusRoute = (storage = new MemoryStorage({ path: "/upload" })) => createUploadHandler({ protocol: "tus", silent: true, storage });

            it("answers HEAD with the upload's TUS headers only, and no body", async () => {
                expect.hasAssertions();

                const route = tusRoute();
                const created = await route.fetch(
                    new Request(ENDPOINT, {
                        headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "4", "Upload-Metadata": `filename ${B64("a.txt")}` },
                        method: "POST",
                    }),
                );
                const location = new URL(created.headers.get("location") ?? "", ENDPOINT).href;
                const head = await route.fetch(new Request(location, { headers: { "Tus-Resumable": "1.0.0" }, method: "HEAD" }));
                const names = [...head.headers.keys()].filter((name) => name !== "access-control-expose-headers").toSorted((a, b) => a.localeCompare(b));

                expect(head.status).toBe(200);
                await expect(head.text()).resolves.toBe("");
                expect(names).toStrictEqual(["cache-control", "tus-resumable", "upload-length", "upload-metadata", "upload-offset"]);
                expect(head.headers.get("upload-length")).toBe("4");
                expect(head.headers.get("upload-offset")).toBe("0");
                expect(head.headers.get("upload-metadata")).toBe(`filename ${B64("a.txt")}`);
            });

            it("answers OPTIONS (CORS preflight) with 204 and the TUS capabilities", async () => {
                expect.hasAssertions();

                const response = await tusRoute().fetch(new Request(ENDPOINT, { method: "OPTIONS" }));

                expect(response.status).toBe(204);
                expect(response.headers.get("tus-resumable")).toBe("1.0.0");
                expect(response.headers.get("tus-version")).toBe("1.0.0");
            });

            it("refuses GET on a stored upload (405), even with a valid Tus-Resumable header", async () => {
                expect.hasAssertions();

                const storage = new MemoryStorage({ path: "/upload" });
                const id = await storeFile(storage);
                const response = await tusRoute(storage).fetch(new Request(`${ENDPOINT}/${id}`, { headers: { "Tus-Resumable": "1.0.0" }, method: "GET" }));

                expect(response.status).toBe(405);
                expect(response.headers.get("tus-resumable")).toBe("1.0.0");
                expect(response.headers.get("allow")).toBe("DELETE, HEAD, OPTIONS, PATCH, POST");
            });
        });

        it("still answers HEAD and OPTIONS, which resume and CORS need", async () => {
            expect.hasAssertions();

            const route = createUploadHandler({ protocol: "chunked-rest", silent: true, storage: new MemoryStorage({ path: "/upload" }) });
            const created = await route.fetch(
                new Request(ENDPOINT, { headers: { "content-type": "text/plain", "x-chunked-upload": "true", "x-total-size": "10" }, method: "POST" }),
            );
            const location = new URL(created.headers.get("location") ?? "", ENDPOINT).href;
            const head = await route.fetch(new Request(location, { method: "HEAD" }));

            expect(head.status).toBe(200);
            expect(head.headers.get("x-upload-offset")).toBe("0");

            const preflight = await route.fetch(new Request(ENDPOINT, { method: "OPTIONS" }));

            expect(preflight.status).toBe(204);
        });
    });

    it("survives pause/resume mid-upload", async () => {
        expect.hasAssertions();

        const driver = rawTus(handler);
        const total = 300 * 1024;
        const bytes = new Uint8Array(total).fill(67);
        const location = await driver.create(total, "paused.bin");

        // Upload the first third, then "pause" (simply stop issuing PATCHes).
        const cut = 100 * 1024;
        const first = await driver.patch(location, 0, bytes.slice(0, cut));

        // A partial chunk is 204; the one that completes the upload is 200.
        // (2.0.24's MemoryStorage completed the upload early: 200 here, then 204.)
        expect(first.status).toBe(204);
        expect(Number(first.headers.get("upload-offset"))).toBe(cut);

        // A HEAD while paused still reports the persisted offset — resume anchor.
        await expect(driver.head(location)).resolves.toBe(cut);

        // "Resume": finish from the reported offset.
        const rest = await driver.patch(location, cut, bytes.slice(cut));

        expect(rest.status).toBe(200);
        expect(Number(rest.headers.get("upload-offset"))).toBe(total);
    });

    it("resumes after a dropped connection", async () => {
        expect.hasAssertions();

        const driver = rawTus(handler);
        const total = 500 * 1024;
        const bytes = new Uint8Array(total).fill(68);
        const location = await driver.create(total, "dropped.bin");

        // First chunk lands on the server.
        const cut = 200 * 1024;

        await driver.patch(location, 0, bytes.slice(0, cut));

        // Connection drops before the next chunk — the client lost its progress,
        // so it re-discovers the server offset via HEAD and continues.
        const resumeOffset = await driver.head(location);

        expect(resumeOffset).toBe(cut);

        const finished = await driver.patch(location, resumeOffset, bytes.slice(resumeOffset));

        // The completing chunk answers 200 (a partial one 204).
        expect(finished.status).toBe(200);
        expect(Number(finished.headers.get("upload-offset"))).toBe(total);
    });

    it("recovers a client-driven upload after the connection drops once", async () => {
        expect.hasAssertions();

        const wire = wireFetch(handler);

        wire.install();
        wire.dropNextPatch();

        const control = new UploadControl();
        // `retry` lets the TUS adapter re-HEAD and continue after the dropped PATCH.
        const adapter = createTusAdapter({ chunkSize: 64 * 1024, control, endpoint: ENDPOINT, maxRetries: 5, retry: true });
        const file = makeFile(400 * 1024, "resume.bin");

        const result = await adapter.upload(file);

        wire.restore();

        expect(result.bytesWritten ?? 0).toBe(400 * 1024);
        // The drop forced at least one HEAD (offset re-discovery) during recovery.
        expect(wire.requests.some((entry) => entry.method === "HEAD")).toBe(true);
    });

    describe("rLS enforcement (not admin-gated)", () => {
        const authzHandler = (authorize: (context: UploadAuthzContext) => boolean | Promise<boolean>) =>
            createUploadHandler({ authorize, storage: new MemoryStorage({ path: "/upload" }) });

        it("rejects a non-admin caller without permission (403, no admin token)", async () => {
            expect.hasAssertions();

            // The gate reads the caller's identity off the request — a plain user
            // header, NOT an admin token. Denial is a 403 the client surfaces.
            const gated = authzHandler((context) => context.request.headers.get("x-user-role") === "member");

            const denied = await gated.fetch(
                new Request(ENDPOINT, {
                    headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "10", "x-user-role": "anonymous" },
                    method: "POST",
                }),
            );

            expect(denied.status).toBe(403);

            const body: { error?: { code?: string } } = await denied.json();

            expect(body.error?.code).toBe("FORBIDDEN");
            // TUS requires the resumable header on every response, denials included.
            expect(denied.headers.get("Tus-Resumable")).toBe("1.0.0");
        });

        it("allows an authorized caller through the same gate", async () => {
            expect.hasAssertions();

            const gated = authzHandler((context) => context.request.headers.get("x-user-role") === "member");

            const allowed = await gated.fetch(
                new Request(ENDPOINT, {
                    headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "10", "x-user-role": "member" },
                    method: "POST",
                }),
            );

            expect(allowed.status).toBe(201);
            expect(allowed.headers.get("location")).toContain("/upload/");
        });

        it("denies a truthy non-boolean verdict — only an exact `true` allows the write", async () => {
            expect.hasAssertions();

            // The exact mistake the gate exists to survive: an untyped JS caller
            // writing `authorize: async ({ request }) => verifySignedUrl(new
            // URL(request.url), secret)` and forgetting `.valid`. That hands back
            // `{ valid: false }` — a DENIAL that is TRUTHY — and this is the write
            // path, so passing it through lets an attacker put bytes in the bucket.
            const gated = authzHandler(() => ({ valid: false }) as unknown as boolean);

            const response = await gated.fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "10" }, method: "POST" }));

            expect(response.status).toBe(403);
        });

        it("fails closed when the authorize callback throws", async () => {
            expect.hasAssertions();

            const gated = authzHandler(() => {
                throw new Error("identity lookup failed");
            });

            const response = await gated.fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "10" }, method: "POST" }));

            expect(response.status).toBe(403);
        });

        it("surfaces the denial to the client adapter as a failed upload (403)", async () => {
            expect.hasAssertions();

            const gated = authzHandler(() => false);
            const wire = wireFetch(gated);

            wire.install();

            const adapter = createTusAdapter({ endpoint: ENDPOINT });

            // The TUS adapter rejects when the RLS gate denies the create — the
            // 403 is carried through to the client rather than silently swallowed.
            await expect(adapter.upload(makeFile(50_000))).rejects.toThrow(/403/u);

            wire.restore();
        });
    });

    describe("default-open authorize warning", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("warns once (at construction, not per request) when authorize is omitted", async () => {
            expect.hasAssertions();

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const openHandler = createUploadHandler({ storage: new MemoryStorage({ path: "/upload" }) });

            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/no `authorize`/u);

            // Multiple requests against the SAME handler must not add more warnings.
            await openHandler.fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "10" }, method: "POST" }));
            await openHandler.fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "10" }, method: "POST" }));

            expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        it("does not warn when `silent: true` is passed", () => {
            expect.hasAssertions();

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

            createUploadHandler({ silent: true, storage: new MemoryStorage({ path: "/upload" }) });

            expect(warnSpy).not.toHaveBeenCalled();
        });

        it("does not warn when `public: true` is passed", () => {
            expect.hasAssertions();

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

            createUploadHandler({ public: true, storage: new MemoryStorage({ path: "/upload" }) });

            expect(warnSpy).not.toHaveBeenCalled();
        });

        it("does not warn when `authorize` is provided", () => {
            expect.hasAssertions();

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

            createUploadHandler({ authorize: () => true, storage: new MemoryStorage({ path: "/upload" }) });

            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe("default upload size cap", () => {
        it("rejects an upload above the default cap (no maxFileSize configured)", async () => {
            expect.hasAssertions();

            const openHandler = createUploadHandler({ silent: true, storage: new MemoryStorage({ path: "/upload" }) });

            // TUS declares the total size up-front via `Upload-Length` on the
            // `create` (POST) request, so this rejects before any body bytes
            // would need to be sent.
            const response = await openHandler.fetch(
                new Request(ENDPOINT, {
                    headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(DEFAULT_MAX_UPLOAD_BYTES + 1) },
                    method: "POST",
                }),
            );

            expect(response.status).toBe(413);
        });

        it("honors an explicit maxFileSize below the default, both rejecting and accepting relative to it", async () => {
            expect.hasAssertions();

            const tight = createUploadHandler({ maxFileSize: 1024, silent: true, storage: new MemoryStorage({ path: "/upload" }) });

            const tooBig = await tight.fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "2048" }, method: "POST" }));

            expect(tooBig.status).toBe(413);

            const withinCap = await tight.fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "512" }, method: "POST" }));

            expect(withinCap.status).toBe(201);
        });

        it("refuses chunked REST over createR2UploadStorage (S3 API), which stores chunks in arrival order", async () => {
            expect.hasAssertions();

            // The aws-light provider probes the bucket (`checkBucketAccess`) from its
            // constructor, over the network and unawaited. Answer it locally: on CI the
            // fake account's R2 endpoint fails the TLS handshake, and the rejection
            // lands after the test as an unhandled error that fails the run.
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(undefined, { status: 200 }));

            try {
                const s3 = () => createR2UploadStorage({ accessKeyId: "id", accountId: "acct", bucket: "uploads", path: "/upload", secretAccessKey: "secret" });

                expect(() => createUploadHandler({ protocol: "chunked-rest", silent: true, storage: s3() })).toThrow(
                    expect.objectContaining({
                        code: "VALIDATION_ERROR",
                        message: expect.stringMatching(/chunked REST is not supported over createR2UploadStorage.*"tus".*createR2BindingUploadStorage/),
                    }),
                );
                // TUS and multipart over the same provider are fine.
                expect(() => createUploadHandler({ protocol: "tus", silent: true, storage: s3() })).not.toThrow();
                expect(() => createUploadHandler({ protocol: "multipart", silent: true, storage: s3() })).not.toThrow();

                // The probes are signed asynchronously before they fetch; keep the stub
                // in place until all three constructors have issued theirs.
                await vi.waitFor(() => {
                    expect(fetchSpy).toHaveBeenCalledTimes(3);
                });
            } finally {
                fetchSpy.mockRestore();
            }
        });

        it("rejects a maxFileSize that is not a finite, non-negative number", async () => {
            expect.hasAssertions();

            // `??` only fills in a nullish value, so an unset upload-limit env
            // var coerced with `Number(...)` survives as `NaN` — and
            // `declaredSize > NaN` is always false, so
            // every TUS/chunked-REST create passed the only cap this handler
            // enforces for those protocols.
            expect(() => createUploadHandler({ maxFileSize: Number.NaN, silent: true, storage: new MemoryStorage({ path: "/upload" }) })).toThrow(
                /maxFileSize/,
            );
            expect(() => createUploadHandler({ maxFileSize: Number.POSITIVE_INFINITY, silent: true, storage: new MemoryStorage({ path: "/upload" }) })).toThrow(
                /maxFileSize/,
            );
            // The mirror image: a negative cap rejects every upload.
            expect(() => createUploadHandler({ maxFileSize: -1, silent: true, storage: new MemoryStorage({ path: "/upload" }) })).toThrow(/maxFileSize/);
        });

        it("rejects a chunked-REST create whose declared total (X-Total-Size) is over the cap", async () => {
            expect.hasAssertions();

            // A chunked-REST create carries NO body: the total lives in
            // `X-Total-Size` and `Content-Length` is zero/absent. Reading only
            // `Upload-Length`/`Content-Length` let this create through, leaving
            // the provider's own `maxUploadSize` (5 TB by default) as the sole
            // ceiling — the documented `maxFileSize` never fired.
            const tight = createUploadHandler({ maxFileSize: 1000, protocol: "chunked-rest", silent: true, storage: new MemoryStorage({ path: "/upload" }) });

            const tooBig = await tight.fetch(
                new Request(ENDPOINT, {
                    headers: { "content-type": "application/octet-stream", "x-chunked-upload": "true", "x-total-size": "5000000000" },
                    method: "POST",
                }),
            );

            expect(tooBig.status).toBe(413);

            const withinCap = await tight.fetch(
                new Request(ENDPOINT, {
                    headers: { "content-type": "application/octet-stream", "x-chunked-upload": "true", "x-total-size": "512" },
                    method: "POST",
                }),
            );

            expect(withinCap.status).toBe(201);
        });

        it("checks the largest declared size, so a small X-Total-Size cannot mask an oversized body", async () => {
            expect.hasAssertions();

            const tight = createUploadHandler({ maxFileSize: 1000, protocol: "chunked-rest", silent: true, storage: new MemoryStorage({ path: "/upload" }) });

            const response = await tight.fetch(
                new Request(ENDPOINT, {
                    body: new Uint8Array(4096).fill(65),
                    headers: { "content-length": "4096", "content-type": "application/octet-stream", "x-total-size": "10" },
                    method: "POST",
                }),
            );

            expect(response.status).toBe(413);
        });
    });
});

describe("createUploadHandler maxFileSizeFor (per-request cap)", () => {
    const MiB = 1024 * 1024;

    const capped = (maxFileSizeFor: (context: UploadSizeContext) => number | undefined | Promise<number | undefined>, maxFileSize = 100 * MiB) =>
        createUploadHandler({ maxFileSize, maxFileSizeFor, silent: true, storage: new MemoryStorage({ path: "/upload" }) });

    const byType = (context: UploadSizeContext): number | undefined => {
        if (context.contentType.startsWith("image/")) {
            return 1 * MiB;
        }

        return context.contentType.startsWith("video/") ? 50 * MiB : undefined;
    };

    const create = async (handler: UploadHandler, headers: Record<string, string>): Promise<Response> =>
        handler.fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", ...headers }, method: "POST" }));

    it("caps an upload by the type its TUS metadata declares", async () => {
        expect.hasAssertions();

        const handler = capped(byType);

        const image = (size: number) => create(handler, { "Upload-Length": String(size), "Upload-Metadata": `filetype ${B64("image/png")}` });

        await expect(image(2 * MiB)).resolves.toHaveProperty("status", 413);
        await expect(image(MiB)).resolves.toHaveProperty("status", 201);
        await expect(create(handler, { "Upload-Length": String(20 * MiB), "Upload-Metadata": `filetype ${B64("video/mp4")}` })).resolves.toHaveProperty(
            "status",
            201,
        );
    });

    it("hands the decoded metadata and declared size to the callback", async () => {
        expect.hasAssertions();

        const seen: UploadSizeContext[] = [];
        const handler = capped((context) => {
            seen.push(context);

            return undefined;
        });

        await create(handler, { "Upload-Length": "42", "Upload-Metadata": `filename ${B64("résumé.pdf")},filetype ${B64("application/pdf")},flag` });

        expect(seen[0]?.metadata).toStrictEqual({ filename: "résumé.pdf", filetype: "application/pdf", flag: "" });
        expect(seen[0]?.contentType).toBe("application/pdf");
        expect(seen[0]?.declaredSize).toBe(42);
        expect(seen[0]?.method).toBe("POST");
    });

    it("never raises the cap past maxFileSize", async () => {
        expect.hasAssertions();

        const handler = capped(() => 10 * MiB, MiB);

        await expect(create(handler, { "Upload-Length": String(2 * MiB) })).resolves.toHaveProperty("status", 413);
    });

    it("refuses a create that declares no size once a cap applies", async () => {
        expect.hasAssertions();

        const handler = capped(() => MiB);

        await expect(create(handler, { "Upload-Defer-Length": "1" })).resolves.toHaveProperty("status", 413);
    });

    it("fails closed when the callback throws or answers something that is not a size", async () => {
        expect.hasAssertions();

        const throwing = capped(() => {
            throw new Error("lookup failed");
        });
        const nonsense = capped(() => Number.NaN);

        await expect(create(throwing, { "Upload-Length": "10" })).resolves.toHaveProperty("status", 403);
        await expect(create(nonsense, { "Upload-Length": "10" })).resolves.toHaveProperty("status", 403);
    });

    it("runs only on creates, after the authorize gate", async () => {
        expect.hasAssertions();

        const maxFileSizeFor = vi.fn<(context: UploadSizeContext) => number | undefined>(() => undefined);
        const handler = createUploadHandler({
            authorize: ({ request }) => request.headers.get("x-user") === "member",
            maxFileSizeFor,
            storage: new MemoryStorage({ path: "/upload" }),
        });

        await expect(create(handler, { "Upload-Length": "10" })).resolves.toHaveProperty("status", 403);
        expect(maxFileSizeFor).not.toHaveBeenCalled();

        const created = await create(handler, { "Upload-Length": "10", "x-user": "member" });
        const location = new URL(created.headers.get("location") ?? "", ENDPOINT).href;

        await handler.fetch(new Request(location, { headers: { "Tus-Resumable": "1.0.0", "x-user": "member" }, method: "HEAD" }));

        expect(maxFileSizeFor).toHaveBeenCalledTimes(1);
    });

    it("caps a chunked-REST create by its Content-Type, the type that gets stored, not its metadata", async () => {
        expect.hasAssertions();

        const seen: UploadSizeContext[] = [];
        const handler = createUploadHandler({
            maxFileSizeFor: (context) => {
                seen.push(context);

                return byType(context);
            },
            protocol: "chunked-rest",
            silent: true,
            storage: new MemoryStorage({ path: "/upload" }),
        });

        const response = await handler.fetch(
            new Request(ENDPOINT, {
                headers: {
                    "content-type": "image/jpeg",
                    "x-chunked-upload": "true",
                    "x-file-metadata": JSON.stringify({ filetype: "video/mp4", size: 3 }),
                    "x-total-size": String(2 * MiB),
                },
                method: "POST",
            }),
        );

        expect(response.status).toBe(413);
        expect(seen[0]?.contentType).toBe("image/jpeg");
        expect(seen[0]?.metadata).toStrictEqual({ filetype: "video/mp4", size: "3" });
    });

    it("resolves a TUS type the way the stored file does: mimeType, then type, then filetype (regression)", async () => {
        expect.hasAssertions();

        const handler = capped(byType);

        // A small `filetype` beside an image `mimeType` used to pick the lenient video cap.
        await expect(
            create(handler, {
                "Upload-Length": "1000000000",
                "Upload-Metadata": `filename ${B64("a.png")},filetype ${B64("video/mp4")},mimeType ${B64("image/png")}`,
            }),
        ).resolves.toHaveProperty("status", 413);
    });

    it("decodes url-safe base64 metadata as the TUS handler does", async () => {
        expect.hasAssertions();

        const seen: UploadSizeContext[] = [];
        const handler = capped((context) => {
            seen.push(context);

            return undefined;
        });
        const urlSafe = Buffer.from("?>?>").toString("base64url");

        await create(handler, { "Upload-Length": "1", "Upload-Metadata": `filename ${urlSafe}` });

        expect(seen[0]?.metadata).toStrictEqual({ filename: "?>?>" });
    });

    it.each(["-1", "1.5", "abc", "1e3", ""])("reads a declared size of %j as too large, never as small (regression)", async (length) => {
        expect.hasAssertions();

        const maxFileSizeFor = vi.fn<(context: UploadSizeContext) => number | undefined>(() => 10);
        const handler = capped(maxFileSizeFor);

        await expect(create(handler, { "Upload-Length": length })).resolves.toHaveProperty("status", 413);
    });
});

describe("createUploadHandler chunked REST", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("uploads a file end to end: POST init, two in-order PATCHes, HEAD reports it complete (visulima/visulima#884)", async () => {
        expect.hasAssertions();

        // `@visulima/storage` 2.0.8 to 2.0.22 answered every chunked-REST PATCH
        // with 400: its create never marked the upload as chunked.
        const storage = new MemoryStorage({ path: "/upload" });
        const driver = chunkedRest(createUploadHandler({ protocol: "chunked-rest", silent: true, storage }));
        const bytes = new TextEncoder().encode("0123456789");
        const location = await driver.create(bytes.byteLength, "text/plain");

        const first = await driver.patch(location, 0, bytes.slice(0, 5));

        expect(first.status).toBe(202);
        expect(first.headers.get("x-upload-offset")).toBe("5");
        expect(first.headers.get("x-upload-complete")).toBe("false");

        const second = await driver.patch(location, 5, bytes.slice(5));

        expect(second.status).toBe(200);
        expect(second.headers.get("x-upload-offset")).toBe("10");
        expect(second.headers.get("x-upload-complete")).toBe("true");

        const head = await driver.head(location);

        expect(head.status).toBe(200);
        expect(head.headers.get("x-upload-complete")).toBe("true");
        expect(head.headers.get("x-upload-offset")).toBe("10");

        // Read back from the provider: the upload route itself is write-only.
        const stored = await storage.get({ id: uploadId(location) });

        expect(Buffer.from(stored.content).toString()).toBe("0123456789");
    });

    it("stores chunks sent out of order at their offsets (visulima/visulima#893)", async () => {
        expect.hasAssertions();

        const storage = new MemoryStorage({ path: "/upload" });
        const driver = chunkedRest(createUploadHandler({ protocol: "chunked-rest", silent: true, storage }));
        const location = await driver.create(10, "text/plain");

        const second = await driver.patch(location, 5, new TextEncoder().encode("BBBBB"));

        expect(second.status).toBe(202);
        expect(second.headers.get("x-upload-complete")).toBe("false");

        const first = await driver.patch(location, 0, new TextEncoder().encode("AAAAA"));

        expect(first.status).toBe(200);
        expect(first.headers.get("x-upload-complete")).toBe("true");

        const stored = await storage.get({ id: uploadId(location) });

        expect(Buffer.from(stored.content).toString()).toBe("AAAAABBBBB");
    });

    it("lets the bundled client finish a multi-chunk upload through the write-only route (visulima/visulima#895)", async () => {
        expect.hasAssertions();

        const storage = new MemoryStorage({ path: "/upload" });
        const route = routedFetch(createUploadHandler({ protocol: "chunked-rest", silent: true, storage }));

        vi.stubGlobal("fetch", route.fetch);

        const bytes = new Uint8Array(40_000).map((_, index) => index % 251);
        const adapter = createChunkedRestAdapter({ chunkSize: 10_000, endpoint: ENDPOINT, retry: false });
        const result = await adapter.upload(new File([bytes], "four.bin", { type: "application/octet-stream" }));

        expect(result).toMatchObject({ bytesWritten: 40_000, status: "completed" });
        expect(route.requests.filter((request) => request.startsWith("PATCH"))).toHaveLength(4);
        // The client never asks for the file's bytes. Its four chunks run in
        // parallel, and over MemoryStorage their `_chunks` updates race, so no
        // PATCH may report the upload complete; it then tries `/metadata`, gets
        // 405, and builds the result from what it knows.
        expect(route.requests.filter((request) => request.startsWith("GET") && !request.endsWith("/metadata"))).toStrictEqual([]);

        const stored = await storage.get({ id: result.id });

        expect(Buffer.from(stored.content).equals(Buffer.from(bytes))).toBe(true);
    });

    it("answers PATCH with a Location of <collection>/<id>.<ext>, without the id repeated (2.0.24)", async () => {
        expect.hasAssertions();

        const handler = createUploadHandler({ protocol: "chunked-rest", silent: true, storage: new MemoryStorage({ path: "/upload" }) });
        const created = await handler.fetch(
            new Request(ENDPOINT, { headers: { "content-type": "text/plain", "x-chunked-upload": "true", "x-total-size": "4" }, method: "POST" }),
        );
        const location = new URL(created.headers.get("location") ?? "", ENDPOINT);
        const patched = await handler.fetch(
            new Request(location, {
                body: new Uint8Array(4),
                headers: { "content-length": "4", "content-type": "application/octet-stream", "x-chunk-offset": "0" },
                method: "PATCH",
            }),
        );
        const patchedLocation = new URL(patched.headers.get("location") ?? "", ENDPOINT);
        const segments = patchedLocation.pathname.split("/").filter(Boolean);

        expect(patched.status).toBe(200);
        // `/upload/<id>.txt`: one segment after the collection, the id not repeated.
        expect(segments).toHaveLength(2);
        expect(segments[0]).toBe("upload");
        expect(patchedLocation.pathname).toBe(location.pathname);
    });

    it("creates a file with PUT under a word-character id, and refuses a dotted one (400, 2.0.24)", async () => {
        expect.hasAssertions();

        const maxFileSizeFor = vi.fn<(context: UploadSizeContext) => number | undefined>(() => 1000);
        const handler = createUploadHandler({ maxFileSizeFor, protocol: "chunked-rest", silent: true, storage: new MemoryStorage({ path: "/upload" }) });
        const put = async (name: string): Promise<Response> =>
            handler.fetch(
                new Request(`${ENDPOINT}/${name}`, {
                    body: new Uint8Array(3).fill(1),
                    headers: { "content-length": "3", "content-type": "application/pdf" },
                    method: "PUT",
                }),
            );

        const created = await put("report-v2.pdf");

        expect(created.status).toBe(201);
        expect(new URL(created.headers.get("location") ?? "", ENDPOINT).pathname).toBe("/upload/report-v2.pdf");

        // The per-upload cap still runs on a PUT create, and an id with a dot
        // before its extension is then refused upstream.
        await expect(put("report.v2.pdf")).resolves.toHaveProperty("status", 400);
        expect(maxFileSizeFor).toHaveBeenCalledTimes(2);
        expect(maxFileSizeFor.mock.calls[0]?.[0]).toMatchObject({ contentType: "application/pdf", declaredSize: 3, method: "PUT" });
    });
});
