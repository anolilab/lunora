import type { Server } from "node:net";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { findAvailablePort, isPortFree } from "../../src/util/free-port";

const HOST = "127.0.0.1";

let held: Server | undefined;

/** Bind a real server on `port` for the duration of a test (released in afterEach). */
const occupy = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
        const server = createServer();

        server.once("error", reject);
        server.listen(port, HOST, () => {
            held = server;
            resolve();
        });
    });

/** Grab an OS-assigned free port, release it, and return the number — a port known-free right now. */
const grabFreePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();

        probe.once("error", reject);
        probe.listen(0, HOST, () => {
            const address = probe.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;

            probe.close(() => {
                resolve(port);
            });
        });
    });

describe("free-port", () => {
    afterEach(async () => {
        await new Promise<void>((resolve) => {
            if (held) {
                held.close(() => {
                    resolve();
                });
            } else {
                resolve();
            }
        });

        held = undefined;
    });

    describe(isPortFree, () => {
        it("is true for a free port and false for a bound one", async () => {
            expect.assertions(2);

            const port = await grabFreePort();

            await expect(isPortFree(port)).resolves.toBe(true);

            await occupy(port);

            await expect(isPortFree(port)).resolves.toBe(false);
        });
    });

    describe(findAvailablePort, () => {
        it("returns the preferred port when it is free", async () => {
            expect.assertions(1);

            const port = await grabFreePort();

            await expect(findAvailablePort(port)).resolves.toBe(port);
        });

        it("skips a busy port and returns a higher free one", async () => {
            expect.assertions(1);

            const port = await grabFreePort();

            await occupy(port);

            await expect(findAvailablePort(port)).resolves.toBeGreaterThan(port);
        });

        it("falls back to the preferred port when the whole window is busy", async () => {
            expect.assertions(1);

            const port = await grabFreePort();

            await occupy(port);

            // A single-port window that is occupied — no free port to find, so it
            // hands back the preferred and lets wrangler surface the bind error.
            await expect(findAvailablePort(port, HOST, 1)).resolves.toBe(port);
        });
    });
});
