import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cirrus } from "../src/index.js";

let workdir: string;

const SCHEMA = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

const VALID_WRANGLER = `{
    "name": "cirrus-app",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-vite-index-"));
    mkdirSync(join(workdir, "cirrus"), { recursive: true });
    writeFileSync(join(workdir, "cirrus", "schema.ts"), SCHEMA, "utf8");
    writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("cirrus()", () => {
    test("returns an array of plugins including the cirrus internals and cloudflare", async () => {
        const plugins = await cirrus({ overlay: false, projectRoot: workdir, validateWrangler: true });

        expect(Array.isArray(plugins)).toBe(true);

        const names = plugins.map((plugin) => plugin.name);

        expect(names).toContain("cirrus:codegen");
        expect(names).toContain("cirrus:wrangler-validator");
        // The cloudflare plugin contributes at least one plugin to the array.
        expect(names.some((name) => name.includes("cloudflare"))).toBe(true);
    });

    test("excludes the cloudflare plugin when cloudflare is false", async () => {
        const plugins = await cirrus({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false });

        const names = plugins.map((plugin) => plugin.name);

        expect(names).toContain("cirrus:codegen");
        expect(names.some((name) => name.includes("cloudflare"))).toBe(false);
    });

    test("excludes the wrangler validator when validateWrangler is false", async () => {
        const plugins = await cirrus({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false });

        const names = plugins.map((plugin) => plugin.name);

        expect(names).not.toContain("cirrus:wrangler-validator");
    });

    test("includes the overlay plugin when overlay is true", async () => {
        const plugins = await cirrus({ cloudflare: false, overlay: true, projectRoot: workdir, validateWrangler: false });

        // Either the real overlay (whatever name it carries) or our no-op injector
        // should be present — but the array length must be strictly greater than the
        // codegen-only case.
        const minimal = await cirrus({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false });

        expect(plugins.length).toBeGreaterThan(minimal.length);
    });
});
