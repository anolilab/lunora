import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfigEnv, Plugin, UserConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { celldDevPlugin, celldDevSupport, withoutDevWhen } from "../src/celld-dev-plugin";

const SERVE: ConfigEnv = { command: "serve", mode: "development" };
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

    it("proxies /_lunora with the WebSocket to the wrangler dev.port, and keeps a route the project declares", () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "src/server.ts", "dev": { "port": 8799 } }\n`);

        const plugin = celldDevPlugin(root, () => true);
        const config = plugin.config as (config: UserConfig) => UserConfig | undefined;

        expect(config({})?.server?.proxy).toStrictEqual({ "/_lunora": { changeOrigin: true, target: "http://127.0.0.1:8799", ws: true } });
        expect(config({ server: { proxy: { "/_lunora": "http://127.0.0.1:1" } } })).toBeUndefined();
    });
});
