import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfigEnv, Plugin, UserConfig, ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { celldDevPlugin, celldDevSupport, withoutDevWhen } from "../src/celld-dev-plugin";

const { events, startCelldDevSession } = vi.hoisted(() => {
    const log: string[] = [];
    let started = 0;

    return {
        events: log,
        startCelldDevSession: vi.fn<() => Promise<{ exited: Promise<number>; stop: () => Promise<void> }>>(async () => {
            started += 1;

            const id = started;

            log.push(`start ${String(id)}`);

            return {
                exited: new Promise<number>(() => {}),
                stop: async () => {
                    log.push(`stop ${String(id)}`);
                },
            };
        }),
    };
});

vi.mock(import("@lunora/config"), async (importOriginal) => {
    const original = await importOriginal();

    return { ...original, startCelldDevSession: startCelldDevSession as unknown as typeof original.startCelldDevSession };
});

const SERVE: ConfigEnv = { command: "serve", mode: "development" };
const PREVIEW: ConfigEnv = { command: "serve", isPreview: true, mode: "production" };
const BUILD: ConfigEnv = { command: "build", mode: "production" };

const applies = (plugin: Plugin, env: ConfigEnv): boolean => (plugin.apply as (config: UserConfig, env: ConfigEnv) => boolean)({}, env);

describe("celld dev plugin", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-vite-celld-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("runs on celld for a worker file, and says why not for a Vite virtual main", () => {
        expect.assertions(3);

        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "src/server.ts" }\n`);

        expect(celldDevSupport(root, "celld")()).toStrictEqual({ runs: true });

        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "virtual:lunora/worker" }\n`);

        const virtual = celldDevSupport(root, "celld")();

        expect(virtual.runs).toBe(false);
        expect(virtual.reason).toMatch(/Vite virtual module/u);
    });

    it("keeps the Cloudflare plugins for vite build but out of vite dev while celld serves", () => {
        expect.assertions(4);

        const [always, devOnly] = withoutDevWhen([{ name: "cf" }, { apply: "serve", name: "cf:dev" }], () => true);

        expect(applies(always!, BUILD)).toBe(true);
        expect(applies(always!, SERVE)).toBe(false);
        expect(applies(devOnly!, BUILD)).toBe(false);
        expect(applies(withoutDevWhen([{ name: "cf" }], () => false)[0]!, SERVE)).toBe(true);
    });

    it("leaves vite preview to the Cloudflare plugin", () => {
        expect.assertions(2);

        expect(applies(withoutDevWhen([{ name: "cf" }], () => true)[0]!, PREVIEW)).toBe(true);
        expect(
            applies(
                celldDevPlugin(root, () => true),
                PREVIEW,
            ),
        ).toBe(false);
    });

    it("stops the previous session before a restarted server starts its own, which needs the same port", async () => {
        expect.assertions(1);

        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "src/server.ts" }\n`);

        const server = (): ViteDevServer =>
            ({ config: { logger: { error: () => {}, info: () => {}, warn: () => {} } }, httpServer: { once: () => {} } }) as unknown as ViteDevServer;
        const configure = celldDevPlugin(root, () => true).configureServer as (server: ViteDevServer) => Promise<void>;

        await configure(server());
        await configure(server());

        expect(events).toStrictEqual(["start 1", "stop 1", "start 2"]);
    });

    it("proxies /_lunora with the WebSocket to the wrangler dev.port, and keeps a route the project declares", () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "src/server.ts", "dev": { "port": 8799 } }\n`);

        const plugin = celldDevPlugin(root, () => true);
        const config = plugin.config as (config: UserConfig) => UserConfig | undefined;

        expect(config({})?.server?.proxy).toStrictEqual({ "/_lunora": { changeOrigin: true, target: "http://127.0.0.1:8799", ws: true } });
        expect(config({ server: { proxy: { "/_lunora": "http://127.0.0.1:1" } } })).toBeUndefined();
    });
});
