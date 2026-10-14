import { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startCelldDevSession } from "../src/celld/dev-session";
import type { DevProcessSpawner } from "../src/dev-process";

/** A free TCP port, released before it is handed back. */
const freePort = async (): Promise<number> =>
    new Promise((resolve) => {
        const server = createServer();

        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            server.close(() => {
                resolve(typeof address === "object" && address !== null ? address.port : 0);
            });
        });
    });

interface Started {
    child: ChildProcess;
    config: string;
    port: number;
}

/**
 * A stand-in for `celld dev`: it listens on the `--port` it is given until it
 * is killed, recording what it was started with. `refuse` makes the matching
 * start exit at once instead.
 */
const fakeCelld =
    (started: Started[], refuse: (start: number) => boolean = () => false): DevProcessSpawner =>
    (_command, args) => {
        // An unspawned ChildProcess: the real class, so `once`/`emit`/`exitCode` behave as the session expects.
        const child = new ChildProcess();
        const port = Number(args[args.indexOf("--port") + 1]);
        const exit = (code: number): void => {
            Object.defineProperty(child, "exitCode", { value: code });
            child.emit("exit", code);
        };

        started.push({ child, config: basename(String(args[1])), port });

        if (refuse(started.length)) {
            setImmediate(() => {
                exit(1);
            });

            return child;
        }

        const server: Server = createServer().listen(port, "127.0.0.1");

        child.kill = () => {
            server.close(() => {
                exit(0);
            });

            return true;
        };

        return child;
    };

describe("celld dev session", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-celld-session-"));
        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "src/server.ts" }\n`);
        writeFileSync(join(root, "lunora.config.ts"), `export default { services: { parser: { dir: "./services/parser" } } };\n`);
        mkdirSync(join(root, "services", "parser", "src"), { recursive: true });
        writeFileSync(join(root, "services", "parser", "wrangler.jsonc"), `{ "name": "parser", "main": "src/index.ts" }\n`);
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("registers each service on a port of its own before the app, and again before restarting the app on a service edit", async () => {
        expect.assertions(3);

        const started: Started[] = [];
        const port = await freePort();
        const session = await startCelldDevSession({ log: () => {}, port, projectRoot: root, spawn: fakeCelld(started) });

        expect(started.map(({ config }) => config)).toStrictEqual([".celld.service.parser.wrangler.json", ".celld.wrangler.json"]);
        // Never on the app's port, which would answer the app's traffic while it is down.
        expect(started[0]?.port).not.toBe(port);

        writeFileSync(join(root, "services", "parser", "src", "index.ts"), "export default {};\n");

        await vi.waitFor(
            () => {
                if (started.length < 4) {
                    throw new Error("not restarted yet");
                }
            },
            { timeout: 5000 },
        );

        expect(started.slice(2).map(({ config }) => config)).toStrictEqual([".celld.service.parser.wrangler.json", ".celld.wrangler.json"]);

        await session.stop();
    });

    it("reports an app that exits on its own, but not one it stops", async () => {
        expect.assertions(1);

        const started: Started[] = [];
        const session = await startCelldDevSession({ log: () => {}, port: await freePort(), projectRoot: root, spawn: fakeCelld(started) });

        // started[0] registered the service and was stopped; started[1] is the app.
        started[1]?.child.emit("exit", 3);

        await expect(session.exited).resolves.toBe(3);

        started[1]?.child.kill();
    });

    it("ends the session when the app does not come back after a restart", async () => {
        expect.assertions(1);

        const session = await startCelldDevSession({
            log: () => {},
            port: await freePort(),
            projectRoot: root,
            // Start 4 is the app coming back after the re-registration.
            spawn: fakeCelld([], (start) => start === 4),
        });

        writeFileSync(join(root, "services", "parser", "src", "index.ts"), "export default {};\n");

        await expect(session.exited).resolves.toBe(1);

        await session.stop();
    });

    it("refuses a port something else already holds", async () => {
        expect.assertions(1);

        const port = await freePort();
        const holder = createServer().listen(port, "127.0.0.1");

        await expect(startCelldDevSession({ log: () => {}, port, projectRoot: root, spawn: fakeCelld([]) })).rejects.toThrow(/already in use/u);

        holder.close();
    });

    it("refuses to start without the services lunora.config declares", async () => {
        expect.assertions(1);

        writeFileSync(join(root, "lunora.config.ts"), `export default { services: { parser: { dir: "./services/missing" } } };\n`);

        await expect(startCelldDevSession({ log: () => {}, port: await freePort(), projectRoot: root, spawn: fakeCelld([]) })).rejects.toThrow(
            /could not read the lunora\.config services/u,
        );
    });
});
