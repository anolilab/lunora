import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedLunoraPluginOptions } from "../src/types";

const PROCEDURES_PER_MODULE = 5;

const here = dirname(fileURLToPath(import.meta.url));

/** This package's root. */
const packageRoot: string = resolve(here, "..");

/**
 * Scratch lives in the package's own `node_modules` (gitignored), so `vite` and
 * the plugin's dependencies resolve from a fixture exactly as from the package,
 * and a crashed run can never leak a tracked file.
 */
const cacheRoot: string = join(packageRoot, "node_modules", ".cache");

/**
 * Write a self-contained Lunora + Vite project: `tables` tables and `procedures`
 * query/mutation procedures under `lunora/`, a `wrangler.jsonc` whose `main` is a
 * dependency-free worker, and a client entry. Nothing imports a workspace
 * package at runtime, so `vite build` needs no other package built — codegen's
 * type resolution of `@lunora/server` is unavailable and it says so, the same way
 * on both sides of an A/B.
 */
const createFixture = (name: string, procedures = 40, tables = 12): string => {
    mkdirSync(cacheRoot, { recursive: true });

    const root = mkdtempSync(join(cacheRoot, `lunora-vite-bench-${name}-`));
    const lunora = join(root, "lunora");

    mkdirSync(join(lunora, "lib"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });

    const definitions = Array.from(
        { length: tables },
        (_, t) =>
            `    t${String(t)}: defineTable({ bucket: v.string(), title: v.string(), score: v.number(), createdAt: v.number() }).shardBy("bucket").index("by_bucket", ["bucket"]),`,
    );

    writeFileSync(
        join(lunora, "schema.ts"),
        `import { defineSchema, defineTable, v } from "@lunora/server";\n\nexport const schema = defineSchema({\n${definitions.join("\n")}\n});\n`,
    );
    writeFileSync(join(lunora, "lib", "shared.ts"), "export const shared = (): number => 1;\n");

    for (let made = 0; made < procedures; made += PROCEDURES_PER_MODULE) {
        const lines = ['import { shared } from "./lib/shared";', 'import { mutation, query, v } from "@lunora/server";', ""];

        for (let slot = 0; slot < PROCEDURES_PER_MODULE && made + slot < procedures; slot += 1) {
            const index = made + slot;
            const table = `t${String(index % tables)}`;

            lines.push(
                index % 2 === 0
                    ? `export const list${String(slot)} = query.input({ bucket: v.string() }).query(async ({ args, ctx }) => {\n    shared();\n\n    return ctx.db.query("${table}").withIndex("by_bucket", (q) => q.eq("bucket", args.bucket)).take(50);\n});\n`
                    : `export const create${String(slot)} = mutation.input({ bucket: v.string(), title: v.string() }).mutation(async ({ args, ctx }) => {\n    shared();\n\n    return ctx.db.insert("${table}", { bucket: args.bucket, title: args.title, score: 0, createdAt: Date.now() });\n});\n`,
            );
        }

        writeFileSync(join(lunora, `mod${String(made / PROCEDURES_PER_MODULE)}.ts`), lines.join("\n"));
    }

    writeFileSync(
        join(root, "wrangler.jsonc"),
        `{
    "name": "lunora-vite-bench",
    "main": "src/server.ts",
    "compatibility_date": "2026-10-01",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
}
`,
    );
    writeFileSync(join(root, "src", "server.ts"), `export class ShardDO {}\n\nexport default { fetch: (): Response => new Response("ok") };\n`);
    writeFileSync(join(root, "src", "main.ts"), `document.body.textContent = "bench";\n`);
    writeFileSync(join(root, "index.html"), `<!doctype html>\n<html><body><script type="module" src="/src/main.ts"></script></body></html>\n`);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "lunora-vite-bench", private: true, type: "module" }, undefined, 2)}\n`);
    writeFileSync(join(root, ".dev.vars"), "");

    return root;
};

const removeFixture = (root: string): void => {
    rmSync(root, { force: true, recursive: true });
};

/** The resolved options `lunora()` derives for a default project at `projectRoot`. */
const resolvedOptions = (projectRoot: string): ResolvedLunoraPluginOptions => {
    return {
        allowUnauthenticatedShardAccess: false,
        apiSpec: "openapi",
        cloudflare: false,
        generatedDir: "lunora/_generated",
        lazyFunctions: false,
        overlay: false,
        projectRoot,
        schemaDir: "lunora",
        shard: {},
        studio: false,
        target: "cloudflare",
        validateWrangler: false,
    };
};

export { cacheRoot, createFixture, packageRoot, removeFixture, resolvedOptions };
