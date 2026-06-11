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
});
