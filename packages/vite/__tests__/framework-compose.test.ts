/**
 * Phase 4 verification gate: `cirrus()` composes cleanly with the framework
 * plugins Cloudflare's vite plugin officially advertises — TanStack Start and
 * React Router v7.
 *
 * Booting `createServer` for each framework would force us to depend on the
 * real packages (and their transitive trees). Instead we run Vite's
 * `resolveConfig`, which drives the full plugin pipeline (`configResolved`,
 * plugin ordering, name collision detection) against shape-faithful stand-ins
 * for each framework's plugin export. If our hooks would clash with theirs,
 * `resolveConfig` is where it surfaces.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "vite";
import { resolveConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cirrus } from "../src/index.js";

const CIRRUS_WRANGLER_ERROR = /\[cirrus\] wrangler/;

const SCHEMA = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

const VALID_WRANGLER = `{
    "name": "cirrus-framework-app",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`;

/**
 * Shape-faithful stand-in for `@tanstack/start`'s vite plugin. The real
 * plugin contributes multiple sub-plugins; we model the entrypoint plus one
 * sub-plugin so name-uniqueness assertions are meaningful.
 */
const tanstackStartLike = (): ReadonlyArray<Plugin> => [
        {
            name: "tanstack-start",
            enforce: "pre",
            configResolved() {},
        },
        {
            name: "tanstack-start:router",
            configureServer() {},
        },
    ];

/**
 * Shape-faithful stand-in for `@react-router/dev/vite`'s plugin. RR7 ships a
 * single named plugin; we model that.
 */
const reactRouterLike = (): Plugin => {
    return {
        name: "react-router",
        enforce: "pre",
        configResolved() {},
        configureServer() {},
    };
};

let workdir: string;

describe("framework-compose", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-vite-framework-"));
        mkdirSync(join(workdir, "cirrus"), { recursive: true });
        writeFileSync(join(workdir, "cirrus", "schema.ts"), SCHEMA, "utf8");
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("cirrus() framework composition", () => {
        it("composes with a TanStack-Start-shaped plugin and resolveConfig succeeds", async () => {
            expect.hasAssertions();

            const cirrusPlugins = await cirrus({
                cloudflare: false,
                overlay: false,
                projectRoot: workdir,
                validateWrangler: true,
            });

            const resolved = await resolveConfig(
                {
                    configFile: false,
                    root: workdir,
                    plugins: [...tanstackStartLike(), ...cirrusPlugins],
                },
                "serve",
            );

            const names = resolved.plugins.map((plugin) => plugin.name);

            expect(names).toContain("tanstack-start");
            expect(names).toContain("tanstack-start:router");
            expect(names).toContain("cirrus:codegen");
            expect(names).toContain("cirrus:wrangler-validator");

            // Plugin names must remain unique — Vite would otherwise warn loudly.
            expect(new Set(names).size).toBe(names.length);
        });

        it("composes with a React-Router-v7-shaped plugin and resolveConfig succeeds", async () => {
            expect.hasAssertions();

            const cirrusPlugins = await cirrus({
                cloudflare: false,
                overlay: false,
                projectRoot: workdir,
                validateWrangler: true,
            });

            const resolved = await resolveConfig(
                {
                    configFile: false,
                    root: workdir,
                    plugins: [reactRouterLike(), ...cirrusPlugins],
                },
                "serve",
            );

            const names = resolved.plugins.map((plugin) => plugin.name);

            expect(names).toContain("react-router");
            expect(names).toContain("cirrus:codegen");
            expect(names).toContain("cirrus:wrangler-validator");
            expect(new Set(names).size).toBe(names.length);
        });

        it("wranglerValidator configResolved still fires inside a framework pipeline", async () => {
            expect.assertions(1);

            // Drop a wrangler.jsonc that is *missing* the SHARD binding — the
            // validator must throw during configResolved even when wrapped by
            // framework plugins. This guards against accidental hook-order bugs
            // (e.g. a framework plugin swallowing our throw).
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
                "name": "cirrus-framework-app",
                "compatibility_date": "2026-04-07"
            }
            `,
                "utf8",
            );

            const cirrusPlugins = await cirrus({
                cloudflare: false,
                overlay: false,
                projectRoot: workdir,
                validateWrangler: true,
            });

            await expect(
                resolveConfig(
                    {
                        configFile: false,
                        root: workdir,
                        plugins: [...tanstackStartLike(), ...cirrusPlugins],
                    },
                    "serve",
                ),
            ).rejects.toThrow(CIRRUS_WRANGLER_ERROR);
        });
    });
});
