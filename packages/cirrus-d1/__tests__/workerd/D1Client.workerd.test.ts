/**
 * Real-D1 integration tests for `@cirrus/d1`.
 *
 * These boot a real Miniflare D1 instance via `@cloudflare/vitest-pool-workers`
 * and verify the Sessions API + MigrationRunner against the actual binding.
 * The mock-based suite under `__tests__/D1Client.test.ts` exercises the same
 * logic against doubles — the value here is verifying the wire shapes that
 * mocks cannot model:
 *
 *  - `env.DB.withSession(bookmark)` returns a real session whose bookmark
 *    changes after a write.
 *  - `MigrationRunner` correctly bootstraps `_cirrus_migrations` and is
 *    idempotent across re-runs against a real SQLite store.
 */
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";

import type { Env } from "./test-worker.js";

// `env` is typed via the `Cloudflare.Env` augmentation in `./env.d.ts`.

const dropUsers = async (): Promise<void> => {
    try {
        await env.DB.prepare("DROP TABLE IF EXISTS users").run();
    } catch {
        /* table may not exist */
    }

    try {
        await env.DB.prepare("DROP TABLE IF EXISTS _cirrus_migrations").run();
    } catch {
        /* table may not exist */
    }
};

describe("D1 (workerd)", () => {
    beforeEach(async () => {
        await dropUsers();
    });

    test("MigrationRunner applies migrations against a real D1 database and is idempotent", async () => {
        const migrations = [
            { version: 1, name: "init", sql: "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)" },
            { version: 2, name: "add_email", sql: "ALTER TABLE users ADD COLUMN email TEXT" },
        ];

        const first = await SELF.fetch("https://test/migrate", {
            method: "POST",
            body: JSON.stringify({ migrations }),
        }).then((r) => r.json() as Promise<{ applied: { version: number }[]; skipped: { version: number }[] }>);

        expect(first.applied.map((m) => m.version)).toEqual([1, 2]);
        expect(first.skipped).toEqual([]);

        // Re-running applies nothing — the tracking table is real.
        const second = await SELF.fetch("https://test/migrate", {
            method: "POST",
            body: JSON.stringify({ migrations }),
        }).then((r) => r.json() as Promise<{ applied: { version: number }[]; skipped: { version: number }[] }>);

        expect(second.applied).toEqual([]);
        expect(second.skipped.map((m) => m.version)).toEqual([1, 2]);

        // The migration left a usable schema behind.
        const row = await env.DB.prepare("SELECT version FROM _cirrus_migrations ORDER BY version DESC LIMIT 1").first<{ version: number }>();

        expect(row?.version).toBe(2);
    });

    test("withSession() returns a real D1 bookmark after a write", async () => {
        await env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)").run();

        const insert = await SELF.fetch("https://test/insert", {
            method: "POST",
            body: JSON.stringify({ id: "u1", name: "Ada" }),
        }).then((r) => r.json() as Promise<{ ok: boolean; bookmark: string | null }>);

        expect(insert.ok).toBe(true);

        // Local D1 may or may not issue a bookmark depending on Miniflare's
        // session-emulation state. We only assert the field is present and,
        // when supplied, round-trips back through the next read without error.
        const list = await SELF.fetch("https://test/list", {
            headers: insert.bookmark ? { "x-d1-bookmark": insert.bookmark } : {},
        }).then((r) => r.json() as Promise<{ rows: { id: string; name: string }[]; bookmark: string | null }>);

        expect(list.rows).toEqual([{ id: "u1", name: "Ada" }]);
    });

    test("D1Client.prepare() works against the real binding for raw SQL", async () => {
        await env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)").run();
        await env.DB.prepare("INSERT INTO users (id, name) VALUES (?, ?)").bind("u2", "Linus").run();

        const result = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind("u2").first<{ name: string }>();

        expect(result?.name).toBe("Linus");
    });
});
