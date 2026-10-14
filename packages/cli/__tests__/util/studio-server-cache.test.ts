/**
 * Cache headers on the CLI studio host (`lunora dev` without Vite). The studio
 * entry + stylesheet sit at stable, unhashed URLs, so serving them with no
 * cache headers lets the browser heuristically cache them and shadow a
 * rebuilt `@lunora/studio` until a hard reload — and the SPA document embeds
 * the admin token, so it must never enter any cache at all.
 *
 * `@lunora/studio` is not installed for these tests, so the asset loaders are
 * stubbed with fixed bytes + a fixed stamp; everything else in the shared
 * studio-host module stays real.
 */
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startStudioServer } from "../../src/util/studio-server";

const STAMP = 1234;

// eslint-disable-next-line vitest/prefer-import-in-mock -- `vi.mock(import("@lunora/config/studio-host"), ...)` type-checks the mock's shape against the module's `default`-bearing type, which this partial re-export doesn't satisfy
vi.mock("@lunora/config/studio-host", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lunora/config/studio-host")>();

    return {
        ...actual,
        loadStudioAssets: (): { script: Buffer; styles: Buffer } => {
            return { script: Buffer.from("// studio entry\n"), styles: Buffer.from("body {}\n") };
        },
        studioAssetsStamp: (): number => STAMP,
    };
});

const getFreePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;

            server.close(() => {
                resolve(port);
            });
        });
    });

const get = (
    port: number,
    path: string,
    headers: Record<string, string> = {},
): Promise<{ body: string; headers: Record<string, string | string[] | undefined>; statusCode: number | undefined }> =>
    new Promise((resolve, reject) => {
        const request = httpRequest(
            { headers: { host: `127.0.0.1:${String(port)}`, ...headers }, hostname: "127.0.0.1", method: "GET", path, port },
            (response) => {
                let body = "";

                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    body += chunk;
                });
                response.on("end", () => {
                    resolve({ body, headers: response.headers, statusCode: response.statusCode });
                });
            },
        );

        request.on("error", reject);
        request.end();
    });

describe("studio server cache headers", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("serves assets with no-cache + a stamp-keyed weak ETag and answers 304 on a match", async () => {
        expect.assertions(6);

        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", port, workerOrigin: "http://localhost:8787" });

        try {
            const fresh = await get(port, "/styles.css");
            const etag = `W/"styles.css-${String(STAMP)}"`;

            expect(fresh.statusCode).toBe(200);
            expect(fresh.headers["cache-control"]).toBe("no-cache");
            expect(fresh.headers.etag).toBe(etag);
            expect(fresh.body).toBe("body {}\n");

            const revalidated = await get(port, "/styles.css", { "if-none-match": etag });

            expect(revalidated.statusCode).toBe(304);
            expect(revalidated.body).toBe("");
        } finally {
            await studio.close();
        }
    });

    it("serves the token-bearing SPA document with no-store and no ETag", async () => {
        expect.assertions(3);

        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", port, workerOrigin: "http://localhost:8787" });

        try {
            const document = await get(port, "/");

            expect(document.statusCode).toBe(200);
            expect(document.headers["cache-control"]).toBe("no-store");
            expect(document.headers.etag).toBeUndefined();
        } finally {
            await studio.close();
        }
    });
});
