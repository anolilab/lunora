import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startStudioServer } from "../../src/util/studio-server";

/** Bind a throwaway TCP server to the system-assigned port and return both. */
const bindPort = (): Promise<{ port: number; server: ReturnType<typeof createServer> }> =>
    new Promise((resolve, reject) => {
        const server = createServer();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            if (!address || typeof address === "string") {
                reject(new Error("unexpected address shape"));

                return;
            }

            resolve({ port: address.port, server });
        });
    });

/** Close any `.close(callback)`-shaped server (net or http) and resolve once it has. */
const closeServer = (server: { close: (callback: () => void) => void }): Promise<void> =>
    new Promise((resolve) => {
        server.close(() => {
            resolve();
        });
    });

const getFreePort = async (): Promise<number> => {
    const { port, server } = await bindPort();

    await closeServer(server);

    return port;
};

const requestStudio = (port: number, path: string, host: string): Promise<{ body: string; statusCode: number | undefined }> =>
    new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                headers: { host },
                hostname: "127.0.0.1",
                method: "GET",
                path,
                port,
            },
            (response) => {
                let body = "";

                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    body += chunk;
                });
                response.on("end", () => {
                    resolve({ body, statusCode: response.statusCode });
                });
            },
        );

        request.on("error", reject);
        request.end();
    });

/** Like {@link requestStudio}, but with full control over the request headers (beyond just `Host`). */
const requestStudioWithHeaders = (port: number, path: string, headers: Record<string, string>): Promise<{ body: string; statusCode: number | undefined }> =>
    new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                headers,
                hostname: "127.0.0.1",
                method: "GET",
                path,
                port,
            },
            (response) => {
                let body = "";

                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    body += chunk;
                });
                response.on("end", () => {
                    resolve({ body, statusCode: response.statusCode });
                });
            },
        );

        request.on("error", reject);
        request.end();
    });

/** A throwaway `wrangler dev`-shaped worker stub that records every hit, for asserting the proxy never reaches it. */
const startStubWorker = (): Promise<{ close: () => Promise<void>; hits: string[]; url: string }> =>
    new Promise((resolve, reject) => {
        const hits: string[] = [];
        const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
            hits.push(request.url ?? "/");
            response.statusCode = 200;
            response.end("{}");
        });

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            if (!address || typeof address === "string") {
                reject(new Error("unexpected address shape"));

                return;
            }

            resolve({ close: () => closeServer(server), hits, url: `http://127.0.0.1:${String(address.port)}` });
        });
    });

/**
 * A raw TCP stub standing in for the `wrangler dev` worker's WS endpoint: any
 * connection immediately gets a `101 Switching Protocols` reply. Used to prove
 * the studio server's WS guard rejects a forwarded upgrade itself — pointing
 * `proxyUpgrade` at a real listener (rather than an address nothing listens
 * on) means a successful 101 can only arrive by the guard having let the
 * request through, not by an incidental upstream-connect failure.
 */
const startStubUpgradeWorker = (): Promise<{ close: () => Promise<void>; url: string }> =>
    new Promise((resolve, reject) => {
        const server = createServer((socket) => {
            socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "", ""].join("\r\n"));
        });

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            if (!address || typeof address === "string") {
                reject(new Error("unexpected address shape"));

                return;
            }

            resolve({ close: () => closeServer(server), url: `http://127.0.0.1:${String(address.port)}` });
        });
    });

describe("startStudioServer", () => {
    const blockers: ReturnType<typeof createServer>[] = [];

    afterEach(async () => {
        await Promise.all(
            blockers.map(
                (server) =>
                    new Promise<void>((resolve) => {
                        server.close(() => {
                            resolve();
                        });
                    }),
            ),
        );
        blockers.length = 0;
    });

    it("rejects with a friendly message naming the port and --port flag when EADDRINUSE", async () => {
        expect.assertions(2);

        // Bind a blocker on a free port, then try to start the studio on the same port.
        const { port, server } = await bindPort();

        blockers.push(server);

        const portString = String(port);

        await expect(startStudioServer({ cwd: "/tmp", port, workerOrigin: "http://localhost:8787" })).rejects.toThrow(
            new RegExp(`studio port ${portString}.*--port`, "u"),
        );

        // The cause must be the original EADDRINUSE error.
        await expect(startStudioServer({ cwd: "/tmp", port, workerOrigin: "http://localhost:8787" })).rejects.toSatisfy(
            (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "EADDRINUSE",
        );
    });

    it("serves the read-only shell on a non-loopback bind with a LAN Host header", async () => {
        expect.assertions(4);

        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", host: "0.0.0.0", port, workerOrigin: "http://localhost:8787" });

        try {
            const shell = await requestStudio(port, "/", `192.168.1.50:${String(port)}`);
            const proxy = await requestStudio(port, "/_lunora/admin/query", `192.168.1.50:${String(port)}`);

            expect(shell.statusCode).toBe(200);
            expect(shell.body).toContain("<!doctype html>");
            expect(proxy.statusCode).toBe(403);
            expect(proxy.body).toContain("worker admin proxy is only available on a loopback bind");
        } finally {
            await studio.close();
        }
    });

    it("keeps the DNS-rebinding Host guard on loopback binds", async () => {
        expect.assertions(2);

        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", port, workerOrigin: "http://localhost:8787" });

        try {
            const response = await requestStudio(port, "/", `evil.example:${String(port)}`);

            expect(response.statusCode).toBe(403);
            // Message text now comes from the shared `transportRejectionReason`
            // (`@lunora/config/studio-host`) rather than a CLI-local literal.
            expect(response.body).toContain("non-localhost Host header");
        } finally {
            await studio.close();
        }
    });

    it("serves the document on a plain loopback GET (no regression)", async () => {
        expect.assertions(2);

        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", port, workerOrigin: "http://localhost:8787" });

        try {
            const response = await requestStudio(port, "/", `127.0.0.1:${String(port)}`);

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain("<!doctype html>");
        } finally {
            await studio.close();
        }
    });

    it("refuses a forwarded request even with a localhost Host (shared transport guard)", async () => {
        expect.assertions(4);

        // Fails against pre-fix code: the CLI's old `isLoopbackHost` only
        // checked the `Host` literal, so a relay presenting `Host: localhost`
        // plus an `X-Forwarded-For`/`Forwarded` header was served the
        // token-bearing document (200), not refused (403).
        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", port, workerOrigin: "http://localhost:8787" });

        try {
            const xForwardedFor = await requestStudioWithHeaders(port, "/", { "x-forwarded-for": "203.0.113.7", host: `localhost:${String(port)}` });
            const forwarded = await requestStudioWithHeaders(port, "/", { forwarded: "for=203.0.113.7", host: `localhost:${String(port)}` });

            expect(xForwardedFor.statusCode).toBe(403);
            expect(xForwardedFor.body).not.toContain("<!doctype html>");
            expect(forwarded.statusCode).toBe(403);
            expect(forwarded.body).not.toContain("<!doctype html>");
        } finally {
            await studio.close();
        }
    });

    it("refuses a forwarded request to the worker admin proxy without contacting the worker", async () => {
        expect.assertions(2);

        // Fails against pre-fix code: `isLoopbackHost` never looked at
        // forwarding headers, so a relayed request reached `proxyHttp` and
        // hit the (possibly privileged) worker.
        const worker = await startStubWorker();
        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", port, workerOrigin: worker.url });

        try {
            const response = await requestStudioWithHeaders(port, "/_lunora/admin/query", {
                "x-forwarded-host": "evil.example",
                host: `localhost:${String(port)}`,
            });

            expect(response.statusCode).toBe(403);
            expect(worker.hits).toStrictEqual([]);
        } finally {
            await studio.close();
            await worker.close();
        }
    });

    it("destroys a WS upgrade carrying a forwarding header on a loopback peer", async () => {
        expect.assertions(1);

        // Fails against pre-fix code: the WS path only mirrored the old
        // Host-literal check, so a forwarded upgrade with a loopback-looking
        // Host would have proceeded to `proxyUpgrade`, which would reach the
        // stub worker below and relay its `101` back to the client.
        const worker = await startStubUpgradeWorker();
        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", port, workerOrigin: worker.url });

        try {
            const closed = await new Promise<boolean>((resolve, reject) => {
                const socket = connect(port, "127.0.0.1", () => {
                    socket.write(
                        [
                            `GET /_lunora/ws HTTP/1.1`,
                            `Host: localhost:${String(port)}`,
                            "Connection: Upgrade",
                            "Upgrade: websocket",
                            // eslint-disable-next-line no-secrets/no-secrets -- the RFC 6455 example handshake key, not a real secret
                            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
                            "Sec-WebSocket-Version: 13",
                            "X-Forwarded-For: 203.0.113.7",
                            "",
                            "",
                        ].join("\r\n"),
                    );
                });

                let receivedBytes = false;

                socket.on("data", () => {
                    receivedBytes = true;
                });
                socket.on("close", () => {
                    // A destroyed socket ends the connection without ever writing a
                    // `101 Switching Protocols` (or any other) response. The stub
                    // upstream above is a real listener, so a `101` can only arrive
                    // here if the guard let the upgrade through to `proxyUpgrade`.
                    resolve(!receivedBytes);
                });
                socket.on("error", reject);
            });

            expect(closed).toBe(true);
        } finally {
            await studio.close();
            await worker.close();
        }
    });

    it("permits a loopback socket peer with no Host header at all (accepted semantic delta)", async () => {
        expect.assertions(1);

        // Deliberate behaviour change from the CLI's prior standalone guard,
        // which rejected an absent Host outright (`hostHeader === undefined`
        // → reject). The shared `transportRejectionReason` permits it: with
        // the socket-peer check in front, an absent Host means a local
        // non-browser client; browsers — the only DNS-rebinding vector —
        // always send Host. See plan 296 §4.
        //
        // An HTTP/1.1 request without a `Host` header is itself malformed
        // (Node's `http` server 400s it before the handler ever runs), so
        // this is driven as a raw HTTP/1.0 request over the socket — the one
        // real-world shape that legitimately omits `Host`.
        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", port, workerOrigin: "http://localhost:8787" });

        try {
            const body = await new Promise<string>((resolve, reject) => {
                const socket = connect(port, "127.0.0.1", () => {
                    socket.write(["GET / HTTP/1.0", "", ""].join("\r\n"));
                });
                let raw = "";

                socket.setEncoding("utf8");
                socket.on("data", (chunk: string) => {
                    raw += chunk;
                });
                socket.on("close", () => {
                    resolve(raw);
                });
                socket.on("error", reject);
            });

            expect(body).toContain("<!doctype html>");
        } finally {
            await studio.close();
        }
    });

    it("serves standalone JS from the directory and rejects path traversal", async () => {
        expect.assertions(5);

        const port = await getFreePort();
        const studio = await startStudioServer({ cwd: "/tmp", port, workerOrigin: "http://localhost:8787" });
        const loopbackHost = `127.0.0.1:${String(port)}`;

        try {
            const entry = await requestStudio(port, "/studio.js", loopbackHost);
            // A `.js` request that escapes the standalone directory: the server takes
            // the basename and the resolver rejects anything outside the dir.
            const traversal = await requestStudio(port, "/../../../../../../etc/passwd.js", loopbackHost);
            const unknownChunk = await requestStudio(port, "/chunk-DOESNOTEXIST0.js", loopbackHost);

            // The entry is served from the standalone directory when the studio is
            // built (200), or reports "not built" (501) — never a traversal leak.
            expect([200, 501]).toContain(entry.statusCode);

            // A traversal `.js` request must never be served: 404 when the studio is
            // built (the file isn't in the dir), 501 when it isn't — never 200, and
            // never the target file's contents.
            expect([404, 501]).toContain(traversal.statusCode);
            expect(traversal.body).not.toContain("root:");

            // An unknown chunk resolves to 404 (built) / 501 (not) — never the SPA
            // document, which would hand a module request an HTML body.
            expect([404, 501]).toContain(unknownChunk.statusCode);
            expect(unknownChunk.body).not.toContain("<!doctype html>");
        } finally {
            await studio.close();
        }
    });
});
