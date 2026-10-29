import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";
import { ModuleKind, ModuleResolutionKind, Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contextWith, fakeCache } from "../../runtime/__tests__/helpers/edge-cache";
import type { WorkerOptions } from "../../runtime/src/create-worker";
import { createWorker } from "../../runtime/src/create-worker";
import discoverFunctions from "../src/discover/functions";
import { emitFunctions } from "../src/emit";

let directory: string;

const generatedRegistry = async (modifier: string): Promise<WorkerOptions["functions"]> => {
    const sources = join(directory, "lunora");
    mkdirSync(sources);
    writeFileSync(join(sources, "base.ts"), `import { query } from "@lunora/server"; export const base = query.${modifier};`);
    writeFileSync(join(sources, "posts.ts"), 'import { base } from "./base"; export const list = base.query(() => "unused");');
    const project = new Project({
        compilerOptions: { module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler },
        skipAddingFilesFromTsConfig: true,
    });
    const functions = discoverFunctions(project, sources, { lazyFunctions: true });
    const outfile = join(directory, "functions.mjs");
    await build({
        alias: { "@lunora/server": new URL("../../errors/src/index.ts", import.meta.url).pathname },
        bundle: true,
        external: ["./fn/*"],
        format: "esm",
        outfile,
        platform: "node",
        stdin: { contents: emitFunctions({ functions, lazyFunctions: true }), loader: "ts", resolveDir: directory },
    });
    const module = await import(pathToFileURL(outfile).href);

    return module.LUNORA_FUNCTIONS;
};

const shardSpy = () => {
    const calls: Request[] = [];

    return {
        calls,
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        calls.push(request);
                        return Response.json({ call: calls.length });
                    },
                };
            },
            idFromName: (name: string) => {
                return { name };
            },
        },
    };
};

describe("lazy metadata at the origin worker", () => {
    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-lazy-runtime-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("never puts responses carrying a declared API-key credential in the public cache", async () => {
        expect.assertions(5);

        const functions = await generatedRegistry('expose({ rest: true, cache: { maxAge: 60, scope: "public", credentialHeaders: ["x-api-key"] } })');
        const shard = shardSpy();
        const { cache, entries } = fakeCache();
        const { context, settled } = contextWith();
        const worker = createWorker({ functions, restEdgeCache: cache, shardDO: shard.namespace });
        const endpoint = "https://app.example/_lunora/rest/posts/list";
        const first = await worker.fetch(new Request(endpoint, { headers: { "x-api-key": "alice" } }), {}, context);
        await settled();

        expect(first.headers.get("cache-control")).toBe("private, max-age=60");
        expect(first.headers.get("vary")).toContain("x-api-key");
        expect(entries.size).toBe(0);

        const second = await worker.fetch(new Request(endpoint, { headers: { "x-api-key": "bob" } }), {}, context);
        await settled();

        await expect(second.json()).resolves.toEqual({ call: 2 });
        expect(shard.calls).toHaveLength(2);
    });

    it("refuses inherited paid RPC and REST procedures without a payment gate before any module load", async () => {
        expect.assertions(5);

        const functions = await generatedRegistry('x402({ price: "$0.10" }).expose({ rest: true })');
        const shard = shardSpy();
        const { context } = contextWith();
        const worker = createWorker({ functions, shardDO: shard.namespace });
        const rpc = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ args: {}, functionPath: "posts:list", kind: "query" }),
            }),
            {},
            context,
        );
        const rest = await worker.fetch(new Request("https://app.example/_lunora/rest/posts/list"), {}, context);

        expect(rpc.status).toBe(500);
        expect(rest.status).toBe(500);
        await expect(rpc.json()).resolves.toMatchObject({ error: { code: "MISCONFIGURED" } });
        await expect(rest.json()).resolves.toMatchObject({ error: { code: "MISCONFIGURED" } });
        expect(shard.calls).toHaveLength(0);
    });
});
