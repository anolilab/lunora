import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import bindingsProvisionPlugin from "../src/bindings-provision-plugin";
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

const WRANGLER_WITHOUT_D1 = `{
    "name": "x",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }]
}
`;

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat", "web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
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
        shard: {},
        target: "cloudflare",
        validateWrangler: true,
    };
};

let workdir: string;

const writeSchema = (source: string): void => {
    mkdirSync(join(workdir, "lunora"), { recursive: true });
    writeFileSync(join(workdir, "lunora", "schema.ts"), source, "utf8");
};

/**
 * Run one plugin's `config` hook — the phase `@cloudflare/vite-plugin` parses
 * `wrangler.jsonc` in, so anything this hook writes must be on disk by the time
 * it returns.
 */
const runConfigHook = async (plugin: ReturnType<typeof wranglerValidatorPlugin>, isPreview = false): Promise<void> => {
    await (plugin.config as (this: unknown, userConfig: unknown, environment: { command: string; isPreview: boolean }) => Promise<void>).call(
        undefined,
        {},
        {
            command: "serve",
            isPreview,
        },
    );
};

/**
 * Drive the pair through Vite's hook order: both `config` hooks in registration
 * order — `bindingsProvisionPlugin` writes the inferred bindings, then the
 * validator records `isPreview` — and then `configResolved`. The same sequence
 * `resolveConfig` runs, so a test cannot accidentally validate in an order the
 * dev server never uses, nor validate against bindings the dev server would only
 * have provisioned later.
 */
const runHooks = async (plugin: ReturnType<typeof wranglerValidatorPlugin>, isPreview = false): Promise<void> => {
    await runConfigHook(bindingsProvisionPlugin(makeOptions(workdir)), isPreview);
    await runConfigHook(plugin, isPreview);

    await (plugin.configResolved as (this: unknown) => void | Promise<void>).call(undefined);
};

describe("wrangler-validator-plugin", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-wrangler-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("wranglerValidatorPlugin", () => {
        it("passes when wrangler.jsonc declares everything the schema implies", async () => {
            expect.assertions(1);

            writeSchema(SCHEMA_WITH_GLOBAL);
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const plugin = wranglerValidatorPlugin(makeOptions(workdir));

            await expect(runHooks(plugin)).resolves.toBeUndefined();
        });

        it("throws when wrangler.jsonc is missing entirely", async () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);

            const plugin = wranglerValidatorPlugin(makeOptions(workdir));

            await expect(runHooks(plugin)).rejects.toThrow(WRANGLER_NOT_FOUND);
        });

        it("throws when SHARD durable-object binding is missing", async () => {
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

            await expect(runHooks(plugin)).rejects.toThrow(SHARD_SHARDDO);
        });

        it("provisions the D1 binding a .global() schema implies instead of killing the dev server", async () => {
            expect.assertions(2);

            writeSchema(SCHEMA_WITH_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }]
}
`,
                "utf8",
            );

            const plugin = wranglerValidatorPlugin(makeOptions(workdir));

            // The binding this check requires is one Lunora writes itself, so
            // validating before provisioning killed `vite dev` the first time a
            // project added a `.global()` table.
            await expect(runHooks(plugin)).resolves.toBeUndefined();
            expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toMatch(D1_DATABASES);
        });

        it("writes the inferred binding in `config`, before the Cloudflare plugin parses wrangler.jsonc", async () => {
            expect.assertions(2);

            writeSchema(SCHEMA_WITH_GLOBAL);
            writeFileSync(join(workdir, "wrangler.jsonc"), WRANGLER_WITHOUT_D1, "utf8");

            // The write lives in its OWN plugin, registered unconditionally: it is
            // not the validator's job and must not be skippable with the checks.
            //
            // `@cloudflare/vite-plugin` reads and parses `wrangler.jsonc` inside its
            // own `config` hook and builds the miniflare worker options from that
            // parsed object; its restart watcher only exists from `configureServer`.
            // So a binding written any later than `config` never reaches the worker
            // that boots — `env.DB` is missing while the file on disk looks right.
            // `enforce: "pre"` is what puts this hook ahead of the Cloudflare one.
            const plugin = bindingsProvisionPlugin(makeOptions(workdir));

            await runConfigHook(plugin);

            expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toMatch(D1_DATABASES);
            expect(plugin.enforce).toBe("pre");
        });

        it("does not require D1 when no table is global", async () => {
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
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }]
}
`,
                "utf8",
            );

            const plugin = wranglerValidatorPlugin(makeOptions(workdir));

            await expect(runHooks(plugin)).resolves.toBeUndefined();
        });

        it("throws when compatibility_date is too old", async () => {
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

            await expect(runHooks(plugin)).rejects.toThrow(COMPATIBILITY_DATE);
        });

        it("does not require web_socket_auto_reply_to_close when compatibility_date is recent enough", async () => {
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
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }]
}
`,
                "utf8",
            );

            const plugin = wranglerValidatorPlugin(makeOptions(workdir));

            await expect(runHooks(plugin)).resolves.toBeUndefined();
        });

        it("supports jsonc comments and trailing commas", async () => {
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
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
}
`,
                "utf8",
            );

            const plugin = wranglerValidatorPlugin(makeOptions(workdir));

            await expect(runHooks(plugin)).resolves.toBeUndefined();
        });
    });

    describe("vite preview", () => {
        it("validates nothing under preview, which resolves as a `serve` command", async () => {
            expect.assertions(1);

            // `vite preview` resolves with `command: "serve"`, so `apply: "serve"`
            // plugins run there too. Previewing a built app must not fail on the
            // project's wrangler config — or shell out to `docker info`.
            writeSchema(SCHEMA_NO_GLOBAL);

            const plugin = wranglerValidatorPlugin(makeOptions(workdir));

            await expect(runHooks(plugin, true)).resolves.toBeUndefined();
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
