import { sql } from "drizzle-orm";

import type { D1DatabaseLike } from "./d1-client.js";
import { D1Client } from "./d1-client.js";

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
        // atomically. A migration is required to be a single statement (or
        // a whitespace-only trailing `;`) — a naive split-on-`;` mishandles
        // semicolons inside string literals and comments. Callers wanting
        // multiple statements per file should split them across migrations.
        assertSingleStatement(migration);

        const statementText = migration.sql.replace(/;\s*$/u, "").trim();

        // Atomically apply the migration body via drizzle's batch — same as
        // before. The tracking row (`hash`, `created_at`) is then written via
        // a *bound* D1 prepared statement so neither value is interpolated
        // into SQL. Although `hash` is hex from SHA-256 and structurally safe,
        // string-inlining sets a fragile precedent and breaks if a future
        // field is user-supplied. We can't keep this INSERT inside the same
        // `client.batch(...)` call because drizzle's d1 batch path crashes on
        // a `SQLiteRaw` whose `params.length > 0` (it has no `.stmt` to bind
        // against). The cost: if the migration body succeeds but the tracking
        // INSERT fails (network blip), the migration will be re-applied on
        // the next run — matching drizzle's own migrator behavior and relying
        // on user SQL being idempotent (`CREATE TABLE IF NOT EXISTS`, etc.).
        const items = [this.client.drizzle.run(sql.raw(statementText))];

        await this.client.batch(items as unknown as Parameters<typeof this.client.batch>[0]);

        const insertSql = `INSERT INTO ${TRACKING_TABLE_NAME} (hash, created_at) VALUES (?, ?)`;

        await this.client.raw.prepare(insertSql).bind(hash, Date.now()).run();
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
 * Reject a migration whose SQL contains more than one statement. Performs a
 * quote- and comment-aware scan so semicolons inside `'...'`, `"..."`,
 * `--`-line comments, and `/* ... *\/` blocks don't trip the check. A trailing
 * `;` followed only by whitespace and/or comments is allowed (and `;` is
 * stripped before submission to D1).
 *
 * Callers wanting multiple statements per migration should split them into
 * separate `Migration` entries — `batch()` runs them atomically anyway.
 */
const assertSingleStatement = (migration: Migration): void => {
    const text = migration.sql;
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]!;
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
            if (character === "'") {
                // SQL escapes a quote by doubling it.
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
            // Permit a trailing `;` followed only by whitespace/comments —
            // resume the lexer past the `;` and require that no further
            // executable token appears.
            for (let trailing = index + 1; trailing < text.length; trailing += 1) {
                const tail = text[trailing]!;
                const tailNext = text[trailing + 1];

                if (inLineComment) {
                    if (tail === "\n") {
                        inLineComment = false;
                    }

                    continue;
                }

                if (inBlockComment) {
                    if (tail === "*" && tailNext === "/") {
                        inBlockComment = false;
                        trailing += 1;
                    }

                    continue;
                }

                if (tail === "-" && tailNext === "-") {
                    inLineComment = true;
                    trailing += 1;
                    continue;
                }

                if (tail === "/" && tailNext === "*") {
                    inBlockComment = true;
                    trailing += 1;
                    continue;
                }

                // Any whitespace is fine; anything else means a second
                // statement starts after the `;`.
                if (!/\s/u.test(tail)) {
                    throw new Error(
                        `Migration "${migration.name}" (v${migration.version}) contains more than one SQL statement. Split it into separate migrations — batch() runs them atomically.`,
                    );
                }
            }

            return;
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
