import { request as httpRequest } from "node:http";
import { createServer } from "node:net";

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

const closeServer = (server: ReturnType<typeof createServer>): Promise<void> =>
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
            expect(response.body).toContain("DNS-rebinding guard");
        } finally {
            await studio.close();
        }
    });
});
