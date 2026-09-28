import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RsbuildApiLike, RsbuildConfigLike, RspackConfigLike } from "../src/rsbuild";
import { lunoraRsbuild, withLunoraProxy } from "../src/rsbuild";
import { startWorker } from "../src/worker";
import { createFixture } from "./fixture";

/** The actionable message a missing wrangler must produce. */
const WRANGLER_MISSING_RE = /wrangler` was not found on PATH/u;

/** Read the record form of `server.proxy`, failing loudly if the plugin produced an array. */
const recordProxy = (config: RsbuildConfigLike): Record<string, unknown> => {
    const proxy = config.server?.proxy;

    if (proxy === undefined || Array.isArray(proxy)) {
        throw new TypeError("expected the record form of server.proxy");
    }

    return proxy;
};

const roots: string[] = [];

const fixture = (...args: Parameters<typeof createFixture>): string => {
    const root = createFixture(...args);

    roots.push(root);

    return root;
};

/** Records what the plugin asks Rsbuild to change, without running Rsbuild. */
const captureSetup = (plugin: ReturnType<typeof lunoraRsbuild>): { rsbuild: RsbuildConfigLike; rspack: RspackConfigLike; startedDevServer: boolean } => {
    let rsbuild: RsbuildConfigLike = {};
    let rspack: RspackConfigLike = {};
    let startedDevServer = false;

    const api: RsbuildApiLike = {
        modifyRsbuildConfig: (callback) => {
            rsbuild = callback(rsbuild);
        },
        modifyRspackConfig: (callback) => {
            rspack = callback(rspack);
        },
        onBeforeStartDevServer: () => {
            startedDevServer = true;
        },
        onCloseDevServer: () => {},
    };

    plugin.setup(api);

    return { rsbuild, rspack, startedDevServer };
};

describe(lunoraRsbuild, () => {
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("injects a same-origin /_lunora proxy carrying the WebSocket", () => {
        expect.assertions(1);

        const root = fixture();
        const { rsbuild } = captureSetup(lunoraRsbuild({ projectRoot: root, validateWrangler: false }));

        // `ws: true` is the whole point: without it RPC answers and live queries
        // never connect, which fails silently — the app just never leaves its
        // loading state. `changeOrigin` keeps the worker's self-origin aligned
        // with the browser's so the CSRF guard accepts the upgrade.
        expect(recordProxy(rsbuild)["/_lunora"]).toStrictEqual({
            changeOrigin: true,
            target: "http://127.0.0.1:8787",
            ws: true,
        });
    });

    it("takes the port from the wrangler config's dev.port", () => {
        expect.assertions(1);

        const root = fixture({ wranglerDevPort: 8799 });
        const { rsbuild } = captureSetup(lunoraRsbuild({ projectRoot: root, validateWrangler: false }));

        expect(recordProxy(rsbuild)["/_lunora"]).toMatchObject({ target: "http://127.0.0.1:8799" });
    });

    it("never overrules a proxy entry the project already declares", () => {
        expect.assertions(1);

        const root = fixture();
        const plugin = lunoraRsbuild({ projectRoot: root, validateWrangler: false });
        let config: RsbuildConfigLike = { server: { proxy: { "/_lunora": { target: "http://127.0.0.1:9999" } } } };

        plugin.setup({
            modifyRsbuildConfig: (callback) => {
                config = callback(config);
            },
            modifyRspackConfig: () => {},
            onBeforeStartDevServer: () => {},
            onCloseDevServer: () => {},
        });

        // The plugin supplies a default, not a policy.
        expect(recordProxy(config)["/_lunora"]).toStrictEqual({ target: "http://127.0.0.1:9999" });
    });

    it("preserves an array-form server.proxy instead of collapsing it to an object", () => {
        expect.assertions(2);

        // Rsbuild accepts `server.proxy` as an array. Spreading one into an object
        // literal turns its entries into numeric keys, and Rsbuild then reads each
        // key as a `pathFilter` — silently unrouting every rule that relied on the
        // default match-all.
        const existing = [{ target: "http://localhost:3000" }];
        const result = withLunoraProxy(existing, 8787);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toStrictEqual([
            { target: "http://localhost:3000" },
            { changeOrigin: true, pathFilter: "/_lunora", target: "http://127.0.0.1:8787", ws: true },
        ]);
    });

    it("registers the codegen plugin itself, so one entry wires everything", () => {
        expect.assertions(1);

        const root = fixture();
        const { rspack } = captureSetup(lunoraRsbuild({ projectRoot: root, validateWrangler: false }));

        // Having to add `lunoraRspack()` to `tools.rspack` as well would be the
        // exact second setup step this plugin exists to remove.
        expect(rspack.plugins).toHaveLength(1);
    });

    it("scaffolds .dev.vars BEFORE spawning the worker", async () => {
        expect.assertions(2);

        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const root = fixture();
        let beforeStart: (() => Promise<void> | void) | undefined;

        const plugin = lunoraRsbuild({ projectRoot: root, validateWrangler: false, workerPort: 1 });

        plugin.setup({
            modifyRsbuildConfig: (callback) => callback({}),
            modifyRspackConfig: (callback) => callback({}),
            onBeforeStartDevServer: (callback) => {
                beforeStart = callback;
            },
            onCloseDevServer: () => {},
        });

        // Port 1 is privileged, so the spawn fails fast — all this asserts is the
        // ORDER of what happened before it did.
        const existsBefore = existsSync(join(root, ".dev.vars"));

        try {
            await beforeStart?.();
        } catch {
            // The spawn is expected to fail; only the ordering above is asserted.
        }

        // wrangler reads `.dev.vars` exactly once, while resolving bindings at
        // startup. Scaffolding it afterwards leaves a fresh clone's first session
        // running with every secret `undefined` — and the SECOND run works,
        // because the file is on disk by then, which is what makes it so hard to
        // diagnose.
        expect(existsBefore).toBe(false);
        expect(existsSync(join(root, ".dev.vars"))).toBe(true);
    }, 45_000);

    it("still injects the proxy under worker: false, but starts nothing", () => {
        expect.assertions(2);

        const root = fixture();
        const { rsbuild, startedDevServer } = captureSetup(lunoraRsbuild({ projectRoot: root, validateWrangler: false, worker: false }));

        // A project running the Worker itself still wants the same-origin route —
        // getting `ws` right by hand is the mistake this prevents.
        expect(recordProxy(rsbuild)["/_lunora"]).toMatchObject({ ws: true });
        expect(startedDevServer).toBe(false);
    });
});

describe(startWorker, () => {
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("explains a missing wrangler instead of crashing the dev server", async () => {
        expect.assertions(1);

        const root = fixture();
        const path = process.env.PATH;

        // A `ChildProcess` with no `error` listener THROWS the event, which took
        // the whole dev server down with a bare `spawn wrangler ENOENT` stack —
        // observed on a real `rsbuild dev` run before this was handled.
        process.env.PATH = "/nonexistent";

        try {
            await expect(startWorker({ port: 8787, projectRoot: root })).rejects.toThrow(WRANGLER_MISSING_RE);
        } finally {
            process.env.PATH = path;
        }
    }, 45_000);
});
