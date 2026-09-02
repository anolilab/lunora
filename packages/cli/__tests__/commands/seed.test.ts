import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StreamingFetchLike } from "../../src/commands/data-transfer";
import { runSeedCommand } from "../../src/commands/seed/handler";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

/** A users + posts schema with a `v.id("users")` foreign key on posts. */
const SCHEMA_SOURCE = `import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";

export default defineSchema({
    users: defineTable({
        email: v.string(),
        name: v.string(),
        age: v.number(),
        role: v.union(v.literal("admin"), v.literal("member")),
    }),
    posts: defineTable({
        authorId: v.id("users"),
        title: v.string(),
        published: v.boolean(),
    }),
});
`;

let workDir: string;

const writeSchema = (): void => {
    mkdirSync(join(workDir, "lunora"), { recursive: true });
    writeFileSync(join(workDir, "lunora", "schema.ts"), SCHEMA_SOURCE, "utf8");
};

describe("lunora seed", () => {
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), "lunora-cli-seed-"));
    });

    afterEach(() => {
        rmSync(workDir, { force: true, recursive: true });
        vi.restoreAllMocks();
    });

    it("fails when no schema is present", async () => {
        expect.assertions(1);

        const result = await runSeedCommand({ cwd: workDir, dryRun: true, logger: silentLogger() });

        expect(result.code).toBe(1);
    });

    it("generates deterministic NDJSON with valid foreign keys on --dry-run", async () => {
        expect.assertions(6);

        writeSchema();
        const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

        const a = await runSeedCommand({ count: 4, cwd: workDir, dryRun: true, logger: silentLogger(), seed: 1 });
        const b = await runSeedCommand({ count: 4, cwd: workDir, dryRun: true, logger: silentLogger(), seed: 1 });

        expect(a.code).toBe(0);
        expect(a.inserted).toBe(0);
        // 4 users + 4 posts.
        expect(a.generated).toBe(8);
        // Same seed ⇒ byte-identical output.
        expect(a.ndjson).toBe(b.ndjson);

        const rows = a.ndjson
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as { doc: Record<string, unknown>; table: string });

        const userIds = new Set(rows.filter((row) => row.table === "users").map((row) => row.doc._id as string));
        const posts = rows.filter((row) => row.table === "posts");

        // Every seeded post's FK points at a real seeded user.
        expect(posts.every((post) => userIds.has(post.doc.authorId as string))).toBe(true);
        // The dry run streamed the NDJSON to stdout.
        expect(writeSpy).toHaveBeenCalledWith(a.ndjson);
    });

    it("restricts generation to --table while still resolving its FK parents", async () => {
        expect.assertions(2);

        writeSchema();
        vi.spyOn(process.stdout, "write").mockReturnValue(true);

        const result = await runSeedCommand({ count: 3, cwd: workDir, dryRun: true, logger: silentLogger(), table: "users" });

        const tables = new Set(
            result.ndjson
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => (JSON.parse(line) as { table: string }).table),
        );

        expect(result.generated).toBe(3);
        expect([...tables]).toEqual(["users"]);
    });

    it("rejects an unknown --table", async () => {
        expect.assertions(1);

        writeSchema();

        const result = await runSeedCommand({ cwd: workDir, dryRun: true, logger: silentLogger(), table: "nope" });

        expect(result.code).toBe(1);
    });

    it("streams the generated NDJSON through the import pipeline", async () => {
        expect.assertions(4);

        writeSchema();

        const calls: { body: string; url: string }[] = [];
        const fetchImpl: StreamingFetchLike = async (url, init) => {
            const body = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body);

            calls.push({ body, url });

            const rows = body.split("\n").filter((line) => line.trim().length > 0);
            const inserted: Record<string, number> = {};

            for (const line of rows) {
                const { table } = JSON.parse(line) as { table: string };

                inserted[table] = (inserted[table] ?? 0) + 1;
            }

            return {
                body: null,
                json: async () => {
                    return { conflicts: 0, errors: [], inserted };
                },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

        const result = await runSeedCommand({
            count: 2,
            cwd: workDir,
            fetchImpl,
            logger: silentLogger(),
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(0);
        expect(result.generated).toBe(4);
        expect(result.inserted).toBe(4);
        expect(calls[0]!.url).toBe("http://localhost:8787/_lunora/admin/import");
    });

    it("surfaces skipped rows as conflicts and warns about determinism", async () => {
        expect.assertions(2);

        writeSchema();

        const logger = silentLogger();
        const warnSpy = vi.spyOn(logger, "warn");
        const fetchImpl: StreamingFetchLike = async () => {
            return {
                body: null,
                // The import path reports every row as an already-existing-id conflict.
                json: async () => {
                    return { conflicts: 4, errors: [], inserted: {} };
                },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

        const result = await runSeedCommand({ count: 2, cwd: workDir, fetchImpl, logger, token: "t", url: "http://localhost:8787" });

        expect(result.conflicts).toBe(4);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("4 row(s) skipped"));
    });

    it("rejects --reset against a remote or production target", async () => {
        expect.assertions(2);

        writeSchema();

        const prodResult = await runSeedCommand({ cwd: workDir, logger: silentLogger(), prod: true, reset: true, url: "https://app.example.com" });
        const remoteResult = await runSeedCommand({ cwd: workDir, logger: silentLogger(), reset: true, url: "https://app.example.com" });

        expect(prodResult.code).toBe(1);
        expect(remoteResult.code).toBe(1);
    });

    it("--reset does not wipe when there is nothing to seed", async () => {
        expect.assertions(2);

        writeSchema();

        const statePath = join(workDir, ".wrangler", "state");

        mkdirSync(statePath, { recursive: true });
        writeFileSync(join(statePath, "live.sqlite"), "data", "utf8");

        const result = await runSeedCommand({ count: 0, cwd: workDir, logger: silentLogger(), reset: true, yes: true });

        expect(result.generated).toBe(0);
        // The wipe used to run first, so `--count 0` destroyed the dev database
        // and then warned there was nothing to insert.
        expect(existsSync(join(statePath, "live.sqlite"))).toBe(true);
    });

    it("--reset requires the same confirmation `lunora reset` does", async () => {
        expect.assertions(3);

        writeSchema();

        const statePath = join(workDir, ".wrangler", "state");

        mkdirSync(statePath, { recursive: true });
        writeFileSync(join(statePath, "live.sqlite"), "data", "utf8");

        const errors: string[] = [];
        // Non-TTY and no --yes: `reset` refuses rather than deleting.
        const result = await runSeedCommand({ count: 2, cwd: workDir, logger: { ...silentLogger(), error: (m) => errors.push(m) }, reset: true });

        expect(result.code).toBe(1);
        expect(existsSync(join(statePath, "live.sqlite"))).toBe(true);
        expect(errors.join("\n")).toContain("--yes");
    });

    it("wipes local .wrangler/state before seeding when --reset is set", async () => {
        expect.assertions(2);

        writeSchema();
        const statePath = join(workDir, ".wrangler", "state");
        mkdirSync(statePath, { recursive: true });
        writeFileSync(join(statePath, "stale.sqlite"), "old", "utf8");

        const fetchImpl: StreamingFetchLike = async () => {
            return {
                body: null,
                json: async () => {
                    return { conflicts: 0, errors: [], inserted: { posts: 2, users: 2 } };
                },
                ok: true,
                status: 200,
                text: async () => "",
            };
        };

        const result = await runSeedCommand({
            count: 2,
            cwd: workDir,
            fetchImpl,
            logger: silentLogger(),
            reset: true,
            token: "t",
            url: "http://localhost:8787",
            yes: true,
        });

        expect(result.code).toBe(0);
        expect(existsSync(statePath)).toBe(false);
    });
});
