import { LunoraError } from "@lunora/errors";
import { sql } from "drizzle-orm";

import { ALLOW_DESTRUCTIVE_MARKER } from "../../../shared/allow-destructive-marker";
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
 * millis at *apply* time and dedups by version instead, so after a swap
 * every journal migration generated before the last Lunora apply would be
 * skipped. Moving to drizzle-kit journals therefore needs a real data
 * migration (rewrite `created_at` from the journal), not just a call-site swap.
 *
 * - `version` is the migration's version, and what decides whether it has run.
 * `UNIQUE` (through {@link TRACKING_VERSION_INDEX}) so two runners racing the
 * same pending migration (parallel CI deploys / two isolates on the migrate
 * path) can't both insert the tracking row: the loser's atomic batch rolls back
 * and its body never double-applies. Nullable only because a table written
 * before it existed has rows without one; {@link MigrationRunner.run} backfills
 * them from the hash.
 * - `hash` is the SHA-256 of the migration SQL, recorded so an applied
 * migration whose text later changes is caught as drift rather than applied a
 * second time. `UNIQUE` as well, for the same race.
 * - `created_at` is wall-clock millis at apply time (NUMERIC per drizzle).
 */
const TRACKING_TABLE_NAME = "__drizzle_migrations";
const TRACKING_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE_NAME} (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at NUMERIC, version INTEGER)`;
/** The unique index on `version`: a named index rather than a column constraint, because `ADD COLUMN` cannot add a UNIQUE one to a table that predates it. */
const TRACKING_VERSION_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS ${TRACKING_TABLE_NAME}_version ON ${TRACKING_TABLE_NAME} (version)`;

/** Single whitespace char — used by the trailing-token scan. Hoisted to avoid per-call recompilation. */
const WHITESPACE_RE = /\s/u;
/** A character that continues a SQL word token (keyword or identifier). Hoisted to avoid per-call recompilation. */
const WORD_CHAR_RE = /[$\w]/u;

/**
 * One unit of SQL trivia BETWEEN two keywords: a whitespace char, a `--` line
 * comment, or a `/* ... *\/` block comment. Written once and shared by both
 * probes below — they drifted apart before, and only the leading position
 * tolerated comments at all.
 *
 * A line comment here must be newline-terminated: something (the next keyword)
 * always follows, so a `--` run to end-of-input cannot occur in this position.
 */
const TRIVIA_SOURCE = String.raw`(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)`;

/**
 * Leading whitespace and comments, so the `CREATE TRIGGER` probe can look past a
 * migration's header comment.
 *
 * Unlike {@link TRIVIA_SOURCE} this position CAN run to end-of-input — a file of
 * nothing but a comment is all trivia — hence the extra `$` alternative.
 */
const LEADING_TRIVIA_RE = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u;

/**
 * `CREATE [TEMP|TEMPORARY] TRIGGER` at the head of a migration — the one
 * statement whose body carries its own `;`s.
 *
 * Trivia is matched BETWEEN the keywords, not just before them: SQLite accepts
 * `CREATE /* … *\/ TRIGGER` as one statement, and a probe that only allowed
 * `\s` there stopped recognising it as a trigger — `scanStatement` then
 * read the body's first `;` as a statement boundary and rejected the trailing
 * `END`, telling the author to split a statement SQLite cannot have split.
 */
const CREATE_TRIGGER_RE = new RegExp(String.raw`^CREATE${TRIVIA_SOURCE}+(?:TEMP${TRIVIA_SOURCE}+|TEMPORARY${TRIVIA_SOURCE}+)?TRIGGER\b`, "iu");

/** Lowercase hex SHA-256 shape guard before inlining the hash into SQL. Hoisted to avoid per-call recompilation. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

/** A character of an unquoted SQLite identifier: `$`, an ASCII word character, or any character above U+007F. */
const IDENTIFIER_CHAR = String.raw`[$\w\u{80}-\u{10FFFF}]`;

const BARE_NAME = `${IDENTIFIER_CHAR}+`;

/** `phrase` (words joined by whitespace) anywhere in the code, as long as it is not part of a longer identifier. */
const phraseRe = (phrase: string): RegExp =>
    new RegExp(String.raw`(?<!${IDENTIFIER_CHAR})${phrase.replaceAll(" ", String.raw`\s+`)}(?!${IDENTIFIER_CHAR})`, "iu");

/**
 * `ALTER TABLE <name> <action>` at the head of {@link scanStatement}'s code, where a quoted name reads as one placeholder
 * word and a schema-qualified one as two joined by `.`.
 */
const alterTableRe = (action: string): RegExp => new RegExp(String.raw`^\s*ALTER\s+TABLE\s+${BARE_NAME}(?:\s*\.\s*${BARE_NAME})?\s+${action}\b`, "iu");

/**
 * Statements that discard data, or rename something every reader of the old name breaks on, matched by statement shape
 * against {@link scanStatement}'s code. Shape rather than keyword, because SQLite lets `RENAME` and `REPLACE` name a
 * column or table, and `$` continue an identifier (`foo$drop`). `REPLACE INTO` is SQLite's spelling of
 * `INSERT OR REPLACE`, which deletes the conflicting row before inserting; `UPDATE OR REPLACE` deletes the row its new
 * values collide with, and an `ON CONFLICT REPLACE` constraint clause makes every later write to the table do the same.
 * All of them are matched anywhere, so a trigger body is covered too; an upsert (`ON CONFLICT … DO UPDATE`) is not.
 * `TRUNCATE` is not SQLite, but a D1-shaped binding over another engine may accept it.
 *
 * A `DELETE` or `UPDATE` without `WHERE` is not checked: a full-table `UPDATE` is what every backfill looks like.
 */
const DESTRUCTIVE_STATEMENTS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
    ["DROP", /^\s*DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b/iu],
    ["DROP", alterTableRe("DROP")],
    ["RENAME", alterTableRe("RENAME")],
    ["TRUNCATE", /^\s*TRUNCATE\b/iu],
    ["INSERT OR REPLACE", phraseRe("INSERT OR REPLACE")],
    ["REPLACE INTO", phraseRe("REPLACE INTO")],
    ["UPDATE OR REPLACE", phraseRe("UPDATE OR REPLACE")],
    ["ON CONFLICT REPLACE", phraseRe("ON CONFLICT REPLACE")],
];

/**
 * Transaction control at the head of a statement. Each migration already commits atomically with its tracking row in
 * one `batch()`, and D1 refuses these outright; a `CREATE TRIGGER … BEGIN … END` never matches, since it starts with
 * `CREATE`.
 */
const TRANSACTION_CONTROL_RE = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;

/** What closes each quoting that opens with the key: SQLite also accepts `[a]` and `` `a` `` for MySQL/MS-Access compatibility. */
const QUOTE_CLOSERS: Readonly<Record<string, string>> = { '"': '"', "'": "'", "[": "]", "`": "`" };

/**
 * Matches D1/SQLite's `UNIQUE constraint failed: __drizzle_migrations.hash`
 * error, raised when a concurrent runner inserted the tracking row first. Built
 * from {@link TRACKING_TABLE_NAME} so it can't drift from the table it guards.
 */
const TRACKING_HASH_UNIQUE_RE = new RegExp(String.raw`UNIQUE constraint failed:\s*${TRACKING_TABLE_NAME}\.(?:hash|version)`, "iu");

/** One row of the tracking table as {@link MigrationRunner.run} reads it. */
interface TrackingRow {
    hash: string;
    id: number;
    version: null | number;
}

interface MigrationRunnerResult {
    applied: { name: string; version: number }[];
    skipped: { name: string; version: number }[];
}

/** What {@link scanStatement} reads off a migration's SQL. */
interface StatementScan {
    /**
     * The SQL with every comment blanked to spaces and every string or quoted identifier to one `_` and spaces, so the
     * keyword checks see only code and a quoted name still reads as one word.
     */
    code: string;
    /** Each `--` comment, from its `--` to the end of its line. */
    lineComments: string[];
    /** The statement to submit: up to its terminating `;`, trimmed, since D1 rejects anything past the terminator. */
    statementText: string;
}

/** A migration {@link MigrationRunner.run} will apply, with what it records and submits. */
interface PendingMigration {
    hash: string;
    migration: Migration;
    statementText: string;
}

/** How {@link MigrationRunner} names a migration in a refusal. */
const describeMigration = (migration: Migration): string => `Migration "${migration.name}" (v${String(migration.version)})`;

/**
 * Read a migration's SQL as one statement, rejecting it when it holds more than one. Quote- and comment-aware, so a
 * `;` inside a string, a quoted identifier or a comment is not a terminator. A trailing `;` followed only by
 * whitespace and comments is allowed. Splitting on `;` instead mishandles exactly those, and trigger bodies.
 *
 * `CREATE TRIGGER` is the one statement whose body legitimately contains `;`s
 * (`BEGIN INSERT …; END;`), and it cannot be split across migrations — so the
 * scan borrows SQLite's own `sqlite3_complete()` rule for it: inside a trigger,
 * a `;` ends the statement only when the token before it is an `END` that itself
 * directly follows a body `;`. That distinguishes the trigger's closing `END`
 * from a `CASE … END` in the body, which is never preceded by a `;`.
 *
 * Callers wanting multiple statements per migration should split them into
 * separate `Migration` entries — `batch()` runs them atomically anyway.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- a single-pass SQL lexer: its mode branching is the grammar, and split helpers would all share the cursor and mode state
const scanStatement = (text: string, label: string): StatementScan => {
    const isTrigger = CREATE_TRIGGER_RE.test(text.slice(LEADING_TRIVIA_RE.exec(text)?.[0].length ?? 0));
    const lineComments: string[] = [];
    let code = "";
    // The character that ends the string or quoted identifier being read, and the comment being read.
    let closer: string | undefined;
    let comment: "block" | "line" | undefined;
    let commentStart = 0;
    let terminatorIndex: number | undefined;
    // Trigger-body bookkeeping (inert unless `isTrigger`): the word token being
    // accumulated, whether the last token was an `END` that followed a body `;`,
    // and whether the last token was that body `;`.
    let word = "";
    let endClosesBody = false;
    let afterBodySemicolon = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text.charAt(index);
        const next = text.charAt(index + 1);

        if (comment === "line") {
            if (character === "\n") {
                lineComments.push(text.slice(commentStart, index));
                comment = undefined;
            }

            code += character === "\n" ? "\n" : " ";
            continue;
        }

        if (comment === "block") {
            code += " ";

            if (character === "*" && next === "/") {
                code += " ";
                comment = undefined;
                index += 1;
            }

            continue;
        }

        if (closer !== undefined) {
            code += " ";

            // `]` has no escape; the other quotings escape their closer by doubling it.
            if (character === closer && closer !== "]" && next === closer) {
                code += " ";
                index += 1;
            } else if (character === closer) {
                closer = undefined;
            }

            continue;
        }

        // Comment starts are allowed anywhere, including after the terminating
        // `;` (a trailing comment), so detect them before the terminator guard.
        if ((character === "-" && next === "-") || (character === "/" && next === "*")) {
            comment = character === "-" ? "line" : "block";
            commentStart = index;
            code += "  ";
            index += 1;
            continue;
        }

        // Once the statement's terminating `;` is seen, only whitespace and comments may follow: a stray second `;`,
        // an opening quote or another statement is a second statement.
        if (terminatorIndex !== undefined) {
            if (!WHITESPACE_RE.test(character)) {
                throw new LunoraError(
                    "INTERNAL",
                    `${label} contains more than one SQL statement. Split it into separate migrations — batch() runs them atomically.`,
                );
            }

            code += character;
            continue;
        }

        if (isTrigger) {
            if (WORD_CHAR_RE.test(character)) {
                word += character;
                code += character;
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

        closer = QUOTE_CLOSERS[character];

        if (closer !== undefined) {
            code += "_";
            continue;
        }

        code += character;

        if (character === ";") {
            if (isTrigger && !endClosesBody) {
                // A `;` inside the trigger body, not the statement's terminator.
                afterBodySemicolon = true;
            } else {
                terminatorIndex = index;
            }
        }
    }

    if (comment === "line") {
        lineComments.push(text.slice(commentStart));
    }

    return { code, lineComments, statementText: text.slice(0, terminatorIndex ?? text.length).trim() };
};

/**
 * Refuse transaction control, and a destructive statement without {@link ALLOW_DESTRUCTIVE_MARKER}. Both are decided
 * from {@link StatementScan.code}, so a keyword inside a literal or a comment never counts.
 */
const assertAllowedStatement = (label: string, scan: StatementScan): void => {
    if (TRANSACTION_CONTROL_RE.test(scan.code)) {
        throw new LunoraError(
            "INTERNAL",
            `${label} is transaction control (BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT/RELEASE). Each migration already runs atomically with its tracking row in one batch(); remove it.`,
        );
    }

    if (scan.lineComments.some((comment) => comment.trimEnd() === ALLOW_DESTRUCTIVE_MARKER)) {
        return;
    }

    const destructive = DESTRUCTIVE_STATEMENTS.find(([, pattern]) => pattern.test(scan.code));

    if (destructive !== undefined) {
        throw new LunoraError(
            "MIGRATION_DESTRUCTIVE",
            `${label} has not run yet and contains a destructive statement (${destructive[0]}). If it is meant to discard data or rename what readers depend on, add a \`${ALLOW_DESTRUCTIVE_MARKER}\` line comment on its own line before the statement. Only pending migrations are checked, so never add it to one that already ran: that changes its hash and is refused as drift.`,
        );
    }
};

/**
 * SHA-256 of `text`, hex-encoded. Available natively in both the Workers runtime
 * (`crypto.subtle`) and Node 22+, so no platform shim needed.
 */
const sha256Hex = async (text: string): Promise<string> => {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** A leading byte-order mark. */
const BOM_RE = /^\uFEFF/u;

/** `text` without the newlines it ends with. A loop, not `/\n+$/`, which backtracks quadratically on a long run. */
const trimTrailingNewlines = (text: string): string => {
    let end = text.length;

    while (end > 0 && text[end - 1] === "\n") {
        end -= 1;
    }

    return text.slice(0, end);
};

/**
 * The hashes a migration's SQL is recognised by.
 *
 * `normalized` is what a run records: the text with a byte-order mark removed,
 * CRLF folded to LF and trailing newlines dropped. The raw text differs across a
 * Windows and a Unix checkout of the same file, so hashing it raw made every
 * cross-OS deploy refuse an unchanged migration as drift. `raw` is still
 * accepted when reading, because an earlier build recorded that form.
 */

/**
 * The form of a migration's SQL that is hashed and compared: no byte-order mark,
 * CRLF folded to LF, no trailing newlines.
 *
 * Folded everywhere, string literals included. A checkout with `core.autocrlf`
 * rewrites the line endings inside a multi-line literal too, so folding only
 * outside literals would keep refusing exactly the cross-OS case this exists
 * for. The cost is that an edit changing nothing but a literal's line endings
 * reads as the same migration — which skips it, the safe direction: an applied
 * migration is never run twice.
 */
const normalizeMigrationText = (text: string): string => trimTrailingNewlines(text.replace(BOM_RE, "").replaceAll("\r\n", "\n"));

const hashMigration = async (text: string): Promise<{ normalized: string; raw: string }> => {
    return { normalized: await sha256Hex(normalizeMigrationText(text)), raw: await sha256Hex(text) };
};

/** Does a recorded hash identify this migration's text, in either form? */
const recognises = (recorded: string, hashes: { normalized: string; raw: string } | undefined): boolean =>
    recorded === hashes?.normalized || recorded === hashes?.raw;

/**
 * Sequentially applies pending migrations against a D1 database via the
 * drizzle-orm/d1 driver, recording each one's `version` and SHA-256 in
 * `__drizzle_migrations`.
 *
 * A migration is skipped when its VERSION is recorded, never by its text alone.
 * Deduplicating by hash re-applied any migration whose text changed after it
 * ran — a comment, a whitespace fix, a CRLF checkout — so a non-idempotent one
 * (`SET balance = balance * 100`) ran twice. A recorded version whose hash no
 * longer matches is refused as `MIGRATION_DRIFT` instead: the runner cannot
 * tell a harmless edit from a changed migration, and running either again is
 * the one outcome that is never right.
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
        await this.ensureTrackingTable();

        // Hashing is pure and order-independent, so compute every hash up front
        // in parallel; applying then proceeds strictly in version order below.
        const hashes = await Promise.all(this.migrations.map(async (migration) => hashMigration(migration.sql)));
        const recorded = await this.readTrackingRows(hashes);
        const recordedHashByVersion = new Map(recorded.filter((row) => row.version !== null).map((row) => [row.version as number, row.hash]));
        // Every refusal below is decided before the first migration is applied, so one late in the list cannot leave the
        // earlier ones applied and the run half-done.
        const unrecorded: { hash: string; migration: Migration }[] = [];

        for (const [index, migration] of this.migrations.entries()) {
            const recordedHash = recordedHashByVersion.get(migration.version);
            const hash = String(hashes[index]?.normalized);

            if (recordedHash === undefined) {
                unrecorded.push({ hash, migration });
            } else if (!recognises(recordedHash, hashes[index])) {
                throw new LunoraError(
                    "MIGRATION_DRIFT",
                    `${describeMigration(migration)} was already applied from different SQL (recorded sha256 ${recordedHash}, now ${hash}). An applied migration is never re-run: revert the edit and put the change in a new migration. If the edit is inert (a comment, whitespace, line endings), record the new text as applied: UPDATE ${TRACKING_TABLE_NAME} SET hash = '${hash}' WHERE version = ${String(migration.version)};`,
                );
            }
        }

        const unresolved = recorded.filter((row) => row.version === null);

        if (unrecorded.length > 0 && unresolved.length > 0) {
            const versions = unrecorded.map(({ migration }) => migration.version);

            throw new LunoraError(
                "MIGRATION_DRIFT",
                `${TRACKING_TABLE_NAME} holds ${String(unresolved.length)} row(s) recorded before versions were tracked whose SQL matches no current migration (id ${unresolved.map((row) => String(row.id)).join(", ")}), and ${versions.map((version) => `v${String(version)}`).join(", ")} ${versions.length === 1 ? "is" : "are"} not recorded as applied — one of them may be an edited copy of what already ran. Refusing to guess: give each row the version it recorded (UPDATE ${TRACKING_TABLE_NAME} SET version = <n> WHERE id = <id>; for a migration that no longer exists, any version no current migration uses), then run again.`,
            );
        }

        // Scanned only once drift is ruled out, since only then is it known what has not run. Only pending SQL is scanned:
        // an applied migration cannot be confirmed by editing it (that is drift), and it already ran, so refusing it
        // would block every later migration for nothing. Keyed by version, in version order.
        const pending = new Map<number, PendingMigration>(
            unrecorded.map(({ hash, migration }) => {
                const label = describeMigration(migration);
                const scan = scanStatement(migration.sql, label);

                assertAllowedStatement(label, scan);

                return [migration.version, { hash, migration, statementText: scan.statementText }];
            }),
        );
        const applied: { name: string; version: number }[] = [];
        const skipped: { name: string; version: number }[] = [];

        for (const migration of this.migrations) {
            const entry = pending.get(migration.version);
            const outcome = { name: migration.name, version: migration.version };

            if (entry === undefined) {
                skipped.push(outcome);
                continue;
            }

            // `false` means a concurrent runner won the race and inserted the
            // tracking row first (UNIQUE(hash) rejected ours, batch rolled back)
            // — the migration is applied, just not by us, so record it as skipped.
            // eslint-disable-next-line no-await-in-loop -- migrations must apply strictly in version order; each applyOne writes the tracking row the next iteration relies on.
            if (await this.applyOne(entry)) {
                applied.push(outcome);
            } else {
                skipped.push(outcome);
            }
        }

        return { applied, skipped };
    }

    /** Does the tracking table carry the `version` column yet? One catalog read. */
    private async hasVersionColumn(): Promise<boolean> {
        const rows = await this.client.drizzle.all<{ name: string }>(
            sql.raw(`SELECT name FROM pragma_table_info('${TRACKING_TABLE_NAME}') WHERE name = 'version'`),
        );

        return rows.length > 0;
    }

    /**
     * Create the tracking table, or bring one written before `version` existed
     * up to the current shape.
     *
     * Two runners can upgrade the same table at once (parallel deploys): both
     * see no column, and the second `ADD COLUMN` fails with "duplicate column
     * name". That failure is only accepted once a re-read shows the column
     * really is there — any other failure of the `ALTER` still surfaces.
     */
    private async ensureTrackingTable(): Promise<void> {
        await this.client.drizzle.run(sql.raw(TRACKING_TABLE_DDL));

        if (!(await this.hasVersionColumn())) {
            try {
                await this.client.drizzle.run(sql.raw(`ALTER TABLE ${TRACKING_TABLE_NAME} ADD COLUMN version INTEGER`));
            } catch (error) {
                if (!(await this.hasVersionColumn())) {
                    throw error;
                }
            }
        }

        await this.client.drizzle.run(sql.raw(TRACKING_VERSION_INDEX));
    }

    /**
     * Read the tracking rows, first giving every row recorded before versions
     * were tracked the version whose SQL it hashed — the only link to a version
     * such a row has. A row whose hash matches no current migration stays
     * unversioned, and {@link run} refuses to guess around it.
     */
    private async readTrackingRows(hashes: ReadonlyArray<{ normalized: string; raw: string }>): Promise<TrackingRow[]> {
        const select = sql.raw(`SELECT id, hash, version FROM ${TRACKING_TABLE_NAME} ORDER BY id`);
        const rows = await this.client.drizzle.all<TrackingRow>(select);
        // Both forms: a row an earlier build wrote recorded the raw text's hash.
        const versionByHash = new Map(
            this.migrations.flatMap((migration, index): [string, number][] => [
                [String(hashes[index]?.raw), migration.version],
                [String(hashes[index]?.normalized), migration.version],
            ]),
        );
        const taken = new Set(rows.map((row) => row.version).filter((version) => version !== null));
        let backfilled = false;

        for (const row of rows) {
            const version = row.version === null ? versionByHash.get(row.hash) : undefined;

            if (version === undefined || taken.has(version)) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- one-off upgrade of a pre-version table, on the single D1 connection
            await this.client.drizzle.run(sql`UPDATE ${sql.raw(TRACKING_TABLE_NAME)} SET version = ${version} WHERE id = ${row.id} AND version IS NULL`);
            taken.add(version);
            backfilled = true;
        }

        return backfilled ? await this.client.drizzle.all<TrackingRow>(select) : rows;
    }

    private async applyOne({ hash, migration, statementText }: PendingMigration): Promise<boolean> {
        // Apply the migration body AND write the tracking row in a single
        // atomic `client.batch(...)` so they commit (or roll back) together —
        // D1's `batch` runs as an implicit transaction. If they were two
        // separate statements, a body that committed before a failing tracking
        // INSERT would re-apply on the next run (bad for non-idempotent
        // migrations).
        //
        // drizzle's d1 batch path crashes on a `SQLiteRaw` whose
        // `params.length > 0` (it has no `.stmt` to bind against), so the
        // tracking row can't use bound `?` params here. We inline the three
        // values into the `sql.raw` literal instead — safe because none can
        // carry a quote: `hash` is a 64-char SHA-256 hex string (asserted
        // below), `created_at` is a numeric clock reading, and `version` is a
        // safe integer (asserted at construction).
        if (!SHA256_HEX_RE.test(hash)) {
            throw new LunoraError("INTERNAL", `migration "${migration.name}" produced a non-hex hash; refusing to inline into SQL`);
        }

        const trackingInsertSql = `INSERT INTO ${TRACKING_TABLE_NAME} (hash, created_at, version) VALUES ('${hash}', ${String(Date.now())}, ${String(migration.version)})`;

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
            if (!Number.isSafeInteger(m.version)) {
                throw new LunoraError("INTERNAL", `Migration "${m.name}" has version ${String(m.version)}; a version must be an integer`);
            }

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
        //
        // Compared in the normalized form the hash is taken over: two texts that
        // differ only in line endings or trailing newlines hash alike, so a
        // tracking row for one could be read as the other's and the first — not
        // necessarily idempotent — run a second time.
        const seen = new Map<string, number>();

        for (const m of this.migrations) {
            const text = normalizeMigrationText(m.sql);
            const previousVersion = seen.get(text);

            if (previousVersion !== undefined) {
                throw new LunoraError(
                    "INTERNAL",
                    `Migrations ${String(previousVersion)} and ${String(m.version)} have identical SQL — bump the content, not just the version.`,
                );
            }

            seen.set(text, m.version);
        }
    }
}

export { MigrationRunner, TRACKING_TABLE_NAME };
export type { Migration, MigrationRunnerResult };

export { ALLOW_DESTRUCTIVE_MARKER } from "../../../shared/allow-destructive-marker";
