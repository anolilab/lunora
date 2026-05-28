import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ResolvedCirrusPluginOptions } from "../src/types.js";
import { wranglerValidatorPlugin } from "../src/wrangler-validator-plugin.js";

const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),

    users: defineTable({
        email: v.string(),
        name: v.string(),
    }).global(),
});
`;

const SCHEMA_NO_GLOBAL = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

const VALID_WRANGLER = `{
    "name": "cirrus-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat", "web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "cirrus-global", "database_id": "x" }]
}
`;

const makeOptions = (projectRoot: string): ResolvedCirrusPluginOptions => ({
    cloudflare: false,
    generatedDir: "cirrus/_generated",
    overlay: false,
    projectRoot,
    schemaDir: "cirrus",
    validateWrangler: true,
});

let workdir: string;

const writeSchema = (source: string): void => {
    mkdirSync(join(workdir, "cirrus"), { recursive: true });
    writeFileSync(join(workdir, "cirrus", "schema.ts"), source, "utf8");
};

const callConfigResolved = (plugin: ReturnType<typeof wranglerValidatorPlugin>): void => {
    (plugin.configResolved as (this: unknown) => void).call(undefined);
};

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-vite-wrangler-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("wranglerValidatorPlugin", () => {
    test("passes when wrangler.jsonc declares everything the schema implies", () => {
        writeSchema(SCHEMA_WITH_GLOBAL);
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

        const plugin = wranglerValidatorPlugin(makeOptions(workdir));

        expect(() => {
            callConfigResolved(plugin);
        }).not.toThrow();
    });

    test("throws when wrangler.jsonc is missing entirely", () => {
        writeSchema(SCHEMA_NO_GLOBAL);

        const plugin = wranglerValidatorPlugin(makeOptions(workdir));

        expect(() => {
            callConfigResolved(plugin);
        }).toThrow(/wrangler\.jsonc not found/u);
    });

    test("throws when SHARD durable-object binding is missing", () => {
        writeSchema(SCHEMA_NO_GLOBAL);
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
    "name": "x",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"]
}
`,
            "utf8",
        );

        const plugin = wranglerValidatorPlugin(makeOptions(workdir));

        expect(() => {
            callConfigResolved(plugin);
        }).toThrow(/SHARD.+ShardDO/u);
    });

    test("throws when schema has .global() tables but D1 binding is missing", () => {
        writeSchema(SCHEMA_WITH_GLOBAL);
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
    "name": "x",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
            "utf8",
        );

        const plugin = wranglerValidatorPlugin(makeOptions(workdir));

        expect(() => {
            callConfigResolved(plugin);
        }).toThrow(/d1_databases/u);
    });

    test("does not require D1 when no table is global", () => {
        writeSchema(SCHEMA_NO_GLOBAL);
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
    "name": "x",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
            "utf8",
        );

        const plugin = wranglerValidatorPlugin(makeOptions(workdir));

        expect(() => {
            callConfigResolved(plugin);
        }).not.toThrow();
    });

    test("throws when compatibility_date is too old", () => {
        writeSchema(SCHEMA_NO_GLOBAL);
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
    "name": "x",
    "compatibility_date": "2024-01-01",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
            "utf8",
        );

        const plugin = wranglerValidatorPlugin(makeOptions(workdir));

        expect(() => {
            callConfigResolved(plugin);
        }).toThrow(/compatibility_date/u);
    });

    test("does not require web_socket_auto_reply_to_close when compatibility_date is recent enough", () => {
        // The flag became the default on 2026-04-07; workerd warns when it's set redundantly.
        writeSchema(SCHEMA_NO_GLOBAL);
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
    "name": "x",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
            "utf8",
        );

        const plugin = wranglerValidatorPlugin(makeOptions(workdir));

        expect(() => {
            callConfigResolved(plugin);
        }).not.toThrow();
    });

    test("supports jsonc comments and trailing commas", () => {
        writeSchema(SCHEMA_NO_GLOBAL);
        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `// my wrangler config
{
    "name": "x",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }],
    },
}
`,
            "utf8",
        );

        const plugin = wranglerValidatorPlugin(makeOptions(workdir));

        expect(() => {
            callConfigResolved(plugin);
        }).not.toThrow();
    });
});
