import { LunoraError } from "@lunora/errors";
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
 * Drizzle's canonical migration-tracking table, borrowed for its column shape
 * (`id` / `hash` / `created_at`) so `drizzle-orm/d1`'s `migrate()` can be
 * pointed at the same table without a schema change.
 *
 * It is **not** drop-in swappable, and nothing should be built on the
 * assumption that it is: drizzle decides what to apply purely from
 * `Number(created_at) < migration.folderMillis` of the newest row (its
 * `d1/migrator.js`; it never reads `hash`), and it stores `folderMillis` — the
 * moment the journal entry was *generated*. This runner stores wall-clock
 * millis at *apply* time and dedups by content hash instead, so after a swap
 * every journal migration generated before the last Lunora apply would be
 * skipped. Moving to drizzle-kit journals therefore needs a real data
 * migration (rewrite `created_at` from the journal), not just a call-site swap.
 *
 * - `hash` is the SHA-256 of the migration SQL — content-addressed dedup.
 * `UNIQUE` so two runners racing the same pending migration (parallel CI
 * deploys / two isolates on the migrate path) can't both insert the tracking
 * row: the loser's atomic batch rolls back and its body never double-applies.
 * - `created_at` is wall-clock millis at apply time (NUMERIC per drizzle).
 */
const TRACKING_TABLE_NAME = "__drizzle_migrations";
const TRACKING_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE_NAME} (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at NUMERIC)`;

/** Single whitespace char — used by the trailing-token scan. Hoisted to avoid per-call recompilation. */
const WHITESPACE_RE = /\s/u;
/** A character that continues a SQL word token (keyword or identifier). Hoisted to avoid per-call recompilation. */
const WORD_CHAR_RE = /[$\w]/u;
/** Leading whitespace and comments, so the `CREATE TRIGGER` probe can look past a migration's header comment. */
const LEADING_TRIVIA_RE = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u;
/** `CREATE [TEMP|TEMPORARY] TRIGGER` at the head of a migration — the one statement whose body carries its own `;`s. */
const CREATE_TRIGGER_RE = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/iu;
/** Lowercase hex SHA-256 shape guard before inlining the hash into SQL. Hoisted to avoid per-call recompilation. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

/**
 * Matches D1/SQLite's `UNIQUE constraint failed: __drizzle_migrations.hash`
 * error, raised when a concurrent runner inserted the tracking row first. Built
 * from {@link TRACKING_TABLE_NAME} so it can't drift from the table it guards.
 */
const TRACKING_HASH_UNIQUE_RE = new RegExp(String.raw`UNIQUE constraint failed:\s*${TRACKING_TABLE_NAME}\.hash`, "iu");

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
 * `CREATE TRIGGER` is the one statement whose body legitimately contains `;`s
 * (`BEGIN INSERT …; END;`), and it cannot be split across migrations — so the
 * scan borrows SQLite's own `sqlite3_complete()` rule for it: inside a trigger,
 * a `;` ends the statement only when the token before it is an `END` that itself
 * directly follows a body `;`. That distinguishes the trigger's closing `END`
 * from a `CASE … END` in the body, which is never preceded by a `;`.
 *
 * The scan is a hand-written SQL lexer: a single linear pass over the source
 * with a small set of mutually-exclusive mode flags. Its branching IS the
 * grammar, so splitting it across helpers (each needing the same closured
 * cursor state) reads worse than the flat machine below — hence the inline
 * complexity allowance, matching `@lunora/do`'s `data-migration.ts` twin.
 *
 * Callers wanting multiple statements per migration should split them into
 * separate `Migration` entries — `batch()` runs them atomically anyway.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- hand-written single-pass SQL lexer; the mode branching is the grammar and inlines more clearly than split helpers sharing cursor state (see @lunora/do data-migration.ts)
const assertSingleStatement = (migration: Migration): number | undefined => {
    const text = migration.sql;
    const isTrigger = CREATE_TRIGGER_RE.test(text.slice(LEADING_TRIVIA_RE.exec(text)?.[0].length ?? 0));
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    let terminatorIndex: number | undefined;
    // Trigger-body bookkeeping (inert unless `isTrigger`): the word token being
    // accumulated, whether the last token was an `END` that followed a body `;`,
    // and whether the last token was that body `;`.
    let word = "";
    let endClosesBody = false;
    let afterBodySemicolon = false;

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

        // Comment starts are allowed anywhere, including after the terminating
        // `;` (a trailing comment), so detect them before the terminator guard.
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

        // Once the (single) statement's terminating `;` is seen, the only
        // executable content that may follow is whitespace and comments. Any
        // other token — a stray second `;`, an opening quote, another statement
        // — is a second statement. Guarding here (ahead of the string-open and
        // `;` branches below) closes the holes where `SELECT 1;;` and
        // `SELECT 1; 'stray'` previously slipped past as "valid".
        if (terminatorIndex !== undefined) {
            if (character !== undefined && !WHITESPACE_RE.test(character)) {
                throw new LunoraError(
                    "INTERNAL",
                    `Migration "${migration.name}" (v${String(migration.version)}) contains more than one SQL statement. Split it into separate migrations — batch() runs them atomically.`,
                );
            }

            continue;
        }

        if (isTrigger && character !== undefined) {
            if (WORD_CHAR_RE.test(character)) {
                word += character;
                continue;
            }

            const token = word.toUpperCase();

            word = "";

            if (token !== "") {
                endClosesBody = afterBodySemicolon && token === "END";
                afterBodySemicolon = false;
            } else if (character !== ";" && !WHITESPACE_RE.test(character)) {
                // Any other punctuation breaks the `; END ;` run (so a `CASE … END`
                // in the body can't be mistaken for the trigger's closing `END`).
                endClosesBody = false;
                afterBodySemicolon = false;
            }
        }

        if (character === "'") {
            inSingle = true;
            continue;
        }

        if (character === '"') {
            inDouble = true;
            continue;
        }

        if (character === ";") {
            if (isTrigger && !endClosesBody) {
                // A `;` inside the trigger body, not the statement's terminator.
                afterBodySemicolon = true;
                continue;
            }

            // A `;` ends the (only) statement. Record its index so the caller can
            // strip it plus any trailing comment/whitespace before submitting to
            // D1, which rejects any content after the statement's terminator.
            terminatorIndex = index;
        }
    }

    return terminatorIndex;
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
     * the caller's behalf so existing `@lunora/cli` callers keep working).
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
            const didApply = await this.applyOne(migration, hash);

            // `false` means a concurrent runner won the race and inserted the
            // tracking row first (UNIQUE(hash) rejected ours, batch rolled back)
            // — the migration is applied, just not by us, so record it as skipped.
            if (didApply) {
                applied.push({ name: migration.name, version: migration.version });
            } else {
                skipped.push({ name: migration.name, version: migration.version });
            }
        }

        return { applied, skipped };
    }

    private async applyOne(migration: Migration, hash: string): Promise<boolean> {
        // D1 lacks user-level BEGIN/COMMIT, but `batch` runs statements
        // atomically. A migration is required to be a single statement (or
        // a whitespace-only trailing `;`) — a naive split-on-`;` mishandles
        // semicolons inside string literals, comments and trigger bodies.
        // Callers wanting multiple statements per file should split them
        // across migrations; a `CREATE TRIGGER … BEGIN …; END;` stays whole.
        const terminatorIndex = assertSingleStatement(migration);

        // Strip from the terminating `;` onward (the lexer's own index) rather
        // than regex-trimming just the final `;`: a trailing comment after the
        // `;` would otherwise survive and D1 rejects any content past the
        // statement. When there's no terminator, submit the whole (trimmed) text.
        const statementText = (terminatorIndex === undefined ? migration.sql : migration.sql.slice(0, terminatorIndex)).trim();

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
            throw new LunoraError("INTERNAL", `migration "${migration.name}" produced a non-hex hash; refusing to inline into SQL`);
        }

        const trackingInsertSql = `INSERT INTO ${TRACKING_TABLE_NAME} (hash, created_at) VALUES ('${hash}', ${String(Date.now())})`;

        const items = [this.client.drizzle.run(sql.raw(statementText)), this.client.drizzle.run(sql.raw(trackingInsertSql))];

        try {
            await this.client.batch(items as unknown as Parameters<typeof this.client.batch>[0]);
        } catch (error: unknown) {
            // A concurrent runner that raced us past the applied-hash read
            // inserted this tracking hash first; UNIQUE(hash) rejects ours and
            // D1's atomic batch rolls our migration body back too, so nothing
            // double-applies. Report it as "applied by the winner" (skip) rather
            // than surfacing the constraint error.
            if (TRACKING_HASH_UNIQUE_RE.test(error instanceof Error ? error.message : String(error))) {
                return false;
            }

            throw error;
        }

        return true;
    }

    private assertUniqueVersions(): void {
        const seen = new Set<number>();

        for (const m of this.migrations) {
            if (seen.has(m.version)) {
                throw new LunoraError("INTERNAL", `Duplicate migration version ${String(m.version)}`);
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
                throw new LunoraError(
                    "INTERNAL",
                    `Migrations ${String(previousVersion)} and ${String(m.version)} have identical SQL — bump the content, not just the version.`,
                );
            }

            seen.set(m.sql, m.version);
        }
    }
}

export { MigrationRunner, TRACKING_TABLE_NAME };
export type { Migration, MigrationRunnerResult };
