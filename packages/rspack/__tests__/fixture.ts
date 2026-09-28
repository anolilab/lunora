import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A minimal shard-only schema: one table, one index, no extra packages implied. */
const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    })
        .index("by_channel", ["channelId"])
        .shardBy("channelId"),
});
`;

/**
 * {@link SCHEMA} with an index over a column the table does not declare — the
 * `index_references_unknown_field` ERROR advisory, which is what a production
 * build must refuse and a watch rebuild must merely log.
 */
const SCHEMA_WITH_ERROR_ADVISORY = SCHEMA.replace(
    `.index("by_channel", ["channelId"])`,
    `.index("by_channel", ["channelId"])\n        .index("by_bogus", ["doesNotExist"])`,
);

/** {@link SCHEMA} plus a `.global()` table, which implies the `DB` D1 binding Lunora provisions itself. */
const SCHEMA_WITH_GLOBAL = SCHEMA.replace(
    "});\n",
    `
    users: defineTable({
        email: v.string(),
    }).global(),
});
`,
);

/** A wrangler config declaring only what a plain shard app needs. */
const WRANGLER = `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }]
}
`;

interface FixtureOptions {
    /** Extra `package.json` dependencies codegen must see declared (e.g. `@lunora/d1`). */
    dependencies?: Record<string, string>;

    /** Schema source; defaults to {@link SCHEMA}. */
    schema?: string;

    /** `package.json` scripts, for exercising the `postcodegen` hook. */
    scripts?: Record<string, string>;

    /** Write a `wrangler.jsonc`; defaults to `true`. */
    wrangler?: boolean;
}

/**
 * Write a throwaway Lunora project and return its root.
 *
 * Deliberately a real directory rather than a mocked filesystem: every assertion
 * in this package's suites is about what codegen and the reconcilers actually
 * wrote, and the whole point of the integration suite is that nothing between the
 * compiler and the disk is a double.
 */
const createFixture = (options: FixtureOptions = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "lunora-rspack-"));

    mkdirSync(join(root, "lunora"), { recursive: true });
    writeFileSync(join(root, "lunora", "schema.ts"), options.schema ?? SCHEMA, "utf8");
    // One real function, so the generated `api.ts` carries an actual surface —
    // an empty `ApiTypes` would let an assertion about generated output pass
    // against codegen that discovered nothing.
    writeFileSync(
        join(root, "lunora", "messages.ts"),
        'import { query } from "./_generated/server";\n\nexport const list = query({ args: {}, handler: async () => [] });\n',
        "utf8",
    );

    if (options.wrangler !== false) {
        writeFileSync(join(root, "wrangler.jsonc"), WRANGLER, "utf8");
    }

    writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify({ dependencies: options.dependencies ?? {}, name: "app", scripts: options.scripts ?? {}, type: "module" }, undefined, 4)}\n`,
        "utf8",
    );

    // Rspack needs something to bundle; nothing in these suites asserts on it.
    writeFileSync(join(root, "index.js"), 'console.log("app");\n', "utf8");

    return root;
};

export type { FixtureOptions };
export { createFixture, SCHEMA, SCHEMA_WITH_ERROR_ADVISORY, SCHEMA_WITH_GLOBAL, WRANGLER };
