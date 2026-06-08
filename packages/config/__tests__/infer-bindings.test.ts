import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inferCirrusBindings } from "../src/infer-bindings.js";

const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
    users: defineTable({ email: v.string() }).global(),
});
`;

const SCHEMA_NO_GLOBAL = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
});
`;

const WRANGLER = `{
    "name": "app",
    "main": "src/server/index.ts",
    "compatibility_date": "2026-04-07"
}
`;

const ENTRY_SHARD_ONLY = `import { createShardDO } from "../../cirrus/_generated/shard.js";

export const ShardDO = createShardDO({});

export default { fetch() { return new Response("ok"); } };
`;

const ENTRY_SHARD_AND_SCHEDULER = `import { createShardDO } from "../../cirrus/_generated/shard.js";

export { SchedulerDO } from "./scheduler-do.js";
export const ShardDO = createShardDO({});
`;

describe("inferCirrusBindings", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "cirrus-infer-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const write = (relativePath: string, content: string): void => {
        const fullPath = join(root, relativePath);

        mkdirSync(join(fullPath, ".."), { recursive: true });
        writeFileSync(fullPath, content, "utf8");
    };

    it("provisions only the Durable Objects the worker entry exports", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_AND_SCHEDULER);

        const result = await inferCirrusBindings({ projectRoot: root });
        const bindings = result.durableObjects.map((object) => object.binding).toSorted((a, b) => a.localeCompare(b));

        expect(bindings).toEqual(["SCHEDULER", "SHARD"]);
        expect(result.durableObjects.find((object) => object.binding === "SHARD")?.className).toBe("ShardDO");
    });

    it("does NOT bind SessionDO when @cirrus/auth is used but no SessionDO is exported", async () => {
        expect.assertions(3);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", `${ENTRY_SHARD_ONLY}\nimport { createAuth } from "@cirrus/auth";\nexport const auth = createAuth();`);

        const result = await inferCirrusBindings({ projectRoot: root });

        expect(result.usesAuth).toBe(true);
        expect(result.durableObjects.some((object) => object.binding === "SESSION")).toBe(false);
        expect(result.signals.some((signal) => signal.includes("SessionDO"))).toBe(true);
    });

    it("infers D1 from a .global() table even with no env.DB access", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("cirrus/schema.ts", SCHEMA_WITH_GLOBAL);

        const result = await inferCirrusBindings({ projectRoot: root });

        expect(result.needsD1).toBe(true);
    });

    it("does not infer D1 for a shard-only schema", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("cirrus/schema.ts", SCHEMA_NO_GLOBAL);

        const result = await inferCirrusBindings({ projectRoot: root });

        expect(result.needsD1).toBe(false);
    });

    it("falls back to a known entry path when wrangler has no main", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", '{ "name": "app", "compatibility_date": "2026-04-07" }');
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferCirrusBindings({ projectRoot: root });

        expect(result.durableObjects.map((object) => object.binding)).toEqual(["SHARD"]);
    });

    it("reports no Durable Objects when the worker entry cannot be found", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", '{ "name": "app", "main": "does/not/exist.ts" }');

        const result = await inferCirrusBindings({ projectRoot: root });

        expect(result.durableObjects).toEqual([]);
    });

    it("detects an aliased re-export of a Durable Object class", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", "class AppShard {}\nexport { AppShard as ShardDO };");

        const result = await inferCirrusBindings({ projectRoot: root });

        expect(result.durableObjects.map((object) => object.binding)).toEqual(["SHARD"]);
    });

    it("does NOT bind a class that is only exported as a type (inline `type` modifier)", async () => {
        expect.assertions(1);

        // es-module-lexer lists `ShardDO` as an export here even though it
        // compiles away; binding it would break `wrangler deploy`.
        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", `${ENTRY_SHARD_ONLY}\nexport { type SchedulerDO } from "./scheduler-types.js";`);

        const result = await inferCirrusBindings({ projectRoot: root });

        expect(result.durableObjects.map((object) => object.binding)).toEqual(["SHARD"]);
    });

    it("infers D1 from an env.DB access even without a global schema", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("cirrus/schema.ts", SCHEMA_NO_GLOBAL);
        write("cirrus/admin.ts", "export const handler = (c) => c.env.DB.prepare('select 1');");

        const result = await inferCirrusBindings({ projectRoot: root });

        expect(result.needsD1).toBe(true);
    });
});
