import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { emitFunctions, emitLazyFunctionModules, emitShard } from "../../src/emit";
import type { FunctionIR, SchemaIR } from "../../src/ir";

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let complete!: () => void;
    const promise = new Promise<void>((resolve) => {
        complete = resolve;
    });
    return { promise, resolve: complete };
};

interface GeneratedShard {
    fetch: (request: Request) => Promise<Response>;
    handleRpc: (path: string, args: Record<string, unknown>) => Promise<unknown>;
}

const makeGeneratedShard = async (
    root: string,
    lazyFunctions: boolean,
    config: Record<string, unknown> = {},
    entryKind: "action" | "mutation" = "action",
    coldKind: "action" | "mutation" | "query" = "mutation",
    schemaSource = "export default { tables: [], vectorIndexes: [] };\n",
    schema?: SchemaIR,
    capabilities: NonNullable<Parameters<typeof emitShard>[0]["capabilities"]> = new Set(),
): Promise<new (state: unknown, env: unknown) => GeneratedShard> => {
    const shardSchema = schema ?? { tables: [], vectorIndexes: [] };
    const generated = join(root, "lunora", "_generated");
    mkdirSync(join(generated, "fn"), { recursive: true });
    const functions: FunctionIR[] = [
        { args: {}, exportName: "run", filePath: "action", kind: entryKind, returnType: "unknown" },
        { args: {}, exportName: "write", filePath: "cold", kind: coldKind, returnType: "unknown" },
        { args: {}, exportName: "block", filePath: "blocker", kind: "mutation", returnType: "unknown" },
    ];
    const options = { functions, lazyFunctions };
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "lunora", "schema.ts"), schemaSource);
    writeFileSync(join(generated, "functions.ts"), emitFunctions(options));
    writeFileSync(join(generated, "shard.ts"), emitShard({ capabilities, lazyFunctions, schema: shardSchema }));
    for (const [name, source] of Object.entries(emitLazyFunctionModules(options))) {
        writeFileSync(join(generated, "fn", name), source);
    }
    const output = join(root, "shard.mjs");
    await build({
        alias: { "@lunora/do": new URL("../../../do/src/index.ts", import.meta.url).pathname },
        bundle: true,
        entryPoints: [join(generated, "shard.ts")],
        format: "esm",
        nodePaths: [
            new URL("../../../../node_modules", import.meta.url).pathname,
            new URL("../../node_modules", import.meta.url).pathname,
            new URL("../../../do/node_modules", import.meta.url).pathname,
        ],
        outdir: root,
        outExtension: { ".js": ".mjs" },
        splitting: true,
        platform: "node",
        plugins: [
            {
                name: "absolute-test-dependencies",
                setup(builder) {
                    builder.onResolve({ filter: /^[^./]/ }, async (args) => {
                        if (args.pluginData === "resolved-test-dependency") {
                            return undefined;
                        }
                        const result = await builder.resolve(args.path, {
                            kind: args.kind,
                            pluginData: "resolved-test-dependency",
                            resolveDir: args.resolveDir,
                        });
                        return { ...result, external: true };
                    });
                },
            },
        ],
        target: "node22",
    });
    const module = (await import(pathToFileURL(output).href)) as {
        createShardDO: (options: Record<string, unknown>) => new (state: unknown, env: unknown) => GeneratedShard;
    };
    return module.createShardDO(config);
};

const transactionalHost = (database: DatabaseSync, onQueued: () => void = () => undefined): { state: unknown; transactionCount: () => number } => {
    let tail: Promise<unknown> = Promise.resolve();
    let active = false;
    let transactions = 0;
    const host = {
        transactionCount: () => transactions,
        blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T> {
            if (active) {
                onQueued();
            }
            const pending = tail.then(() => {
                active = true;
                return work().finally(() => {
                    active = false;
                });
            });
            tail = pending.catch(() => undefined);
            return pending;
        },
        getWebSockets: () => [],
        id: { name: "composition" },
        storage: {
            sql: {
                exec(sql: string, ...args: unknown[]) {
                    const rows = database.prepare(sql).all(...(args as never[]));
                    return { one: () => rows[0], toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
                },
            },
            async transaction<T>(work: () => Promise<T>): Promise<T> {
                transactions += 1;
                database.exec("BEGIN");
                try {
                    const result = await work();
                    database.exec("COMMIT");
                    return result;
                } catch (error) {
                    database.exec("ROLLBACK");
                    throw error;
                }
            },
        },
    };
    return { state: host, transactionCount: host.transactionCount };
};

export { deferred, makeGeneratedShard, transactionalHost };
