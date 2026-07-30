import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedLunoraPluginOptions } from "../src/types";
import { warnWhenDockerMissing, wranglerValidatorPlugin } from "../src/wrangler-validator-plugin";

const WRANGLER_NOT_FOUND = /wrangler\.jsonc not found/u;
const SHARD_SHARDDO = /SHARD.+ShardDO/u;
const D1_DATABASES = /d1_databases/u;
const COMPATIBILITY_DATE = /compatibility_date/u;

const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

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

const SCHEMA_NO_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat", "web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "lunora-global", "database_id": "x" }]
}
`;

const makeOptions = (projectRoot: string): ResolvedLunoraPluginOptions => {
    return {
        allowUnauthenticatedShardAccess: false,
        apiSpec: "openapi",
        cloudflare: false,
        studio: false,
        generatedDir: "lunora/_generated",
        overlay: false,
        projectRoot,
        schemaDir: "lunora",
        target: "cloudflare",
        validateWrangler: true,
    };
};

let workdir: string;

const writeSchema = (source: string): void => {
    mkdirSync(join(workdir, "lunora"), { recursive: true });
    writeFileSync(join(workdir, "lunora", "schema.ts"), source, "utf8");
};

const callConfigResolved = (plugin: ReturnType<typeof wranglerValidatorPlugin>): void => {
    (plugin.configResolved as (this: unknown) => void).call(undefined);
};

describe("wrangler-validator-plugin", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-wrangler-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("wranglerValidatorPlugin", () => {
        it("passes when wrangler.jsonc declares everything the schema implies", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_WITH_GLOBAL);
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const plugin = wranglerValidatorPlugin(makeOptions(workdir));

            expect(() => {
                callConfigResolved(plugin);
            }).not.toThrow();
        });

        it("throws when wrangler.jsonc is missing entirely", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);

            const plugin = wranglerValidatorPlugin(makeOptions(workdir));

            expect(() => {
                callConfigResolved(plugin);
            }).toThrow(WRANGLER_NOT_FOUND);
        });

        it("throws when SHARD durable-object binding is missing", () => {
            expect.assertions(1);

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
            }).toThrow(SHARD_SHARDDO);
        });

        it("throws when schema has .global() tables but D1 binding is missing", () => {
            expect.assertions(1);

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
            }).toThrow(D1_DATABASES);
        });

        it("does not require D1 when no table is global", () => {
            expect.assertions(1);

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

        it("throws when compatibility_date is too old", () => {
            expect.assertions(1);

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
            }).toThrow(COMPATIBILITY_DATE);
        });

        it("does not require web_socket_auto_reply_to_close when compatibility_date is recent enough", () => {
            expect.assertions(1);

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

        it("supports jsonc comments and trailing commas", () => {
            expect.assertions(1);

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

    describe("warnWhenDockerMissing", () => {
        it("warns when a Dockerfile-built container is declared and docker is unavailable", () => {
            expect.assertions(1);

            const wranglerPath = join(workdir, "wrangler.jsonc");

            writeFileSync(
                wranglerPath,
                `{
    "name": "x",
    "containers": [{ "class_name": "TranscoderContainer", "image": "./containers/transcoder/Dockerfile" }],
}
`,
                "utf8",
            );

            const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

            warnWhenDockerMissing(wranglerPath, () => false);

            expect(spy.mock.calls.join(" ")).toContain("no Docker-compatible engine is running");

            spy.mockRestore();
        });

        it("stays silent for registry-image containers and when docker is available", () => {
            expect.assertions(1);

            const wranglerPath = join(workdir, "wrangler.jsonc");

            writeFileSync(
                wranglerPath,
                `{
    "name": "x",
    "containers": [{ "class_name": "TranscoderContainer", "image": "docker.io/acme/transcoder:1.4" }],
}
`,
                "utf8",
            );

            const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

            warnWhenDockerMissing(wranglerPath, () => false);
            writeFileSync(
                wranglerPath,
                `{
    "name": "x",
    "containers": [{ "class_name": "TranscoderContainer", "image": "./containers/transcoder/Dockerfile" }],
}
`,
                "utf8",
            );
            warnWhenDockerMissing(wranglerPath, () => true);

            expect(spy).not.toHaveBeenCalled();

            spy.mockRestore();
        });
    });
});
