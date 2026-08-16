/**
 * Compose smoke + storage-tier guard for the builder app.
 *
 * Two jobs, and the second is the interesting one.
 *
 * `runCodegen` + `validateWranglerProject` mirror what a real `lunora dev`
 * would run, so a refactor in codegen or the config layer breaks here rather
 * than on a deploy — the same gate `apps/playground` carries.
 *
 * The tier assertions pin the decisions in `lunora/schema.ts` that are cheap to
 * get wrong and expensive to discover: moving `projects` into a shard turns the
 * dashboard into a cross-shard fan-out, and moving `messages` out of one puts
 * every project's build traffic on the root DO. Neither failure is visible in a
 * typecheck, and both are a schema migration to undo once there is data.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "@lunora/codegen";
import { validateWranglerProject } from "@lunora/config/cloudflare";
import { describe, expect, it } from "vitest";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(testDirectory, "..");

/** Tables that must stay sharded by project, with the reason each one is. */
const SHARDED_BY_PROJECT = ["chats", "messages", "snapshots", "usage"];

/** Tables that must stay `.global()` because they are read without a project in hand. */
const GLOBAL_TABLES = ["projects", "shares", "users"];

describe("builder compose smoke", () => {
    it("runCodegen parses the schema and functions and emits the _generated triad", () => {
        expect.assertions(4);

        const result = runCodegen({ projectRoot });

        expect(existsSync(join(result.outputDirectory, "dataModel.ts"))).toBe(true);
        expect(existsSync(join(result.outputDirectory, "api.ts"))).toBe(true);
        expect(existsSync(join(result.outputDirectory, "server.ts"))).toBe(true);

        // The project functions have to appear in the generated API, or the
        // dashboard's `api.projects.list` is a type error the app never sees.
        expect(readFileSync(join(result.outputDirectory, "api.ts"), "utf8")).toContain("projects");
    });

    it("wrangler.jsonc declares the bindings the schema needs", () => {
        expect.assertions(5);

        const result = validateWranglerProject({ projectRoot });

        expect(result.wranglerPath).toBeDefined();
        expect(result.problems).toStrictEqual([]);
        expect(result.report.valid).toBe(true);

        const wrangler = readFileSync(join(projectRoot, "wrangler.jsonc"), "utf8");

        // SHARD DO for the per-project tables.
        expect(wrangler).toContain("ShardDO");
        // `.global()` tables are D1-backed, so the DB binding is not optional —
        // without it every dashboard read fails at runtime, not at build time.
        expect(wrangler).toContain("d1_databases");
    });
});

describe("builder storage tiers", () => {
    const schema = readFileSync(join(projectRoot, "lunora", "schema.ts"), "utf8");

    it.each(SHARDED_BY_PROJECT)("keeps %s sharded by projectId", (table) => {
        expect.assertions(1);

        // Match the table's own declaration block, not merely "the file contains
        // .shardBy somewhere" — which would pass even if this table lost it.
        const block = new RegExp(String.raw`${table}: defineTable\([\s\S]*?\.shardBy\("projectId"\)`, "u");

        expect(schema).toMatch(block);
    });

    it.each(GLOBAL_TABLES)("keeps %s global", (table) => {
        expect.assertions(1);

        const block = new RegExp(String.raw`${table}: defineTable\([\s\S]*?\.global\(\)`, "u");

        expect(schema).toMatch(block);
    });

    it("resolves a share by token alone", () => {
        expect.assertions(1);

        // The share link is visited by someone who has no project id, so the
        // token index is what makes the lookup possible at all. If this index is
        // renamed or dropped, share links degrade to a global table scan.
        expect(schema).toMatch(/shares: defineTable\([\s\S]*?\.index\("by_token", \["token"\], \{ unique: true \}\)/u);
    });
});
