import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { printWorkerLine, resolveWorkerPort, startWorker } from "../src/worker";
import { createFixture } from "./fixture";

/** The refusal a port already held by another process must produce. */
const PORT_IN_USE_RE = /already in use/u;

const roots: string[] = [];

/**
 * Put a fake `wrangler` first on PATH that listens on `--port` and stays up.
 *
 * The lifecycle worth testing here is this package's, not wrangler's: spawn,
 * wait for the port, stream output, terminate. A stub exercises all of it in
 * milliseconds without workerd, a Cloudflare account, or a real bundle — and it
 * lets the "worker did not come up" and "worker stopped" paths be asserted,
 * which a real wrangler makes slow and flaky.
 */
const stubWranglerOnPath = (): string => {
    const binDirectory = mkdtempSync(join(tmpdir(), "lunora-stub-bin-"));

    roots.push(binDirectory);

    writeFileSync(
        join(binDirectory, "wrangler"),
        [
            "#!/usr/bin/env node",
            'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
            // A real lunora structured event, so the formatter branch runs too.
            'console.log(JSON.stringify({ function: "messages:list", message: "ready", source: "lunora", type: "log" }));',
            'require("node:http")',
            "    .createServer((_, response) => {",
            '        response.end("ok");',
            "    })",
            '    .listen(port, "127.0.0.1");',
            "",
        ].join("\n"),
        "utf8",
    );
    chmodSync(join(binDirectory, "wrangler"), 0o755);

    return binDirectory;
};

/** `true` once something accepts a connection on `port`. */
const accepts = async (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const settle = (ready: boolean): void => {
            socket.destroy();
            resolve(ready);
        };

        socket.once("connect", () => {
            settle(true);
        });
        socket.once("error", () => {
            settle(false);
        });
    });

/** An OS-assigned free port, released before the caller binds it. */
const freePort = async (): Promise<number> => {
    const { createServer } = await import("node:net");
    const server = createServer();

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });

    const { port } = server.address() as { port: number };

    await new Promise<void>((resolve) => {
        server.close(() => {
            resolve();
        });
    });

    return port;
};

describe(resolveWorkerPort, () => {
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("prefers an explicit option over the wrangler config", () => {
        expect.assertions(1);

        const root = createFixture({ wranglerDevPort: 8799 });

        roots.push(root);

        expect(resolveWorkerPort(root, 9001)).toBe(9001);
    });

    it("falls back to 8787 when nothing pins a port", () => {
        expect.assertions(1);

        const root = createFixture();

        roots.push(root);

        // Deliberately not a free-port search: a moving port would leave the
        // `.dev.vars` origins that name 8787 pointing at nothing.
        expect(resolveWorkerPort(root)).toBe(8787);
    });
});

describe(printWorkerLine, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("routes a lunora event through the shared formatter", () => {
        expect.assertions(1);

        const info = vi.spyOn(console, "info").mockImplementation(() => {});

        printWorkerLine(JSON.stringify({ function: "messages:list", message: "hello", source: "lunora", type: "log" }));

        // Formatted and badged, so the worker's own `ctx.log.*` output reads the
        // same here as it does under `lunora dev`.
        expect(info.mock.calls.flat().join("")).toContain("messages:list");
    });

    it("passes a non-lunora line through untouched", () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        // wrangler's own banner and errors are worth seeing verbatim.
        printWorkerLine("Ready on http://localhost:8787");

        expect(log).toHaveBeenCalledWith("Ready on http://localhost:8787");
    });

    it("drops a blank line rather than echoing it", () => {
        expect.assertions(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        printWorkerLine("   ");

        expect(log).not.toHaveBeenCalled();
    });
});

describe(startWorker, () => {
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }

        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("refuses to start when the port is already held by someone else", async () => {
        expect.assertions(1);

        const root = createFixture();

        roots.push(root);

        const binDirectory = stubWranglerOnPath();

        vi.stubEnv("PATH", `${binDirectory}:${process.env.PATH ?? ""}`);

        // Something else — an orphaned wrangler, a second `rsbuild dev`, `lunora
        // dev` in another terminal — is already serving. `accepts()` cannot tell
        // that process from ours, so without a pre-flight check the readiness poll
        // succeeds on its first iteration and the dev server proxies `/_lunora/*`
        // to a FOREIGN worker while the one spawned here dies of "port in use".
        const { createServer } = await import("node:net");
        const squatter = createServer();

        await new Promise<void>((resolve) => {
            squatter.listen(0, "127.0.0.1", resolve);
        });

        const { port } = squatter.address() as { port: number };

        try {
            await expect(startWorker({ port, projectRoot: root })).rejects.toThrow(PORT_IN_USE_RE);
        } finally {
            await new Promise<void>((resolve) => {
                squatter.close(() => {
                    resolve();
                });
            });
        }
    }, 45_000);

    it("creates the assets directory wrangler dev refuses to start without", async () => {
        expect.assertions(1);

        vi.spyOn(console, "log").mockImplementation(() => {});

        const root = createFixture();

        roots.push(root);

        const wranglerPath = join(root, "wrangler.jsonc");

        // The directory is the gitignored build output, so a fresh clone has none
        // — and wrangler exits before listening when it is missing.
        writeFileSync(
            wranglerPath,
            readFileSync(wranglerPath, "utf8").replace('"name": "lunora-app",', '"name": "lunora-app",\n    "assets": { "directory": "./dist/client" },'),
            "utf8",
        );

        const binDirectory = stubWranglerOnPath();

        vi.stubEnv("PATH", `${binDirectory}:${process.env.PATH ?? ""}`);

        const worker = await startWorker({ port: await freePort(), projectRoot: root });

        await worker.stop();

        expect(existsSync(join(root, "dist", "client"))).toBe(true);
    }, 45_000);

    it("resolves once the worker accepts connections, and stop() ends it", async () => {
        expect.assertions(3);

        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "info").mockImplementation(() => {});

        const root = createFixture();

        roots.push(root);

        const binDirectory = stubWranglerOnPath();

        vi.stubEnv("PATH", `${binDirectory}:${process.env.PATH ?? ""}`);

        const port = await freePort();
        const worker = await startWorker({ port, projectRoot: root });

        expect(worker.port).toBe(port);

        // Resolving BEFORE the port listens is the bug this guards: the dev
        // server starts proxying the moment this returns, and a request to a
        // port nothing holds fails outright rather than retrying.
        await expect(accepts(port)).resolves.toBe(true);

        await worker.stop();

        await expect(accepts(port)).resolves.toBe(false);
    }, 45_000);
});
