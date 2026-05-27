import { sql } from "drizzle-orm";

import type { D1DatabaseLike } from "./D1Client.js";
import { D1Client } from "./D1Client.js";

export interface Migration {
    /** Human-readable name, e.g. `001_init` (used in logs). */
    name: string;
    /** Raw SQL to apply. Should be idempotent where possible. */
    sql: string;
    /** Monotonically increasing integer used to order migrations. */
    version: number;
}

/**
 * Drizzle's canonical migration-tracking table. The column shape matches
 * `drizzle-orm/migrator`'s `MigrationConfig`, so a future swap to drizzle-kit
 * journal-based migrations can read the same table without a data migration.
 *
 * - `hash` is the SHA-256 of the migration SQL — content-addressed dedup.
 * - `created_at` is wall-clock millis at apply time (NUMERIC per drizzle).
 */
const TRACKING_TABLE_NAME = "__drizzle_migrations";
const TRACKING_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE_NAME} (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)`;

export interface MigrationRunnerResult {
    applied: { name: string; version: number }[];
    skipped: { name: string; version: number }[];
}

/**
 * Sequentially applies pending migrations against a D1 database via the
 * drizzle-orm/d1 driver. Each migration is hashed (SHA-256 over its SQL
 * text); the hash is stored in `__drizzle_migrations`, so re-applying the
 * same SQL under a different `version` is rejected and identical migrations
 * are skipped idempotently.
 */
export class MigrationRunner {
    private readonly client: D1Client;

    private readonly migrations: Migration[];

    /**
     * Accepts either a {@link D1Client} (preferred — gets typed batches +
     * drizzle handle for free) or a raw `D1DatabaseLike` binding (wrapped on
     * the caller's behalf so existing `@cirrus/cli` callers keep working).
     */
    constructor(db: D1Client | D1DatabaseLike, migrations: Migration[]) {
        this.client = db instanceof D1Client ? db : new D1Client(db);
        this.migrations = [...migrations].sort((a, b) => a.version - b.version);
        this.assertUniqueVersions();
        this.assertUniqueSql();
    }

    public async run(): Promise<MigrationRunnerResult> {
        await this.client.drizzle.run(sql.raw(TRACKING_TABLE_DDL));

        const appliedRows = await this.client.drizzle.all<{ hash: string }>(sql.raw(`SELECT hash FROM ${TRACKING_TABLE_NAME}`));
        const appliedHashes = new Set(appliedRows.map((row) => row.hash));

        const applied: { name: string; version: number }[] = [];
        const skipped: { name: string; version: number }[] = [];

        for (const migration of this.migrations) {
            const hash = await hashMigration(migration.sql);

            if (appliedHashes.has(hash)) {
                skipped.push({ version: migration.version, name: migration.name });

                continue;
            }

            await this.applyOne(migration, hash);
            applied.push({ version: migration.version, name: migration.name });
        }

        return { applied, skipped };
    }

    private async applyOne(migration: Migration, hash: string): Promise<void> {
        // D1 lacks user-level BEGIN/COMMIT, but `batch` runs statements
        // atomically. Split on `;` boundaries that aren't trivially empty.
        const statementTexts = migration.sql
            .split(/;\s*(?:\n|$)/u)
            .map((part) => part.trim())
            .filter((part) => part.length > 0);

        // Inline the tracking row as a literal SQL fragment (no params). drizzle's
        // `SQLiteRaw._prepare()` returns itself but has no `.stmt`, so when batch
        // sees params it crashes at `stmt.bind(...)`. Matching drizzle's own d1
        // migrator: build the INSERT entirely via `sql.raw()` so params.length is
        // 0 and drizzle falls back to `this.client.prepare(sql).bind()`.
        // `hash` is hex from SHA-256; safe to inline as a literal.
        const insertSql = `INSERT INTO ${TRACKING_TABLE_NAME} (hash, created_at) VALUES ('${hash}', ${Date.now()})`;

        const items = [...statementTexts.map((text) => this.client.drizzle.run(sql.raw(text))), this.client.drizzle.run(sql.raw(insertSql))];

        // At runtime each `db.run(sql.raw(...))` is a `SQLiteRaw` instance —
        // it satisfies drizzle's BatchItem contract via its `_prepare()` method,
        // even though the TS signature claims `Promise<RunResult>`. The cast
        // bridges that runtime/type-system gap; without it tsc rejects the call.
        await this.client.batch(items as unknown as Parameters<typeof this.client.batch>[0]);
    }

    private assertUniqueVersions(): void {
        const seen = new Set<number>();

        for (const m of this.migrations) {
            if (seen.has(m.version)) {
                throw new Error(`Duplicate migration version ${m.version}`);
            }

            seen.add(m.version);
        }
    }

    private assertUniqueSql(): void {
        // Catch the most common authoring mistake: a copy-paste migration with
        // a bumped version but identical SQL. Hash collisions are checked at
        // apply time too (against the tracking table), but failing fast at
        // construction means the CLI surfaces the problem before any I/O.
        const seen = new Map<string, number>();

        for (const m of this.migrations) {
            const previousVersion = seen.get(m.sql);

            if (previousVersion !== undefined) {
                throw new Error(`Migrations ${previousVersion} and ${m.version} have identical SQL — bump the content, not just the version.`);
            }

            seen.set(m.sql, m.version);
        }
    }
}

/**
 * SHA-256 of the migration SQL, hex-encoded. Available natively in both the
 * Workers runtime (`crypto.subtle`) and Node 22+, so no platform shim needed.
 */
const hashMigration = async (text: string): Promise<string> => {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
