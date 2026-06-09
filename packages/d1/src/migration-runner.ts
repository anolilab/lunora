import { sql } from "drizzle-orm";

import type { D1DatabaseLike } from "./d1-client";
import { D1Client } from "./d1-client";

interface Migration {
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

/** Single whitespace char — used by the trailing-token scan. Hoisted to avoid per-call recompilation. */
const WHITESPACE_RE = /\s/u;
/** Trailing `;` (plus whitespace) trimmer applied before submitting SQL to D1. Hoisted to avoid per-call recompilation. */
const TRAILING_SEMICOLON_RE = /;\s*$/u;
/** Lowercase hex SHA-256 shape guard before inlining the hash into SQL. Hoisted to avoid per-call recompilation. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

interface MigrationRunnerResult {
    applied: { name: string; version: number }[];
    skipped: { name: string; version: number }[];
}

/**
 * Reject a migration whose SQL contains more than one statement. Performs a
 * quote- and comment-aware scan so semicolons inside `'...'`, `"..."`,
 * `--`-line comments, and `/* ... *\/` blocks don't trip the check. A trailing
 * `;` followed only by whitespace and/or comments is allowed (and `;` is
 * stripped before submission to D1).
 *
 * The scan is a hand-written SQL lexer: a single linear pass over the source
 * with a small set of mutually-exclusive mode flags. Its branching IS the
 * grammar, so splitting it across helpers (each needing the same closured
 * cursor state) reads worse than the flat machine below — hence the inline
 * complexity allowance, matching `@cirrus/do`'s `data-migration.ts` twin.
 *
 * Callers wanting multiple statements per migration should split them into
 * separate `Migration` entries — `batch()` runs them atomically anyway.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- hand-written single-pass SQL lexer; the mode branching is the grammar and inlines more clearly than split helpers sharing cursor state (see @cirrus/do data-migration.ts)
const assertSingleStatement = (migration: Migration): void => {
    const text = migration.sql;
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    let seenStatement = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const next = text[index + 1];

        if (inLineComment) {
            if (character === "\n") {
                inLineComment = false;
            }

            continue;
        }

        if (inBlockComment) {
            if (character === "*" && next === "/") {
                inBlockComment = false;
                index += 1;
            }

            continue;
        }

        if (inSingle) {
            // SQL escapes a quote by doubling it.
            if (character === "'") {
                if (next === "'") {
                    index += 1;
                } else {
                    inSingle = false;
                }
            }

            continue;
        }

        if (inDouble) {
            if (character === '"') {
                if (next === '"') {
                    index += 1;
                } else {
                    inDouble = false;
                }
            }

            continue;
        }

        if (character === "'") {
            inSingle = true;
            continue;
        }

        if (character === '"') {
            inDouble = true;
            continue;
        }

        if (character === "-" && next === "-") {
            inLineComment = true;
            index += 1;
            continue;
        }

        if (character === "/" && next === "*") {
            inBlockComment = true;
            index += 1;
            continue;
        }

        if (character === ";") {
            // A `;` ends the (only) statement; anything executable after it is
            // a second statement. Trailing whitespace/comments are allowed.
            seenStatement = true;
            continue;
        }

        if (seenStatement && character !== undefined && !WHITESPACE_RE.test(character)) {
            throw new Error(
                `Migration "${migration.name}" (v${String(migration.version)}) contains more than one SQL statement. Split it into separate migrations — batch() runs them atomically.`,
            );
        }
    }
};

/**
 * SHA-256 of the migration SQL, hex-encoded. Available natively in both the
 * Workers runtime (`crypto.subtle`) and Node 22+, so no platform shim needed.
 */
const hashMigration = async (text: string): Promise<string> => {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Sequentially applies pending migrations against a D1 database via the
 * drizzle-orm/d1 driver. Each migration is hashed (SHA-256 over its SQL
 * text); the hash is stored in `__drizzle_migrations`, so re-applying the
 * same SQL under a different `version` is rejected and identical migrations
 * are skipped idempotently.
 */
class MigrationRunner {
    private readonly client: D1Client;

    private readonly migrations: Migration[];

    /**
     * Accepts either a {@link D1Client} (preferred — gets typed batches +
     * drizzle handle for free) or a raw `D1DatabaseLike` binding (wrapped on
     * the caller's behalf so existing `@cirrus/cli` callers keep working).
     */
    public constructor(database: D1Client | D1DatabaseLike, migrations: Migration[]) {
        this.client = database instanceof D1Client ? database : new D1Client(database);
        this.migrations = [...migrations].toSorted((a, b) => a.version - b.version);
        this.assertUniqueVersions();
        this.assertUniqueSql();
    }

    public async run(): Promise<MigrationRunnerResult> {
        await this.client.drizzle.run(sql.raw(TRACKING_TABLE_DDL));

        const appliedRows = await this.client.drizzle.all<{ hash: string }>(sql.raw(`SELECT hash FROM ${TRACKING_TABLE_NAME}`));
        const appliedHashes = new Set(appliedRows.map((row) => row.hash));

        const applied: { name: string; version: number }[] = [];
        const skipped: { name: string; version: number }[] = [];

        // Hashing is pure and order-independent, so compute every hash up front
        // in parallel; applying then proceeds strictly in version order below.
        const hashes = await Promise.all(this.migrations.map(async (migration) => hashMigration(migration.sql)));

        for (const [index, migration] of this.migrations.entries()) {
            const hash = hashes[index] as string;

            if (appliedHashes.has(hash)) {
                skipped.push({ name: migration.name, version: migration.version });

                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- migrations must apply strictly in version order; each applyOne writes the tracking row the next iteration relies on.
            await this.applyOne(migration, hash);
            applied.push({ name: migration.name, version: migration.version });
        }

        return { applied, skipped };
    }

    private async applyOne(migration: Migration, hash: string): Promise<void> {
        // D1 lacks user-level BEGIN/COMMIT, but `batch` runs statements
        // atomically. A migration is required to be a single statement (or
        // a whitespace-only trailing `;`) — a naive split-on-`;` mishandles
        // semicolons inside string literals and comments. Callers wanting
        // multiple statements per file should split them across migrations.
        assertSingleStatement(migration);

        const statementText = migration.sql.replace(TRAILING_SEMICOLON_RE, "").trim();

        // Apply the migration body AND write the tracking row in a single
        // atomic `client.batch(...)` so they commit (or roll back) together —
        // D1's `batch` runs as an implicit transaction. If they were two
        // separate statements, a body that committed before a failing tracking
        // INSERT would re-apply on the next run (bad for non-idempotent
        // migrations).
        //
        // drizzle's d1 batch path crashes on a `SQLiteRaw` whose
        // `params.length > 0` (it has no `.stmt` to bind against), so the
        // tracking row can't use bound `?` params here. We inline the two
        // values into the `sql.raw` literal instead — safe because both are
        // engine-controlled, not user-supplied: `hash` is a 64-char SHA-256
        // hex string (asserted below) and `created_at` is a numeric clock
        // reading. The hash assertion guarantees no quote/escape can slip in.
        if (!SHA256_HEX_RE.test(hash)) {
            throw new Error(`migration "${migration.name}" produced a non-hex hash; refusing to inline into SQL`);
        }

        const trackingInsertSql = `INSERT INTO ${TRACKING_TABLE_NAME} (hash, created_at) VALUES ('${hash}', ${String(Date.now())})`;

        const items = [this.client.drizzle.run(sql.raw(statementText)), this.client.drizzle.run(sql.raw(trackingInsertSql))];

        await this.client.batch(items as unknown as Parameters<typeof this.client.batch>[0]);
    }

    private assertUniqueVersions(): void {
        const seen = new Set<number>();

        for (const m of this.migrations) {
            if (seen.has(m.version)) {
                throw new Error(`Duplicate migration version ${String(m.version)}`);
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
                throw new Error(`Migrations ${String(previousVersion)} and ${String(m.version)} have identical SQL — bump the content, not just the version.`);
            }

            seen.set(m.sql, m.version);
        }
    }
}

export { MigrationRunner };
export type { Migration, MigrationRunnerResult };
