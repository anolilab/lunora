import { LunoraError } from "@lunora/errors";
import { sql } from "drizzle-orm";

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
const SQL_TRACKING_DDL = `CREATE TABLE IF NOT EXISTS ${SQL_TRACKING_TABLE} (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)`;
/** A plain file name, so it can be inlined into the tracking insert without quoting. */
const SAFE_FILE_NAME_RE = /^\w[\w.-]*\.sql$/u;
const SQL_TRACKING_NAME_UNIQUE_RE = new RegExp(String.raw`UNIQUE constraint failed:\s*${SQL_TRACKING_TABLE}\.name`, "iu");
/** Leading comments and whitespace, so a statement's first keyword can be read past its header. */
const LEADING_TRIVIA_RE = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u;
const BACKTICK = "`";
/** One SQLite identifier: double-quoted, bracketed, backticked or bare. */
const IDENTIFIER = String.raw`"(?:[^"]|"")+"|\[[^\]]+\]|${BACKTICK}(?:[^${BACKTICK}]|${BACKTICK}${BACKTICK})+${BACKTICK}|[_a-z]\w*`;
const ADD_COLUMN_RE = new RegExp(String.raw`^ALTER\s+TABLE\s+(${IDENTIFIER})\s+ADD\s+(?:COLUMN\s+)?(${IDENTIFIER})`, "iu");

/** One SQL file: its name under `lunora/migrations/` and its text. */
interface SqlMigrationFile {
    name: string;
    sql: string;
}

/**
 * Where a file stands. `applied`: recorded with the same SQL, so skipped. `pending`: not recorded yet, so it runs.
 * `changed`: recorded with different SQL, which is refused rather than run again. `ran`: applied by this call.
 * `baselined`: recorded by a baseline call, which records files without executing them.
 */
type SqlMigrationState = "applied" | "baselined" | "changed" | "pending" | "ran";

interface SqlMigrationEntry {
    /** Destructive statements (drops, renames, truncates, replaces), in file order. */
    destructive: string[];
    name: string;
    /** Statements left out because the column they add is already there, provisioned by the runtime on first use. */
    skipped: string[];
    state: SqlMigrationState;
    /** Statements this file would run, or ran, in file order. Empty for an applied or changed file. */
    statements: string[];
}

interface SqlMigrationResult {
    files: SqlMigrationEntry[];
}

interface ApplySqlMigrationOptions {
    /**
     * Record every pending file as applied without running it. For a database whose files were applied by hand or
     * predate this tracking. Drift is still refused; nothing is executed.
     */
    baseline?: boolean;
    /** Run files that hold destructive statements. Without it such a file is refused and nothing runs. */
    confirmDestructive?: boolean;
    /** Report each file's state and statements without running or recording anything. Never refuses. */
    dryRun?: boolean;
}

/** A file with its decided entry and the hash its tracking row records. */
interface PlannedFile {
    entry: SqlMigrationEntry;
    file: SqlMigrationFile;
    hash: string;
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

/** The table and column an `ALTER TABLE … ADD [COLUMN]` statement adds, or `undefined` for any other statement. */
const addedColumn = (statementText: string): { column: string; table: string } | undefined => {
    const body = statementText.slice(LEADING_TRIVIA_RE.exec(statementText)?.[0].length ?? 0);
    const match = ADD_COLUMN_RE.exec(body);

    if (match === null) {
        return undefined;
    }

    return { column: unquoteIdentifier(match[2] ?? ""), table: unquoteIdentifier(match[1] ?? "") };
};

/**
 * `PRAGMA table_info` in its statement form, with the table name quoted in. D1's authorizer refuses
 * `SELECT … FROM pragma_table_info(?)` through the Worker binding, and a pragma argument cannot be bound.
 */
const columnExists = async (client: D1Client, table: string, column: string): Promise<boolean> => {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const rows = await client.drizzle.all<{ name: string }>(sql.raw(`PRAGMA table_info(${quoted})`));

    return rows.some((row) => row.name === column);
};

/** Split one pending file into the statements to run, the ones left out, and the destructive ones. */
const planPendingFile = async (
    client: D1Client,
    file: SqlMigrationFile,
): Promise<{ destructive: string[]; runs: string[]; skipped: string[]; statements: string[] }> => {
    const destructive: string[] = [];
    const runs: string[] = [];
    const skipped: string[] = [];
    const statements: string[] = [];
    let start = 0;

    while (start < file.sql.length) {
        const scan = scanStatement(file.sql, file.name, start, true);

        start = scan.end;

        // Whitespace, comments and the stray `;` of an empty statement carry nothing to run.
        if (scan.code.replaceAll(/[\s;]/gu, "") === "") {
            continue;
        }

        if (isTransactionControl(scan)) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `${file.name} is transaction control (BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT/RELEASE). Each file already runs atomically with its tracking row in one batch(); remove it.`,
            );
        }

        const { statementText } = scan;

        statements.push(statementText);

        if (firstDestructive(scan) !== undefined) {
            destructive.push(statementText);
        }

        const added = addedColumn(statementText);

        // `ADD COLUMN` has no `IF NOT EXISTS`, and the worker adds a `.global()` column itself the first time it
        // touches the table. Running the statement anyway would fail on the duplicate and roll the whole file back.
        // eslint-disable-next-line no-await-in-loop -- statements are checked in file order, one catalog read each
        if (added !== undefined && (await columnExists(client, added.table, added.column))) {
            skipped.push(statementText);
        } else {
            runs.push(statementText);
        }
    }

    return { destructive, runs, skipped, statements };
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
const readRecorded = async (client: D1Client, dryRun: boolean): Promise<{ fresh: boolean; recorded: Map<string, string> }> => {
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

    const rows = await client.drizzle.all<{ name: string; sha256: string }>(sql.raw(`SELECT name, sha256 FROM ${SQL_TRACKING_TABLE}`));

    return { fresh: rows.length === 0, recorded: new Map(rows.map((row) => [row.name, row.sha256])) };
};

/** Decide each file's state against what is recorded. Pending files are parsed, which can refuse one outright. */
const planFiles = async (client: D1Client, files: ReadonlyArray<SqlMigrationFile>, recorded: ReadonlyMap<string, string>): Promise<PlannedFile[]> => {
    const hashed = await Promise.all(
        files.map(async (file) => {
            return { file, hash: await sha256Hex(normalizeMigrationText(file.sql)) };
        }),
    );
    const planned: PlannedFile[] = [];

    for (const { file, hash } of hashed) {
        const previous = recorded.get(file.name);

        if (previous !== undefined) {
            planned.push({
                entry: { destructive: [], name: file.name, skipped: [], state: previous === hash ? "applied" : "changed", statements: [] },
                file,
                hash,
            });
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- files are planned in the order they run
        const plan = await planPendingFile(client, file);

        planned.push({
            entry: { destructive: plan.destructive, name: file.name, skipped: plan.skipped, state: "pending", statements: plan.statements },
            file,
            hash,
        });
    }

    return planned;
};

/** Refuse the run before anything is applied, when an applied file's SQL has changed. */
const assertNoDrift = (planned: ReadonlyArray<PlannedFile>): void => {
    const drifted = planned.filter((item) => item.entry.state === "changed").map((item) => item.entry.name);

    if (drifted.length > 0) {
        throw new LunoraError(
            "MIGRATION_DRIFT",
            `${drifted.join(", ")} ${drifted.length === 1 ? "was" : "were"} already applied from different SQL. An applied file is never run again: revert the edit and put the change in a new file.`,
        );
    }
};

/**
 * Refuse a pending file that drops or replaces data. On a database with no recorded file, a destructive file is
 * refused whatever `confirmDestructive` says: it may already have run by hand, or predate this tracking, and
 * re-running a DROP over rows written since then loses them. Recording the existing files with `baseline` is the way out.
 */
const assertDestructiveConfirmed = (planned: ReadonlyArray<PlannedFile>, confirmDestructive: boolean, fresh: boolean): void => {
    const destructive = planned.filter((item) => item.entry.state === "pending" && item.entry.destructive.length > 0);

    if (destructive.length === 0) {
        return;
    }

    if (fresh) {
        throw new LunoraError(
            "MIGRATION_DESTRUCTIVE",
            "no SQL migration file is recorded on this database, so a file that drops or replaces data is refused: it may already have run by hand, or predate this tracking. Record the existing files with `migrate apply --baseline`, then run the new ones.",
        );
    }

    if (!confirmDestructive) {
        const listed = destructive.flatMap((item) =>
            item.entry.destructive.map((statement) => `${item.entry.name}: ${statement.split("\n").at(-1) ?? statement}`),
        );

        throw new LunoraError(
            "MIGRATION_DESTRUCTIVE",
            `these files drop, rename, truncate or replace data and have not run yet. Re-run with --yes to apply them:\n  ${listed.join("\n  ")}`,
        );
    }
};

/**
 * Run one file's statements and its tracking row in one batch, so the file either runs whole or not at all. With no
 * statements it only records the file. Returns `applied` when a concurrent runner recorded it first.
 */
const commitFile = async (client: D1Client, file: SqlMigrationFile, hash: string, runs: ReadonlyArray<string>): Promise<SqlMigrationState> => {
    const insert = `INSERT INTO ${SQL_TRACKING_TABLE} (name, sha256, applied_at) VALUES ('${file.name}', '${hash}', ${String(Date.now())})`;
    const items = [...runs.map((statement) => client.drizzle.run(sql.raw(statement))), client.drizzle.run(sql.raw(insert))];

    try {
        await client.batch(items as unknown as Parameters<typeof client.batch>[0]);

        return "ran";
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        // A concurrent runner recorded this file first. The batch rolled back, so nothing ran twice.
        if (SQL_TRACKING_NAME_UNIQUE_RE.test(message)) {
            return "applied";
        }

        throw new LunoraError("VALIDATION_ERROR", `${file.name} failed and was rolled back, so none of its statements took effect: ${message}`, {
            cause: error,
        });
    }
};

/**
 * Plan a pending file against the catalog as it is now, then run it. Re-planning here, rather than reusing the
 * up-front plan, means an `ADD COLUMN` skip reflects the DROPs and ADDs that earlier files in this run made.
 */
const runPending = async (client: D1Client, item: PlannedFile): Promise<Pick<SqlMigrationEntry, "skipped" | "state">> => {
    const plan = await planPendingFile(client, item.file);

    return { skipped: plan.skipped, state: await commitFile(client, item.file, item.hash, plan.runs) };
};

/**
 * Apply the pending SQL files, in the order given, against one D1 database.
 *
 * Every refusal is decided before the first file runs, so a drifted or unconfirmed file late in the list cannot leave
 * the earlier ones applied. Each file's statements and its tracking row commit in one `batch()`. A second call finds
 * every file recorded and runs nothing.
 *
 * Throws `MIGRATION_DRIFT` when an applied file's SQL changed; `MIGRATION_DESTRUCTIVE` when a pending file drops or
 * replaces data and it cannot run (see {@link assertDestructiveConfirmed}); `VALIDATION_ERROR` for transaction control
 * in a file or a batch that failed and rolled back.
 */
const applySqlMigrationFiles = async (
    database: D1DatabaseLike,
    files: ReadonlyArray<SqlMigrationFile>,
    options: ApplySqlMigrationOptions = {},
): Promise<SqlMigrationResult> => {
    assertFileNames(files);

    const client = new D1Client(database);
    const dryRun = options.dryRun === true;
    const { fresh, recorded } = await readRecorded(client, dryRun);
    const planned = await planFiles(client, files, recorded);

    if (dryRun) {
        return { files: planned.map((item) => item.entry) };
    }

    assertNoDrift(planned);

    if (options.baseline === true) {
        for (const item of planned) {
            if (item.entry.state === "pending") {
                // eslint-disable-next-line no-await-in-loop -- each record must commit before the next file is checked against the table
                item.entry.state = (await commitFile(client, item.file, item.hash, [])) === "ran" ? "baselined" : "applied";
            }
        }

        return { files: planned.map((item) => item.entry) };
    }

    assertDestructiveConfirmed(planned, options.confirmDestructive === true, fresh);

    for (const item of planned) {
        if (item.entry.state === "pending") {
            // eslint-disable-next-line no-await-in-loop -- each file's tracking row must commit before the next file is planned against it
            const outcome = await runPending(client, item);

            item.entry.skipped = outcome.skipped;
            item.entry.state = outcome.state;
        }
    }

    return { files: planned.map((item) => item.entry) };
};

export type { ApplySqlMigrationOptions, SqlMigrationEntry, SqlMigrationFile, SqlMigrationResult, SqlMigrationState };
export { applySqlMigrationFiles };
