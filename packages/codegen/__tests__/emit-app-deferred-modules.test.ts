import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin } from "esbuild";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";
import baseOptions from "./emit-app-options";

/**
 * `@lunora/auth` and the spec documents load on the first event, not when the
 * isolate evaluates the script (Cloudflare's 1 s startup CPU limit). Bundled the
 * way wrangler bundles a Worker (one esbuild file, `import()` kept in-bundle), with
 * the generated app's imports replaced by recording stubs, so the assertions cover
 * evaluation order rather than text.
 */

interface Trace {
    authEvaluated: boolean;
    openApiEvaluated: boolean;
    wiring: unknown[];
    workerOptions: Record<string, unknown>[];
}

const scratch = mkdtempSync(join(tmpdir(), "lunora-emit-app-deferred-"));

/* eslint-disable no-secrets/no-secrets -- stub module sources below (export names, a global path), not credentials */
const STUBS: Record<string, string> = {
    "./crons.js": "export const LUNORA_CRONS = [];",
    "./functions.js": "export const LUNORA_FUNCTIONS = {};",
    "./openapi.js": `globalThis.lunoraDeferredTrace.openApiEvaluated = true; export const openApiSpec = { openapi: "3.1.0" };`,
    "./shard.js": "export const createShardDO = () => class ShardDO {};",
    "./authModule.js": `
        globalThis.lunoraDeferredTrace.authEvaluated = true;
        export const authDiscoveryPathsFor = () => [];
        export const createDoAuthWiring = (options) => {
            globalThis.lunoraDeferredTrace.wiring.push(options);
            return { auditReader: "audit", authHandler: "handler", discoveryHandler: "discovery", jurisdictionMove: undefined, resolveIdentity: async () => null };
        };
        export const createAuth = () => ({});
        export const createAuthAdmin = () => ({});
        export const createAuthAuditReader = () => ({});
        export const d1Executor = () => ({});
        export const handleAuthDiscoveryRequest = async () => undefined;
        export const handleAuthRequest = async () => undefined;
        export const lunoraD1Adapter = () => ({});
    `,
    "@lunora/auth/migrate": "export const createMigrationAuth = () => ({}); export const ensureMigrated = async () => {};",
    "@lunora/runtime": `
        export const createWorker = (options) => {
            globalThis.lunoraDeferredTrace.workerOptions.push(options);
            return { fetch: async () => new Response("ok"), scheduled: async () => {}, serverQuery: async () => new Response("ok") };
        };
        export const memoizeIdentity = (resolve) => resolve;
        export const resolveLogArchiveFromEnv = () => undefined;
    `,
};
/* eslint-enable no-secrets/no-secrets */

const stubs: Plugin = {
    name: "generated-app-stubs",
    setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /.*/ }, (arguments_) => (arguments_.path in STUBS ? { namespace: "stub", path: arguments_.path } : undefined));
        pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (arguments_) => {
            return { contents: STUBS[arguments_.path], loader: "js" };
        });
    },
};

/** Bundle the emitted `app.ts` into one file and import it with a fresh trace. */
const load = async (source: string): Promise<{ defineApp: () => any; trace: Trace }> => {
    const trace: Trace = { authEvaluated: false, openApiEvaluated: false, wiring: [], workerOptions: [] };
    const outfile = join(scratch, `app-${randomUUID()}.mjs`);

    (globalThis as { lunoraDeferredTrace?: Trace }).lunoraDeferredTrace = trace;

    await build({
        bundle: true,
        format: "esm",
        logLevel: "silent",
        outfile,
        platform: "neutral",
        plugins: [stubs],
        stdin: { contents: source, loader: "ts", resolveDir: scratch },
    });

    const module = (await import(pathToFileURL(outfile).href)) as { defineApp: () => any };

    return { defineApp: module.defineApp, trace };
};

const namespace = {
    get: () => {
        return {};
    },
    idFromName: () => {
        return {};
    },
};

describe("emitApp — modules deferred past isolate startup", () => {
    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
        delete (globalThis as { lunoraDeferredTrace?: Trace }).lunoraDeferredTrace;
    });

    it("has no value import of @lunora/auth or the spec modules at module scope", () => {
        expect.assertions(3);

        const source = emitApp({ ...baseOptions, hasAuth: true, wantsArchitecture: true, wantsOpenApi: true, wantsOpenRpc: true });
        const staticImports = source.split("\n").filter((line) => line.startsWith("import ") && !line.startsWith("import type "));

        expect(staticImports.filter((line) => line.includes('"@lunora/auth"') || line.includes("authModule"))).toStrictEqual([]);
        expect(staticImports.filter((line) => /openapi|openrpc|architecture/u.test(line))).toStrictEqual([]);
        expect(source).toContain('auth: await import("./authModule.js"),');
    });

    it("emits no deferred loader when there is nothing to defer", () => {
        expect.assertions(2);

        const source = emitApp({ ...baseOptions });

        expect(source).not.toContain("loadDeferredModules");
        expect(source).toContain("const buildWorker = (env: Env): LunoraWorker => createWorker(this.buildWorkerOptions(env, () => null));");
    });

    it("evaluates neither module at startup, and wires DO-backed auth when `scheduled` is the first event", async () => {
        expect.assertions(6);

        const { defineApp, trace } = await load(emitApp({ ...baseOptions, hasAuth: true, wantsOpenApi: true }));
        const app = defineApp()
            .shard(() => namespace)
            .auth({
                internalSecret: () => "secret",
                namespace: () => namespace,
                options: () => {
                    return {};
                },
            })
            .build();

        expect(trace.authEvaluated).toBe(false);
        expect(trace.openApiEvaluated).toBe(false);

        // DO-backed mode never runs `initAuth`, so the scheduled entry must load the module itself.
        await app.scheduled({ cron: "* * * * *", scheduledTime: 0 }, {}, { waitUntil: () => {} });

        expect(trace.authEvaluated).toBe(true);
        expect(trace.wiring).toHaveLength(1);
        expect(trace.workerOptions[0]).toMatchObject({ authHandler: "handler", openApiSpec: { openapi: "3.1.0" } });

        await app.fetch(new Request("https://app.example/_lunora/rpc"), {}, { waitUntil: () => {} });

        expect(trace.workerOptions).toHaveLength(1);
    });

    it("builds the worker once when cold requests arrive together", async () => {
        expect.assertions(2);

        const { defineApp, trace } = await load(emitApp({ ...baseOptions, wantsOpenApi: true }));
        const app = defineApp()
            .shard(() => namespace)
            .build();

        await Promise.all([
            app.fetch(new Request("https://app.example/a"), {}, { waitUntil: () => {} }),
            app.serverQuery(new Request("https://app.example/b"), {}, {}, {}),
            app.fetch(new Request("https://app.example/c"), {}, { waitUntil: () => {} }),
        ]);

        expect(trace.workerOptions).toHaveLength(1);
        expect(trace.workerOptions[0]?.openApiSpec).toStrictEqual({ openapi: "3.1.0" });
    });
});
