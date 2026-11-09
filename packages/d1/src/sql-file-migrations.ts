import { LunoraError } from "@lunora/errors";
import type { SchemaLike } from "@lunora/shard-engine";
import { globalColumnBackfill } from "@lunora/sql-store";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { D1DatabaseLike } from "./d1-client";
import { D1Client } from "./d1-client";
import { firstDestructive, isTransactionControl, normalizeMigrationText, scanStatement, sha256Hex } from "./migration-runner";

/**
 * Applies the multi-statement SQL files `lunora migrate generate` writes, one file at a time, recording each in
 * `__lunora_sql_migrations` with its name and SHA-256.
 *
 * Kept apart from `MigrationRunner`, which runs one statement per migration on purpose. This path takes a whole
 * generated file, so it splits the file at each `;` and runs its statements as one atomic batch together with the
 * tracking row.
 */

const SQL_TRACKING_TABLE = "__lunora_sql_migrations";
// `written_by` says which token recorded the row. Only a root row says the stage was baselined or run by root, so a
// migrations-scoped run cannot disarm the fresh-database guard.
const SQL_TRACKING_DDL = `CREATE TABLE IF NOT EXISTS ${SQL_TRACKING_TABLE} (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL, baselined INTEGER NOT NULL DEFAULT 0, written_by TEXT NOT NULL DEFAULT 'root')`;
/** A plain file name, so it can be inlined into the tracking insert without quoting. */
const SAFE_FILE_NAME_RE = /^\w[\w.-]*\.sql$/u;
const SQL_TRACKING_NAME_UNIQUE_RE = new RegExp(String.raw`UNIQUE constraint failed:\s*${SQL_TRACKING_TABLE}\.name`, "iu");
const DUPLICATE_COLUMN_RE = /duplicate column name/iu;
const BACKTICK = "`";
/** One SQLite identifier: double-quoted, bracketed, backticked or bare. Has no capture groups of its own. */
const IDENTIFIER = String.raw`"(?:[^"]|"")+"|\[[^\]]+\]|${BACKTICK}(?:[^${BACKTICK}]|${BACKTICK}${BACKTICK})+${BACKTICK}|[_a-z]\w*`;
/** The space between two SQL tokens. A comment counts as space, so a block comment between two keywords does not hide the statement. */
const GAP = String.raw`(?:\s|--[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/)+`;
/** The same, but optional: between two tokens that may sit next to each other. */
const GAP_OPT = String.raw`(?:\s|--[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/)*`;
/** Leading comments and whitespace, so a statement's first keyword can be read past its header. */
const LEADING_TRIVIA_RE = new RegExp(String.raw`^${GAP_OPT}`, "u");
/** An optional `schema.` before a table name, as in `main.t`. Non-capturing, so the table name keeps its group. */
const SCHEMA_PREFIX = String.raw`(?:(?:${IDENTIFIER})${GAP_OPT}\.${GAP_OPT})?`;
const ADD_COLUMN_RE = new RegExp(String.raw`^ALTER${GAP}TABLE${GAP}${SCHEMA_PREFIX}(${IDENTIFIER})${GAP}ADD${GAP}(?:COLUMN${GAP})?(${IDENTIFIER})`, "iu");

/**
 * A statement that creates, drops or renames a table, or drops a column: the catalog read before it is stale after it.
 * A `CREATE TABLE IF NOT EXISTS` on a table that exists changes nothing, so it does not match.
 */
const TABLE_CHANGE_RE = new RegExp(
    String.raw`^(?:DROP${GAP}TABLE(?:${GAP}IF${GAP}EXISTS)?${GAP}${SCHEMA_PREFIX}(${IDENTIFIER})|CREATE${GAP}TABLE(?!${GAP}IF${GAP}NOT${GAP}EXISTS\b)${GAP}${SCHEMA_PREFIX}(${IDENTIFIER})|ALTER${GAP}TABLE${GAP}${SCHEMA_PREFIX}(${IDENTIFIER})${GAP}(?:RENAME|DROP)\b)`,
    "iu",
);

/**
 * Row-writing statements. Replaying one over rows written since it first ran changes data a second time. A leading
 * `WITH` counts as one: its common table expression can wrap any of these, and finding the operation after it would
 * need a parser.
 */
const ROW_WRITE_RE = /^(?:WITH|INSERT|UPDATE|DELETE|REPLACE)\b/iu;

/**
 * A table created from a query's rows: `CREATE TABLE t AS SELECT …`. It copies data in, so it is a row write, and it is
 * not additive. A `CREATE TABLE` with a column list is.
 */
const ROW_COPY_RE = new RegExp(String.raw`^CREATE${GAP}TABLE(?:${GAP}IF${GAP}NOT${GAP}EXISTS)?${GAP}${SCHEMA_PREFIX}(?:${IDENTIFIER})${GAP}AS\b`, "iu");

/**
 * Names as the scanner's `code` shows them: a quoted name or a string literal reads as `_`, and comments are blank. The
 * additive checks run on `code`, so a comment or a quoted name cannot hide a keyword or a call from them.
 */
const CODE_NAME = String.raw`[_a-z][\w$]*`;
const CODE_SCHEMA = String.raw`(?:${CODE_NAME}\s*\.\s*)?`;

/**
 * A new table with a column list. The additive statements a migrations-scoped token may run are a new table, a plain
 * index (`INDEX_HEAD_CODE_RE`), or an added column (`ADD_COLUMN_CODE_RE`). A unique index is not one: it constrains
 * the rows that may be written to its table.
 */
// eslint-disable-next-line no-secrets/no-secrets -- a SQL keyword pattern; the entropy check reads its repeated keywords as a secret
const CREATE_TABLE_CODE_RE = new RegExp(String.raw`^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+${CODE_SCHEMA}${CODE_NAME}\s*\(`, "iu");

/**
 * A plain index: `CREATE INDEX [IF NOT EXISTS] name ON table (columns)`, with nothing after the column list. The column
 * list is matched without parentheses, so a call such as `json_extract(...)` and a partial index's `WHERE` do not fit.
 */
const INDEX_HEAD_CODE_RE = new RegExp(
    String.raw`^\s*CREATE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+${CODE_SCHEMA}${CODE_NAME}\s+ON\s+${CODE_SCHEMA}${CODE_NAME}\s*\(([^()]*)\)[\s;]*$`,
    "iu",
);

/**
 * One column of a plain index: a name, optionally with `COLLATE` and a sort order. An operator (`->`, `->>`), a call or a
 * literal does not fit, so the index is not additive.
 */
const INDEX_ITEM_CODE_RE = new RegExp(String.raw`^\s*${CODE_NAME}(?:\s+COLLATE\s+${CODE_NAME})?(?:\s+(?:ASC|DESC))?\s*$`, "iu");

/** `ALTER TABLE t ADD [COLUMN] c`, read on `code`, so the column definition after it can be checked without its comments. */
const ADD_COLUMN_CODE_RE = new RegExp(String.raw`^\s*ALTER\s+TABLE\s+${CODE_SCHEMA}${CODE_NAME}\s+ADD\s+(?:COLUMN\s+)?${CODE_NAME}`, "iu");

/**
 * The column clauses that change the rows already in a table once the column is added: a DEFAULT or a generated
 * column's expression, which give every existing row a value, and a CHECK, REFERENCES or UNIQUE, which constrain the
 * writes that follow. Matched against the definition only, after the column name, so a column named `default_note` is
 * not one of these.
 */
const VALUE_CLAUSE_RE = /\b(?:DEFAULT|GENERATED|AS|CHECK|REFERENCES|UNIQUE|NOT\s+NULL|NOTNULL)\b/iu;
/** A foreign key on a new table constrains deletes from the parent table it references, so it is not additive. */
const REFERENCES_RE = /\bREFERENCES\b/iu;

/**
 * The tables a migration may not touch from an additive statement: the tracking tables (this file's, the data
 * migrations', and the migration runner's), Cloudflare's, SQLite's own, and the change log and companion tables the
 * framework keeps (`__cdc_*`, `<table>__agg_*`, `<table>__rank_*`, `<table>__fts_*`).
 */
const INTERNAL_TABLE_RE = /__lunora_|__drizzle_|__cdc_|__agg_|__rank_|__fts_|sqlite_|_cf_/iu;

/**
 * The `temp` schema qualifier. An object created there lives only for one connection, so a file that records it as applied
 * persists nothing. Matched on the raw text, since `code` blanks a quoted qualifier (`"temp".t`), and comments may sit
 * between the qualifier and the dot, as SQLite reads them.
 */
const TEMP_SCHEMA_RE = new RegExp(String.raw`\btemp["\]${BACKTICK}]?${GAP_OPT}\.`, "iu");

/**
 * Foreign-key enforcement is a connection setting, not data a file changes, so a file may not assign it. Reading it
 * (`PRAGMA foreign_keys;`) changes nothing, so only an assignment, `= value` or `(value)`, matches.
 */
const FOREIGN_KEYS_PRAGMA_RE = new RegExp(String.raw`^PRAGMA${GAP}${SCHEMA_PREFIX}(?:foreign_keys|"foreign_keys")${GAP_OPT}(?:=|\()`, "iu");

/** One SQL file: its name under `lunora/migrations/` and its text. */
interface SqlMigrationFile {
    name: string;
    sql: string;
}

/**
 * Where a file stands. `applied`: recorded with the same SQL, so skipped. `pending`: not recorded yet, so it runs.
 * `changed`: recorded with different SQL, or its SQL is recorded under another name, which is refused rather than run
 * again. `ran`: applied by this call. `baselined`: recorded by a baseline call, which records files without executing them.
 */
type SqlMigrationState = "applied" | "baselined" | "changed" | "pending" | "ran";

interface SqlMigrationEntry {
    /** Destructive statements (drops, renames, truncates, replaces), in file order. */
    destructive: string[];
    name: string;
    /** Statements a migrations-scoped token may not run: anything but a new table, a non-unique index or an added column. */
    rootOnly: string[];
    /** Statements left out because the column they add is already there, provisioned by the runtime on first use. */
    skipped: string[];
    state: SqlMigrationState;
    /** Statements this file would run, or ran, in file order. Empty for an applied or changed file. */
    statements: string[];
}

interface SqlMigrationResult {
    files: SqlMigrationEntry[];
    /** A dry run only: the pending files a real run with the same options would refuse. Nothing is refused by a dry run. */
    refused?: string[];
}

interface ApplySqlMigrationOptions {
    /**
     * Run only additive statements (a new table or index, an added column). A file with any other statement is refused
     * before anything runs. Set for a caller that holds a migrations scope rather than the root token.
     */
    additiveOnly?: boolean;

    /**
     * Record every pending file as applied without running it. For a database whose files were applied by hand or
     * predate this tracking. Drift is still refused; nothing is executed.
     */
    baseline?: boolean;

    /**
     * Like `baseline`, but only for the pending files up to and including the named one, in the order given. The
     * files after it stay pending, so a later run can apply them, including destructive ones, on a database that now
     * has a recorded file. Use it to record what already ran on a stage before a DROP that has not.
     */
    baselineThrough?: string;
    /** Run files that hold destructive statements. Without it such a file is refused and nothing runs. */
    confirmDestructive?: boolean;
    /** Report each file's state and statements without running or recording anything. Never refuses. */
    dryRun?: boolean;

    /**
     * The app's schema. A column a file adds to a `.global()` table is filled with the value its declaration gives, in the
     * same batch, as the runtime does when it adds the column itself. Without it, the rows that predate the column read NULL.
     */
    schema?: SchemaLike;
}

/** A file with its decided entry, the hash its tracking row records, and whether a fresh database must refuse it. */
interface PlannedFile {
    entry: SqlMigrationEntry;
    file: SqlMigrationFile;
    hash: string;
    /** Set when the file's SQL is recorded under this other name, which is no longer among the files sent. */
    renamedFrom?: string;
    /** Set when a root run replaces the row a migrations-scoped run recorded under this name: the hash that row holds. */
    replaces?: string;
    /** Set when the file is pending and runs a row write or a destructive statement. */
    replayUnsafe: boolean;
}

/** Which token a tracking row was written by. */
type WrittenBy = "migrations" | "root";

/** One tracking row, as the planner reads it. */
interface RecordedRow {
    sha256: string;
    writtenBy: WrittenBy;
}

/** Name and quoting of an identifier, with its quotes removed. */
const unquoteIdentifier = (identifier: string): string => {
    if (identifier.startsWith("[")) {
        return identifier.slice(1, -1);
    }

    if (identifier.startsWith('"') || identifier.startsWith("`")) {
        const quote = identifier.charAt(0);

        return identifier.slice(1, -1).replaceAll(quote + quote, quote);
    }

    return identifier;
};

/**
 * SQLite folds identifiers case-insensitively for ASCII only, so the comparison folds the same way. A plain
 * `toLowerCase` would also fold non-ASCII letters that SQLite keeps distinct.
 */
const foldIdentifier = (identifier: string): string => identifier.replaceAll(/[A-Z]+/gu, (run) => run.toLowerCase());

/** The statement without its leading comments, so its first keyword can be matched. */
const bodyOf = (statementText: string): string => statementText.slice(LEADING_TRIVIA_RE.exec(statementText)?.[0].length ?? 0);

/**
 * A statement on one line, so a refusal that names it shows all of it. Line comments go first: joined onto one line, a
 * `--` would swallow the code after it. A `--` inside a string literal is dropped from the message too, which is fine
 * for a message.
 */
const oneLine = (statement: string): string =>
    statement
        .replaceAll(/--[^\n]*/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim();

/** Whether a statement switches foreign-key enforcement, under any schema qualifier. Shared by the run and the dry-run report. */
const changesForeignKeys = (statementText: string): boolean => FOREIGN_KEYS_PRAGMA_RE.test(bodyOf(statementText));

/** The table and column an `ALTER TABLE … ADD [COLUMN]` statement adds, or `undefined` for any other statement. */
const addedColumn = (statementText: string): { column: string; table: string } | undefined => {
    const match = ADD_COLUMN_RE.exec(bodyOf(statementText));

    if (match === null) {
        return undefined;
    }

    return { column: unquoteIdentifier(match[2] ?? ""), table: unquoteIdentifier(match[1] ?? "") };
};

/** The table a statement creates, drops or renames, or `undefined` when it leaves the catalog's tables alone. */
const changedTable = (statementText: string): string | undefined => {
    const match = TABLE_CHANGE_RE.exec(bodyOf(statementText));
    const identifier = match?.[1] ?? match?.[2] ?? match?.[3];

    return identifier === undefined ? undefined : unquoteIdentifier(identifier);
};

/**
 * `PRAGMA table_info` in its statement form, with the table name quoted in. D1's authorizer refuses
 * `SELECT … FROM pragma_table_info(?)` through the Worker binding, and a pragma argument cannot be bound.
 */
const columnExists = async (client: D1Client, table: string, column: string): Promise<boolean> => {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const rows = await client.drizzle.all<{ name: string }>(sql.raw(`PRAGMA table_info(${quoted})`));
    const wanted = foldIdentifier(column);

    return rows.some((row) => foldIdentifier(row.name) === wanted);
};

/**
 * Whether a statement is additive: a new table, a plain index, or a column added to a table without a clause that changes
 * the rows already there (see `VALUE_CLAUSE_RE`). The shape is read from the scanner's `code`, so comments and quoted
 * names do not change it. A statement that names an internal table or the temp schema, a foreign key, a partial index,
 * or an index over an expression is not additive, since each constrains writes beyond the new object. Anything else
 * needs the root token. A value clause on a new table is fine, since the table has no rows.
 */
const isAdditiveStatement = (scan: ReturnType<typeof scanStatement>): boolean => {
    if (INTERNAL_TABLE_RE.test(scan.statementText) || TEMP_SCHEMA_RE.test(scan.statementText)) {
        return false;
    }

    const addColumn = ADD_COLUMN_CODE_RE.exec(scan.code);

    if (addColumn !== null) {
        return !VALUE_CLAUSE_RE.test(scan.code.slice(addColumn[0].length));
    }

    if (REFERENCES_RE.test(scan.code)) {
        return false;
    }

    const index = INDEX_HEAD_CODE_RE.exec(scan.code);

    if (index !== null) {
        return (index[1] ?? "").split(",").every((item) => INDEX_ITEM_CODE_RE.test(item));
    }

    return CREATE_TABLE_CODE_RE.test(scan.code);
};

/** Records the table a statement creates, drops or renames, so a later ADD COLUMN on it is not skipped from a stale catalog. */
const rememberChangedTable = (statementText: string, changed: Set<string>): void => {
    const table = changedTable(statementText);

    if (table !== undefined) {
        changed.add(foldIdentifier(table));
    }
};

/** Whether a statement writes rows: a row write, or a table created from a query's rows. */
const writesRows = (statementText: string): boolean => {
    const body = bodyOf(statementText);

    return ROW_WRITE_RE.test(body) || ROW_COPY_RE.test(body);
};

/** Whether running a statement again would change data written since it first ran: a destructive one, or a row write. */
const replaysData = (statementText: string, isDestructive: boolean): boolean => isDestructive || writesRows(statementText);

/** Whether a statement adds a column the table already has, so the file can leave it out. A table an earlier statement changed is read as stale. */
const isAlreadyPresent = async (client: D1Client, statementText: string, changed: ReadonlySet<string>): Promise<boolean> => {
    const added = addedColumn(statementText);

    return added !== undefined && !changed.has(foldIdentifier(added.table)) && (await columnExists(client, added.table, added.column));
};

/**
 * Refuse a statement a file that will run may not contain: transaction control (each file is already one batch) and a
 * change to foreign-key enforcement. Checked only where the file would run, so a baseline or a dry run still reports it.
 */
const assertRunnable = (file: SqlMigrationFile, scan: ReturnType<typeof scanStatement>): void => {
    if (isTransactionControl(scan)) {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `${file.name} is transaction control (BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT/RELEASE). Each file already runs atomically with its tracking row in one batch(); remove it.`,
        );
    }

    if (changesForeignKeys(scan.statementText)) {
        throw new LunoraError("VALIDATION_ERROR", `${file.name} changes foreign-key enforcement (PRAGMA foreign_keys). A migration file may not; remove it.`);
    }
};

/**
 * The `UPDATE` that fills the rows a column this statement adds predates, when the schema gives that column a value. It
 * runs in the same batch straight after the `ALTER`, so a column the runtime would have backfilled is never left NULL.
 */
const fillForAddedColumn = (statementText: string, schema: SchemaLike | undefined): SQL | undefined => {
    const added = addedColumn(statementText);

    return added === undefined || schema === undefined ? undefined : globalColumnBackfill(schema, added.table, added.column);
};

/** Split one pending file into the statements to run, the ones left out, and the destructive and root-only ones. */
const planPendingFile = async (
    client: D1Client,
    file: SqlMigrationFile,
    refuseTransactionControl: boolean,
    schema?: SchemaLike,
): Promise<{ destructive: string[]; replayUnsafe: boolean; rootOnly: string[]; runs: (SQL | string)[]; skipped: string[]; statements: string[] }> => {
    const destructive: string[] = [];
    const rootOnly: string[] = [];
    const runs: (SQL | string)[] = [];
    const skipped: string[] = [];
    // Tables an earlier statement of this file has created, dropped or renamed: the catalog read is stale for them.
    const changed = new Set<string>();
    let replayUnsafe = false;
    let start = 0;

    while (start < file.sql.length) {
        const scan = scanStatement(file.sql, file.name, start, true);

        start = scan.end;

        // Whitespace, comments and the stray `;` of an empty statement carry nothing to run.
        if (scan.code.replaceAll(/[\s;]/gu, "") === "") {
            continue;
        }

        if (refuseTransactionControl) {
            assertRunnable(file, scan);
        }

        const { statementText } = scan;
        const isDestructive = firstDestructive(scan) !== undefined;

        if (isDestructive) {
            destructive.push(statementText);
        }

        if (!isAdditiveStatement(scan)) {
            rootOnly.push(statementText);
        }

        // `ADD COLUMN` has no `IF NOT EXISTS`, and the worker adds a `.global()` column itself the first time it
        // touches the table. Running the statement anyway would fail on the duplicate and roll the whole file back.
        // eslint-disable-next-line no-await-in-loop -- statements are checked in file order, one catalog read each
        if (await isAlreadyPresent(client, statementText, changed)) {
            skipped.push(statementText);
            continue;
        }

        runs.push(statementText);

        const fill = fillForAddedColumn(statementText, schema);

        if (fill !== undefined) {
            runs.push(fill);
        }

        if (replaysData(statementText, isDestructive)) {
            replayUnsafe = true;
        }

        rememberChangedTable(statementText, changed);
    }

    // What runs is what the file would run, so a skipped ADD COLUMN is reported only under `skipped`. A backfill is the
    // schema's write, not one of the file's statements, so it is left out of the report.
    return { destructive, replayUnsafe, rootOnly, runs, skipped, statements: runs.filter((run): run is string => typeof run === "string") };
};

const assertFileNames = (files: ReadonlyArray<SqlMigrationFile>): void => {
    const seen = new Set<string>();

    for (const file of files) {
        if (!SAFE_FILE_NAME_RE.test(file.name)) {
            throw new LunoraError("VALIDATION_ERROR", `migration file name "${file.name}" must be a plain *.sql file name`);
        }

        if (seen.has(file.name)) {
            throw new LunoraError("VALIDATION_ERROR", `migration file "${file.name}" was sent more than once`);
        }

        seen.add(file.name);
    }
};

/**
 * What is recorded on the database. A dry run creates nothing, so a database without the tracking table reads as
 * empty instead of being written to. `fresh` means no file has ever been recorded here.
 */
const readRecorded = async (client: D1Client, dryRun: boolean): Promise<{ fresh: boolean; recorded: Map<string, RecordedRow> }> => {
    if (dryRun) {
        const tables = await client.drizzle.all<{ name: string }>(
            sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${SQL_TRACKING_TABLE}'`),
        );

        if (tables.length === 0) {
            return { fresh: true, recorded: new Map() };
        }
    } else {
        await client.drizzle.run(sql.raw(SQL_TRACKING_DDL));
    }

    const rows = await client.drizzle.all<{ name: string; sha256: string; written_by: WrittenBy }>(
        sql.raw(`SELECT name, sha256, written_by FROM ${SQL_TRACKING_TABLE}`),
    );

    return {
        fresh: !rows.some((row) => row.written_by === "root"),
        recorded: new Map(rows.map((row) => [row.name, { sha256: row.sha256, writtenBy: row.written_by }])),
    };
};

/** The entry for a file the record answers for without parsing it: applied, changed, or changed by a rename. */
const answeredByRecord = (file: SqlMigrationFile, hash: string, state: SqlMigrationState, renamedFrom?: string): PlannedFile => {
    return {
        entry: { destructive: [], name: file.name, rootOnly: [], skipped: [], state, statements: [] },
        file,
        hash,
        ...(renamedFrom === undefined ? {} : { renamedFrom }),
        replayUnsafe: false,
    };
};

/**
 * The recorded hashes whose name is no longer sent, so a file with one of those hashes was renamed. A migrations-scoped
 * row can hold SQL under any name, so it is never evidence of a rename.
 */
const renamedSources = (recorded: ReadonlyMap<string, RecordedRow>, sent: ReadonlySet<string>): Map<string, string> => {
    const vanished = new Map<string, string>();

    for (const [name, row] of recorded) {
        if (!sent.has(name) && row.writtenBy === "root") {
            vanished.set(row.sha256, name);
        }
    }

    return vanished;
};

/**
 * The hash of the row a root run replaces with this file: a row a migrations-scoped run recorded under the same name with
 * other SQL. So a scoped run cannot block a root file. A scoped run never replaces a row, so a mismatch it meets stays drift.
 */
const replacedHash = (previous: RecordedRow | undefined, hash: string, replaceScoped: boolean): string | undefined =>
    previous?.writtenBy === "migrations" && replaceScoped && previous.sha256 !== hash ? previous.sha256 : undefined;

/**
 * Decide each file's state against what is recorded. Pending files are parsed, which can refuse one outright. A pending
 * file whose SQL is recorded under a name no longer sent was renamed, and running it would replay the applied SQL.
 */
const planFiles = async (
    client: D1Client,
    files: ReadonlyArray<SqlMigrationFile>,
    recorded: ReadonlyMap<string, RecordedRow>,
    refuseTransactionControl: boolean,
    replaceScoped: boolean,
): Promise<PlannedFile[]> => {
    const hashed = await Promise.all(
        files.map(async (file) => {
            return { file, hash: await sha256Hex(normalizeMigrationText(file.sql)) };
        }),
    );
    const vanished = renamedSources(recorded, new Set(files.map((file) => file.name)));
    const planned: PlannedFile[] = [];

    for (const { file, hash } of hashed) {
        const previous = recorded.get(file.name);
        const replaces = replacedHash(previous, hash, replaceScoped);

        if (previous !== undefined && replaces === undefined) {
            planned.push(answeredByRecord(file, hash, previous.sha256 === hash ? "applied" : "changed"));
            continue;
        }

        const renamedFrom = replaces === undefined ? vanished.get(hash) : undefined;

        if (renamedFrom !== undefined) {
            planned.push(answeredByRecord(file, hash, "changed", renamedFrom));
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- files are planned in the order they run
        const plan = await planPendingFile(client, file, refuseTransactionControl);

        planned.push({
            entry: {
                destructive: plan.destructive,
                name: file.name,
                rootOnly: plan.rootOnly,
                skipped: plan.skipped,
                state: "pending",
                statements: plan.statements,
            },
            file,
            hash,
            ...(replaces === undefined ? {} : { replaces }),
            replayUnsafe: plan.replayUnsafe,
        });
    }

    return planned;
};

/** Pending files whose SQL matches an earlier pending file in the same run, as `[earlier, later]` pairs. */
const duplicatePending = (planned: ReadonlyArray<PlannedFile>): [PlannedFile, PlannedFile][] => {
    const firstByHash = new Map<string, PlannedFile>();
    const pairs: [PlannedFile, PlannedFile][] = [];

    for (const item of planned.filter((candidate) => candidate.entry.state === "pending")) {
        const first = firstByHash.get(item.hash);

        if (first === undefined) {
            firstByHash.set(item.hash, item);
        } else {
            pairs.push([first, item]);
        }
    }

    return pairs;
};

/** Refuse a run whose pending files repeat one another's SQL: each copy would run, so a row write would apply twice. */
const assertNoDuplicatePending = (planned: ReadonlyArray<PlannedFile>): void => {
    const pairs = duplicatePending(planned);

    if (pairs.length === 0) {
        return;
    }

    const listed = pairs.map(([first, later]) => `${later.entry.name} repeats ${first.entry.name}`).join("; ");

    throw new LunoraError("VALIDATION_ERROR", `${listed}. Identical SQL would run once per name. Delete the extra file, or change its SQL.`);
};

/** Refuse the run before anything is applied, when an applied file's SQL has changed or moved to another name. */
const assertNoDrift = (planned: ReadonlyArray<PlannedFile>): void => {
    const changed = planned.filter((item) => item.entry.state === "changed");

    if (changed.length === 0) {
        return;
    }

    const renamed = changed.filter((item) => item.renamedFrom !== undefined);
    const edited = changed.filter((item) => item.renamedFrom === undefined);
    const parts: string[] = [];

    if (edited.length > 0) {
        const names = edited.map((item) => item.entry.name).join(", ");

        parts.push(`${names} ${edited.length === 1 ? "was" : "were"} already applied from different SQL. Revert the edit and put the change in a new file.`);
    }

    if (renamed.length > 0) {
        const names = renamed.map((item) => `${item.entry.name} (applied as ${String(item.renamedFrom)})`).join(", ");

        parts.push(`${names} ${renamed.length === 1 ? "was" : "were"} renamed. Rename it back: an applied file is never run again under a new name.`);
    }

    throw new LunoraError("MIGRATION_DRIFT", `${parts.join(" ")} An applied file is never run again.`);
};

/** The statements of a pending file that would change data again: its destructive ones, and its row writes. */
const replayingStatements = (entry: SqlMigrationEntry): string[] =>
    entry.statements.filter((statement) => entry.destructive.includes(statement) || writesRows(statement));

/** A statement that opens or closes a transaction. A file may not contain one, and a dry run should say so. */
const TRANSACTION_RE = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;

/**
 * The pending files a real run with these options would refuse for a reason no flag can lift: the fresh-database guard,
 * the additive-only rule, transaction control, and a foreign-key pragma. A baseline is root-only, so for a scoped
 * caller it refuses every pending file. An unconfirmed destructive file is left out on purpose. `--yes` is the
 * operator's choice at run time, and a preflight run without it should not fail on a DROP that is meant to be applied.
 */
const refusedOnApply = (planned: ReadonlyArray<PlannedFile>, options: ApplySqlMigrationOptions, fresh: boolean): string[] => {
    const pending = planned.filter((item) => item.entry.state === "pending");
    const recordOnly = options.baseline === true || options.baselineThrough !== undefined;

    if (recordOnly) {
        return options.additiveOnly === true ? pending.map((item) => item.entry.name) : [];
    }

    const refusedByRun = (item: PlannedFile): boolean =>
        (fresh && item.replayUnsafe) ||
        (options.additiveOnly === true && item.entry.rootOnly.length > 0) ||
        item.entry.statements.some((statement) => TRANSACTION_RE.test(bodyOf(statement)) || changesForeignKeys(statement));

    const refusedNames = pending.filter((item) => refusedByRun(item)).map((item) => item.entry.name);
    const duplicateNames = duplicatePending(planned)
        .flat()
        .map((item) => item.entry.name);

    return [...new Set([...refusedNames, ...duplicateNames])];
};

/**
 * Refuse a pending file that would change data again. On a database with no recorded file, a file that drops, replaces
 * or writes rows is refused whatever `confirmDestructive` says: it may already have run by hand, or predate this
 * tracking, and running it again changes rows written since. Recording the files that already ran, with
 * `baselineThrough`, is the way out. Otherwise a destructive file needs `confirmDestructive`.
 */
const assertDestructiveConfirmed = (planned: ReadonlyArray<PlannedFile>, confirmDestructive: boolean, fresh: boolean): void => {
    const pending = planned.filter((item) => item.entry.state === "pending");

    if (fresh) {
        const unsafe = pending.filter((item) => item.replayUnsafe);

        if (unsafe.length > 0) {
            const listed = unsafe.flatMap((item) => replayingStatements(item.entry).map((statement) => `${item.entry.name}: ${oneLine(statement)}`));

            throw new LunoraError(
                "MIGRATION_DESTRUCTIVE",
                `no SQL migration file is recorded on this database, so these statements are refused. They drop, replace or write rows, and may already have run by hand or predate this tracking:\n  ${listed.join("\n  ")}\nRecord the files that already ran with \`migrate apply --baseline-through <last file that ran>\`, then run the new ones.`,
            );
        }

        return;
    }

    const destructive = pending.filter((item) => item.entry.destructive.length > 0);

    if (destructive.length === 0 || confirmDestructive) {
        return;
    }

    const listed = destructive.flatMap((item) => item.entry.destructive.map((statement) => `${item.entry.name}: ${oneLine(statement)}`));

    throw new LunoraError(
        "MIGRATION_DESTRUCTIVE",
        `these files drop, rename, truncate or replace data and have not run yet. Re-run with --yes to apply them:\n  ${listed.join("\n  ")}`,
    );
};

/**
 * Refuse a pending file that holds a statement an additive-only caller may not run, before anything runs. Only the
 * root token runs the rest, so a migrations-scoped token cannot reach auth rows through a DROP, a row write or a trigger.
 */
const assertAdditiveOnly = (planned: ReadonlyArray<PlannedFile>, additiveOnly: boolean): void => {
    if (!additiveOnly) {
        return;
    }

    const needsRoot = planned.filter((item) => item.entry.state === "pending" && item.entry.rootOnly.length > 0);

    if (needsRoot.length === 0) {
        return;
    }

    const listed = needsRoot.flatMap((item) => item.entry.rootOnly.map((statement) => `${item.entry.name}: ${oneLine(statement)}`));

    throw new LunoraError(
        "MIGRATION_ROOT_REQUIRED",
        `these files run statements that a migrations-scoped token may not run (only CREATE TABLE, a CREATE INDEX that is not UNIQUE, and ADD COLUMN). Run them with the root admin token:\n  ${listed.join("\n  ")}`,
    );
};

/** The tracking row for one file, read after an insert lost the race to a concurrent runner. */
const recordedRow = async (client: D1Client, name: string): Promise<{ baselined: number; sha256: string } | undefined> => {
    const rows = await client.drizzle.all<{ baselined: number; sha256: string }>(
        sql.raw(`SELECT sha256, baselined FROM ${SQL_TRACKING_TABLE} WHERE name = '${name}'`),
    );

    return rows[0];
};

/**
 * Run one file's statements and its tracking row in one batch, so the file either runs whole or not at all. The row
 * goes first: a concurrent runner that recorded the file already fails the batch before any DDL runs. With no
 * statements it only records the file. `write.origin` says whether this call ran the SQL (`applied`) or only records the file
 * (`baselined`). Returns `applied` when a concurrent runner recorded the same SQL first. That holds only for an
 * executed row: a concurrent baseline recorded the file without running it, so an apply that planned to run it fails.
 */
const commitFile = async (
    client: D1Client,
    file: SqlMigrationFile,
    hash: string,
    runs: ReadonlyArray<SQL | string>,
    write: { origin: "applied" | "baselined"; replaces?: string; writtenBy: WrittenBy },
): Promise<SqlMigrationState> => {
    const baselined = write.origin === "baselined" ? 1 : 0;
    const record = client.drizzle.run(
        sql.raw(
            `INSERT INTO ${SQL_TRACKING_TABLE} (name, sha256, applied_at, baselined, written_by) VALUES ('${file.name}', '${hash}', ${String(Date.now())}, ${String(baselined)}, '${write.writtenBy}')`,
        ),
    );
    // The DELETE matches the row the plan saw, so a row a concurrent run changed meanwhile survives and the INSERT fails as drift.
    const leading: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] =
        write.replaces === undefined
            ? [record]
            : [
                  client.drizzle.run(
                      sql.raw(`DELETE FROM ${SQL_TRACKING_TABLE} WHERE name = '${file.name}' AND sha256 = '${write.replaces}' AND written_by = 'migrations'`),
                  ),
                  record,
              ];
    const items: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
        ...leading,
        ...runs.map((statement) => client.drizzle.run(typeof statement === "string" ? sql.raw(statement) : statement)),
    ];

    try {
        await client.batch(items);

        return "ran";
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        if (!SQL_TRACKING_NAME_UNIQUE_RE.test(message)) {
            throw new LunoraError("VALIDATION_ERROR", `${file.name} failed and was rolled back, so none of its statements took effect: ${message}`, {
                cause: error,
            });
        }

        // The batch rolled back, so nothing ran twice. A different hash means a concurrent run applied other SQL under
        // this name, which is drift: this run must not report the file as applied.
        const recorded = await recordedRow(client, file.name);

        if (recorded?.sha256 === hash) {
            if (write.origin === "applied" && recorded.baselined === 1) {
                throw new LunoraError(
                    "CONFLICT",
                    `${file.name} was recorded as a baseline by a concurrent run, which records a file without running it. Its SQL did not run here, so this apply stopped; run it again to see the file's state.`,
                    { cause: error },
                );
            }

            return "applied";
        }

        throw new LunoraError(
            "MIGRATION_DRIFT",
            `${file.name} was recorded by a concurrent run from different SQL. An applied file is never run again: revert the edit and put the change in a new file.`,
            { cause: error },
        );
    }
};

/** What a run that executes files needs beyond the files: the schema that fills new columns, and the token that writes rows. */
interface CommitOptions {
    schema: SchemaLike | undefined;
    writtenBy: WrittenBy;
}

/** Plan a pending file against the catalog as it is now, then commit it. */
const commitPlanned = async (
    client: D1Client,
    item: PlannedFile,
    commit: CommitOptions,
): Promise<Pick<SqlMigrationEntry, "skipped" | "state" | "statements">> => {
    const plan = await planPendingFile(client, item.file, true, commit.schema);
    const write = { origin: "applied" as const, writtenBy: commit.writtenBy, ...(item.replaces === undefined ? {} : { replaces: item.replaces }) };

    return { skipped: plan.skipped, state: await commitFile(client, item.file, item.hash, plan.runs, write), statements: plan.statements };
};

/**
 * Plan a pending file against the catalog as it is now, then run it. Re-planning here, rather than reusing the
 * up-front plan, means an `ADD COLUMN` skip reflects the DROPs and ADDs that earlier files in this run made.
 *
 * When the runtime adds the column between that read and the batch, the batch fails on the duplicate and rolls back.
 * Re-planning once then skips the column, since it is now present.
 */
const runPending = async (client: D1Client, item: PlannedFile, commit: CommitOptions): Promise<Pick<SqlMigrationEntry, "skipped" | "state" | "statements">> => {
    try {
        return await commitPlanned(client, item, commit);
    } catch (error: unknown) {
        if (!(error instanceof Error) || !DUPLICATE_COLUMN_RE.test(error.message)) {
            throw error;
        }

        return commitPlanned(client, item, commit);
    }
};

/** The index of the last file a baseline records: the one `baselineThrough` names, or the last file sent. */
const baselineBound = (files: ReadonlyArray<SqlMigrationFile>, options: ApplySqlMigrationOptions): number => {
    if (options.baseline === true && options.baselineThrough !== undefined) {
        throw new LunoraError("VALIDATION_ERROR", "pass either baseline or baselineThrough, not both");
    }

    if (options.baselineThrough === undefined) {
        return files.length - 1;
    }

    const index = files.findIndex((file) => file.name === options.baselineThrough);

    if (index === -1) {
        throw new LunoraError("VALIDATION_ERROR", `baselineThrough names "${options.baselineThrough}", which is not among the files sent`);
    }

    return index;
};

/** Record the pending files up to `through` as applied, each in its own batch, without running them. */
const recordPending = async (client: D1Client, planned: ReadonlyArray<PlannedFile>, through: number): Promise<void> => {
    for (const [index, item] of planned.entries()) {
        if (item.entry.state === "pending" && index <= through) {
            const write = { origin: "baselined" as const, writtenBy: "root" as const, ...(item.replaces === undefined ? {} : { replaces: item.replaces }) };

            // eslint-disable-next-line no-await-in-loop -- each record must commit before the next file is checked against the table
            item.entry.state = (await commitFile(client, item.file, item.hash, [], write)) === "ran" ? "baselined" : "applied";
        }
    }
};

/**
 * Apply the pending SQL files, in the order given, against one D1 database.
 *
 * Every refusal is decided before the first file runs, so a drifted or unconfirmed file late in the list cannot leave
 * the earlier ones applied. Each file's statements and its tracking row commit in one `batch()`. A second call finds
 * every file recorded and runs nothing.
 *
 * Throws `MIGRATION_DRIFT` when an applied file's SQL changed or was renamed; `MIGRATION_DESTRUCTIVE` when a pending
 * file cannot run (see {@link assertDestructiveConfirmed}); `MIGRATION_ROOT_REQUIRED` when an additive-only caller sends a
 * file with any other statement; `VALIDATION_ERROR` for transaction control in a file that
 * is applied, a `baselineThrough` that names no file, or a batch that failed and rolled back.
 */
const applySqlMigrationFiles = async (
    database: D1DatabaseLike,
    files: ReadonlyArray<SqlMigrationFile>,
    options: ApplySqlMigrationOptions = {},
): Promise<SqlMigrationResult> => {
    assertFileNames(files);

    const recordOnly = options.baseline === true || options.baselineThrough !== undefined;
    const through = baselineBound(files, options);
    const client = new D1Client(database);
    const dryRun = options.dryRun === true;
    const { fresh, recorded } = await readRecorded(client, dryRun);
    // Transaction control is refused only where the file would run; a baseline or a dry run never executes it.
    const writtenBy: WrittenBy = options.additiveOnly === true ? "migrations" : "root";
    const commit: CommitOptions = { schema: options.schema, writtenBy };
    const planned = await planFiles(client, files, recorded, !dryRun && !recordOnly, writtenBy === "root");

    if (dryRun) {
        return { files: planned.map((item) => item.entry), refused: refusedOnApply(planned, options, fresh) };
    }

    assertNoDrift(planned);

    // A baseline records a file as applied without running it. A caller that cannot run a root-only file cannot record
    // one either, or a later root run would skip a file that never ran.
    if (recordOnly && options.additiveOnly === true) {
        throw new LunoraError("MIGRATION_ROOT_REQUIRED", "a baseline records files as applied without running them, so only the root admin token may run one");
    }

    if (recordOnly) {
        await recordPending(client, planned, through);

        return { files: planned.map((item) => item.entry) };
    }

    assertNoDuplicatePending(planned);
    assertAdditiveOnly(planned, options.additiveOnly === true);
    assertDestructiveConfirmed(planned, options.confirmDestructive === true, fresh);

    for (const item of planned) {
        if (item.entry.state === "pending") {
            // eslint-disable-next-line no-await-in-loop -- each file's tracking row must commit before the next file is planned against it
            const outcome = await runPending(client, item, commit);

            // The re-plan at commit time is the one that ran, so its statements are what the entry reports.
            item.entry.skipped = outcome.skipped;
            item.entry.statements = outcome.statements;
            item.entry.state = outcome.state;
        }
    }

    return { files: planned.map((item) => item.entry) };
};

export type { ApplySqlMigrationOptions, SqlMigrationEntry, SqlMigrationFile, SqlMigrationResult, SqlMigrationState };
export { applySqlMigrationFiles };
