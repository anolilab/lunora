/**
 * The sign-in tables, read and erased in D1. `authDataset()` names better-auth's tables, but they live
 * in D1 rather than in the shard, so the package's shard port cannot reach them. This port serves the
 * `auth` dataset from the D1 binding, and passes every other dataset through to the shard.
 *
 * It runs only in the workflow: the mutation has no `env`, so a mutation that tries to read the sign-in
 * tables is refused (see `privacy-ports.ts`). A table this deployment does not have holds no rows, so a
 * dataset that lists better-auth's full default set still reads, erases and verifies.
 */
import type { DataPort, Dataset } from "@lunora/privacy";
import { LunoraError } from "lunorash/errors";

/** The dataset `authDataset()` declares. */
export const AUTH_DATASET = "auth";

/** One row as D1 returns it. */
type Row = Readonly<Record<string, unknown>>;

/** The slice of a D1 database this port uses. The Worker's `env.DB` satisfies it. */
export interface AuthDatabase {
    readonly batch: (statements: ReadonlyArray<AuthStatement>) => Promise<unknown>;
    readonly prepare: (query: string) => AuthStatement;
}

/** A prepared statement: bound values, then either rows or a write. */
export interface AuthStatement {
    readonly all: () => Promise<{ readonly results: Row[] }>;
    readonly bind: (...values: unknown[]) => AuthStatement;
    readonly run: () => Promise<unknown>;
}

/** The column that names the subject in each table. better-auth's `user` table is keyed by its own id. */
const SUBJECT_COLUMN: Readonly<Record<string, string>> = { user: "id" };

const subjectColumnOf = (table: string): string => SUBJECT_COLUMN[table] ?? "userId";

/** The D1 binding, or a refusal that names the missing binding. */
export const authDatabaseFrom = (env: Record<string, unknown>): AuthDatabase => {
    const database = env.DB as AuthDatabase | undefined;

    if (database === undefined) {
        throw new LunoraError("INTERNAL", "DB is not bound: add the D1 binding to wrangler.jsonc so the sign-in tables can be exported and erased.");
    }

    return database;
};

/** The tables that exist in this database, by name. D1 is SQLite, so the schema is in `sqlite_master`. */
const tablesIn = async (database: AuthDatabase): Promise<Set<string>> => {
    const { results } = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();

    return new Set(results.map((row) => String(row.name)));
};

const rowsOf = async (database: AuthDatabase, table: string, subjectId: string): Promise<Row[]> => {
    const { results } = await database
        .prepare(`SELECT * FROM "${table}" WHERE "${subjectColumnOf(table)}" = ?`)
        .bind(subjectId)
        .all();

    return results;
};

const countOf = async (database: AuthDatabase, table: string, subjectId: string): Promise<number> => {
    const { results } = await database
        .prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE "${subjectColumnOf(table)}" = ?`)
        .bind(subjectId)
        .all();

    return Number(results[0]?.count ?? 0);
};

/** The sign-in rows of one subject, per table. A table the database lacks reads as empty. */
export const collectAuth = async (database: AuthDatabase, dataset: Dataset, subjectId: string): Promise<Record<string, Row[]>> => {
    const present = await tablesIn(database);
    const rows = await Promise.all(dataset.tableNames.map(async (table) => (present.has(table) ? rowsOf(database, table, subjectId) : [])));

    return Object.fromEntries(dataset.tableNames.map((table, index) => [table, rows[index] ?? []]));
};

/**
 * Erase the subject's sign-in rows in one D1 batch, which runs its statements in order and atomically. The
 * tables keep the dataset's declared order, which lists `user` last, so a row another table points at goes
 * first. Nothing is kept under a retention rule here, so a verdict other than `delete` is refused.
 */
export const eraseAuth = async (
    database: AuthDatabase,
    dataset: Dataset,
    subjectId: string,
    now: Date,
    disposition: Parameters<DataPort["eraseBatch"]>[3],
): Promise<{ readonly hasMore: boolean }> => {
    const present = await tablesIn(database);
    const tables = dataset.tableNames.filter((table) => present.has(table));
    const rows = await Promise.all(tables.map(async (table) => rowsOf(database, table, subjectId)));

    tables.forEach((table, index) => {
        for (const row of rows[index] ?? []) {
            if (disposition(dataset, table, row, now).kind !== "delete") {
                throw new LunoraError("INTERNAL", `privacy-example deletes sign-in rows; "${table}" has a retention rule it does not write.`);
            }
        }
    });

    await database.batch(tables.map((table) => database.prepare(`DELETE FROM "${table}" WHERE "${subjectColumnOf(table)}" = ?`).bind(subjectId)));

    return { hasMore: false };
};

/** How many sign-in rows of the subject remain, per table, for the verify step. */
export const remainingAuth = async (database: AuthDatabase, dataset: Dataset, subjectId: string): Promise<Record<string, number>> => {
    const present = await tablesIn(database);
    const counts = await Promise.all(dataset.tableNames.map(async (table) => (present.has(table) ? countOf(database, table, subjectId) : 0)));

    return Object.fromEntries(dataset.tableNames.map((table, index) => [table, counts[index] ?? 0]));
};

/**
 * The shard port with the `auth` dataset served from D1. Every other dataset goes to `shard` unchanged.
 */
export const withAuthTables = (shard: DataPort, database: AuthDatabase): DataPort => {
    return {
        collect: async (dataset, subjectId) => (dataset.id === AUTH_DATASET ? collectAuth(database, dataset, subjectId) : shard.collect(dataset, subjectId)),
        eraseBatch: async (dataset, subjectId, now, disposition) =>
            dataset.id === AUTH_DATASET ? eraseAuth(database, dataset, subjectId, now, disposition) : shard.eraseBatch(dataset, subjectId, now, disposition),
        remaining: async (dataset, subjectId) =>
            dataset.id === AUTH_DATASET ? remainingAuth(database, dataset, subjectId) : shard.remaining(dataset, subjectId),
    };
};
