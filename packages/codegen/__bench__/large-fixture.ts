import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROCEDURES_PER_MODULE = 5;

/**
 * Writes a synthetic `lunora/` directory (`tables` tables, `procedures`
 * query/mutation procedures spread over modules that each import one shared
 * module) under `root`. Mirrors the app `scripts/check-worker-startup.js` builds.
 * @param root the project root to write `lunora/` into
 * @param procedures number of procedures to generate
 * @param tables number of tables to generate
 */
const writeLargeFixture = (root: string, procedures: number, tables: number): void => {
    const lunora = join(root, "lunora");

    mkdirSync(join(lunora, "lib"), { recursive: true });

    const definitions = Array.from(
        { length: tables },
        (_, t) =>
            `    t${String(t)}: defineTable({ ownerId: v.string(), title: v.string(), score: v.number(), createdAt: v.number() }).shardBy("ownerId").index("by_owner", ["ownerId"]),`,
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
                    ? `export const list${String(slot)} = query.input({ ownerId: v.string() }).query(async ({ args, ctx }) => {\n    shared();\n\n    return ctx.db.query("${table}").withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId)).take(50);\n});\n`
                    : `export const create${String(slot)} = mutation.input({ ownerId: v.string(), title: v.string() }).mutation(async ({ args, ctx }) => {\n    shared();\n\n    return ctx.db.insert("${table}", { ownerId: args.ownerId, title: args.title, score: 0, createdAt: Date.now() });\n});\n`,
            );
        }

        writeFileSync(join(lunora, `mod${String(made / PROCEDURES_PER_MODULE)}.ts`), lines.join("\n"));
    }
};

export default writeLargeFixture;
