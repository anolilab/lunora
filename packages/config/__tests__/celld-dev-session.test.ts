import { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CelldSpawner } from "../src/celld/dev-session";
import { startCelldDevSession } from "../src/celld/dev-session";

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

/**
 * A stand-in for `celld dev`: it listens on the `--port` it is given until it
 * is killed, recording the config it was started with.
 */
const fakeCelld =
    (started: string[]): CelldSpawner =>
    (args) => {
        // An unspawned ChildProcess: the real class, so `once`/`emit`/`exitCode` behave as the session expects.
        const child = new ChildProcess();
        const port = Number(args[args.indexOf("--port") + 1]);
        const server: Server = createServer().listen(port, "127.0.0.1");

        started.push(basename(String(args[1])));
        child.kill = () => {
            server.close(() => {
                Object.defineProperty(child, "exitCode", { value: 0 });
                child.emit("exit", 0);
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
        mkdirSync(join(root, "services", "parser"), { recursive: true });
        writeFileSync(join(root, "services", "parser", "wrangler.jsonc"), `{ "name": "parser", "main": "src/index.ts" }\n`);
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("registers each service before the app, and re-registers it before restarting the app", async () => {
        expect.assertions(2);

        const started: string[] = [];
        const session = await startCelldDevSession({ log: () => {}, port: await freePort(), projectRoot: root, spawn: fakeCelld(started) });

        expect(started).toStrictEqual([".celld.service.parser.wrangler.json", ".celld.wrangler.json"]);

        await session.restartService("parser");
        await session.stop();

        expect(started.slice(2)).toStrictEqual([".celld.service.parser.wrangler.json", ".celld.wrangler.json"]);
    });

    it("refuses a port something else already holds", async () => {
        expect.assertions(1);

        const port = await freePort();
        const holder = createServer().listen(port, "127.0.0.1");

        await expect(startCelldDevSession({ log: () => {}, port, projectRoot: root, spawn: fakeCelld([]) })).rejects.toThrow(/already in use/u);

        holder.close();
    });
});
