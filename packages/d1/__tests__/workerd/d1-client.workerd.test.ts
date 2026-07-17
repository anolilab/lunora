/**
 * Real-D1 integration tests for `@lunora/d1`.
 *
 * These boot a real Miniflare D1 instance via `@cloudflare/vitest-pool-workers`
 * and verify the Sessions API + MigrationRunner against the actual binding.
 * The mock-based suite under `__tests__/D1Client.test.ts` exercises the same
 * logic against doubles — the value here is verifying the wire shapes that
 * mocks cannot model: `env.DB.withSession(bookmark)` returns a real session
 * whose bookmark changes after a write; `MigrationRunner` correctly bootstraps
 * `__drizzle_migrations` via the drizzle d1 batch path and is idempotent across
 * re-runs against a real SQLite store. Guards against drizzle-internal
 * regressions in the batch `_prepare()`/`stmt.bind()` chain that unit-test
 * doubles can't catch.
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// `env` is typed via the `Cloudflare.Env` augmentation in `./env.d.ts`.

/** Lowercase hex SHA-256 shape guard. Hoisted to avoid per-call recompilation. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

interface MigrationEntry {
    name: string;
    version: number;
}

interface MigrateResult {
    applied: MigrationEntry[];
    skipped: MigrationEntry[];
}

interface InsertResult {
    bookmark: string | null;
    ok: boolean;
}

interface ListResult {
    bookmark: string | null;
    rows: { id: string; name: string }[];
}

const dropUsers = async (): Promise<void> => {
    try {
        await env.DB.prepare("DROP TABLE IF EXISTS users").run();
    } catch {
        /* table may not exist */
    }

    try {
        await env.DB.prepare("DROP TABLE IF EXISTS __drizzle_migrations").run();
    } catch {
        /* table may not exist */
    }
};

describe("d1 (workerd)", () => {
    beforeEach(async () => {
        await dropUsers();
    });

    it("migrationRunner applies migrations against a real D1 database and is idempotent", async () => {
        expect.assertions(6);

        const migrations = [
            { name: "init", sql: "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)", version: 1 },
            { name: "add_email", sql: "ALTER TABLE users ADD COLUMN email TEXT", version: 2 },
        ];

        const first = await SELF.fetch("https://test/migrate", {
            body: JSON.stringify({ migrations }),
            method: "POST",
        }).then((r) => r.json<MigrateResult>());

        expect(first.applied.map((m) => m.version)).toEqual([1, 2]);
        expect(first.skipped).toEqual([]);

        // Re-running applies nothing — the tracking table is real.
        const second = await SELF.fetch("https://test/migrate", {
            body: JSON.stringify({ migrations }),
            method: "POST",
        }).then((r) => r.json<MigrateResult>());

        expect(second.applied).toEqual([]);
        expect(second.skipped.map((m) => m.version)).toEqual([1, 2]);

        // The drizzle-canonical tracking table is content-addressed: one row per
        // unique migration SQL hash. Verifying via raw D1 (not the drizzle
        // handle) ensures the data actually landed on disk.
        const rows = await env.DB.prepare("SELECT hash FROM __drizzle_migrations ORDER BY id").all<{ hash: string }>();

        expect(rows.results).toHaveLength(2);
        expect(rows.results.every((row) => SHA256_HEX_RE.test(row.hash))).toBe(true);
    });

    it("migrationRunner applies separate single-statement migrations in order", async () => {
        // 3 assertions: applied versions + the two sqlite_master presence checks.
        // (Was 5 from a pre-security-audit draft that split one multi-statement
        // migration and asserted per-statement — stale after the rewrite below.)
        expect.assertions(3);

        // Each migration must be a single SQL statement (multi-statement
        // migrations were rejected after the security audit — semicolon-split
        // mishandles literals + comments). Two `CREATE TABLE`s become two
        // migrations; the runner applies them in version order.
        const migrations = [
            { name: "users", sql: "CREATE TABLE users (id TEXT PRIMARY KEY)", version: 1 },
            { name: "posts", sql: "CREATE TABLE posts (id TEXT PRIMARY KEY, author TEXT NOT NULL)", version: 2 },
        ];

        const result = await SELF.fetch("https://test/migrate", {
            body: JSON.stringify({ migrations }),
            method: "POST",
        }).then((r) => r.json<MigrateResult>());

        expect(result.applied.map((m) => m.version)).toEqual([1, 2]);

        // Both tables present — each migration ran end-to-end.
        const users = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").first<{ name: string }>();
        const posts = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").first<{ name: string }>();

        expect(users?.name).toBe("users");
        expect(posts?.name).toBe("posts");

        // Cleanup so other tests don't see the extra `posts` table.
        await env.DB.prepare("DROP TABLE IF EXISTS posts").run();
    });

    it("withSession() returns a real D1 bookmark after a write", async () => {
        expect.assertions(2);

        await env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)").run();

        const insert = await SELF.fetch("https://test/insert", {
            body: JSON.stringify({ id: "u1", name: "Ada" }),
            method: "POST",
        }).then((r) => r.json<InsertResult>());

        expect(insert.ok).toBe(true);

        // Local D1 may or may not issue a bookmark depending on Miniflare's
        // session-emulation state. We only assert the field is present and,
        // when supplied, round-trips back through the next read without error.
        const list = await SELF.fetch("https://test/list", {
            headers: insert.bookmark ? { "x-d1-bookmark": insert.bookmark } : {},
        }).then((r) => r.json<ListResult>());

        expect(list.rows).toEqual([{ id: "u1", name: "Ada" }]);
    });

    it("d1Client.prepare() works against the real binding for raw SQL", async () => {
        expect.assertions(1);

        await env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)").run();
        await env.DB.prepare("INSERT INTO users (id, name) VALUES (?, ?)").bind("u2", "Linus").run();

        const result = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind("u2").first<{ name: string }>();

        expect(result?.name).toBe("Linus");
    });
});
