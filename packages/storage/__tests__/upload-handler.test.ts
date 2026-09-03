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
import { createTusAdapter, UploadControl } from "@visulima/storage-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadAuthzContext } from "../src/upload-handler";
import { createUploadHandler, DEFAULT_MAX_UPLOAD_BYTES } from "../src/upload-handler";

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
        // Progress is monotonic and reaches 100.
        expect(progress.at(-1)).toBe(100);
        expect(progress.length).toBeGreaterThan(1);
        // The upload went through the RLS route (POST create + PATCH chunks), never an admin path.
        expect(wire.requests.some((entry) => entry.method === "POST")).toBe(true);
        expect(wire.requests.some((entry) => entry.method === "PATCH")).toBe(true);
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

        expect(first.status).toBe(200);
        expect(Number(first.headers.get("upload-offset"))).toBe(cut);

        // A HEAD while paused still reports the persisted offset — resume anchor.
        await expect(driver.head(location)).resolves.toBe(cut);

        // "Resume": finish from the reported offset.
        const rest = await driver.patch(location, cut, bytes.slice(cut));

        expect(rest.status).toBe(204);
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

        expect(finished.status).toBe(204);
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
    });
});
