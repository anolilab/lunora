/**
 * The sign-in tables, read and erased in D1. `authDataset()` names better-auth's tables, and `signInTokens`
 * names the verification table, which holds identifiers and tokens. They live in D1 rather than in the shard,
 * so the package's shard port cannot reach them. This port serves those datasets from the D1 binding, and
 * passes every other dataset through to the shard.
 *
 * It runs only in the workflow: the mutation has no `env`, so a mutation that tries to read the sign-in
 * tables is refused (see `privacy-ports.ts`). A table this deployment does not have holds no rows, so a
 * dataset that lists better-auth's full default set still reads, erases and verifies.
 */
import type { DataPort, Dataset } from "@lunora/privacy";
import { LunoraError } from "lunorash/errors";

/** The dataset `authDataset()` declares: better-auth's user, session and account rows. */
export const AUTH_DATASET = "auth";

/** The dataset that declares the verification table, whose rows are keyed by identifier and value. */
export const SIGN_IN_TOKENS_DATASET = "signInTokens";

const SIGN_IN_DATASETS: ReadonlySet<string> = new Set([AUTH_DATASET, SIGN_IN_TOKENS_DATASET]);

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

/**
 * Whose rows a table holds. `subjectId` is the user id. `email` is the user's address, read from the user row
 * before that row is erased, and it is empty once the row is gone. better-auth keys an email-verification record
 * by the address and a password-reset record by the user id, so a verification row matches on either.
 */
interface Scope {
    readonly email: string;
    readonly subjectId: string;
}

/** The WHERE clause that selects one subject's rows in a table, and the values it binds, in order. */
interface Clause {
    readonly sql: string;
    readonly values: string[];
}

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

/**
 * The clause that selects a subject's rows in one table. The user table is keyed by its own id. A verification record
 * is owned by its address (email verification), or, for a password reset, by the user id in `value` while `identifier`
 * carries the reset token. `value` alone is never an ownership key: for an email-verification record it is a token.
 */
const clauseFor = (table: string, scope: Scope): Clause => {
    if (table === "verification") {
        return {
            sql: '"identifier" = ? OR ("value" = ? AND "identifier" LIKE \'reset-password:%\')',
            values: [scope.email, scope.subjectId],
        };
    }

    return { sql: `"${table === "user" ? "id" : "userId"}" = ?`, values: [scope.subjectId] };
};

const rowsOf = async (database: AuthDatabase, table: string, scope: Scope): Promise<Row[]> => {
    const clause = clauseFor(table, scope);
    const { results } = await database
        .prepare(`SELECT * FROM "${table}" WHERE ${clause.sql}`)
        .bind(...clause.values)
        .all();

    return results;
};

const countOf = async (database: AuthDatabase, table: string, scope: Scope): Promise<number> => {
    const clause = clauseFor(table, scope);
    const { results } = await database
        .prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE ${clause.sql}`)
        .bind(...clause.values)
        .all();

    return Number(results[0]?.count ?? 0);
};

/** The subject's scope, with the email read from the user row while that row still exists. */
const scopeOf = async (database: AuthDatabase, present: ReadonlySet<string>, subjectId: string): Promise<Scope> => {
    const user = present.has("user") ? await rowsOf(database, "user", { email: "", subjectId }) : [];

    const email = user[0]?.email;

    return { email: typeof email === "string" ? email : "", subjectId };
};

/** The sign-in rows of one subject, per table. A table the database lacks reads as empty. */
export const collectAuth = async (database: AuthDatabase, dataset: Dataset, subjectId: string): Promise<Record<string, Row[]>> => {
    const present = await tablesIn(database);
    const scope = await scopeOf(database, present, subjectId);
    const rows = await Promise.all(dataset.tableNames.map(async (table) => (present.has(table) ? rowsOf(database, table, scope) : [])));

    return Object.fromEntries(dataset.tableNames.map((table, index) => [table, rows[index] ?? []]));
};

/**
 * Erase the subject's sign-in rows in one D1 batch, which runs its statements in order and atomically. The
 * tables keep the dataset's declared order. A dataset that lists `user` must come after one that lists the rows
 * which are matched by the user's email, so the email is still readable when those rows are erased. Nothing is
 * kept under a retention rule here, so a verdict other than `delete` is refused.
 */
export const eraseAuth = async (
    database: AuthDatabase,
    dataset: Dataset,
    subjectId: string,
    now: Date,
    disposition: Parameters<DataPort["eraseBatch"]>[3],
): Promise<{ readonly hasMore: boolean }> => {
    const present = await tablesIn(database);
    const scope = await scopeOf(database, present, subjectId);
    const tables = dataset.tableNames.filter((table) => present.has(table));
    const rows = await Promise.all(tables.map(async (table) => rowsOf(database, table, scope)));

    tables.forEach((table, index) => {
        for (const row of rows[index] ?? []) {
            if (disposition(dataset, table, row, now).kind !== "delete") {
                throw new LunoraError("INTERNAL", `privacy-example deletes sign-in rows; "${table}" has a retention rule it does not write.`);
            }
        }
    });

    await database.batch(
        tables.map((table) => {
            const clause = clauseFor(table, scope);

            return database.prepare(`DELETE FROM "${table}" WHERE ${clause.sql}`).bind(...clause.values);
        }),
    );

    return { hasMore: false };
};

/** How many sign-in rows of the subject remain, per table, for the verify step. */
export const remainingAuth = async (database: AuthDatabase, dataset: Dataset, subjectId: string): Promise<Record<string, number>> => {
    const present = await tablesIn(database);
    const scope = await scopeOf(database, present, subjectId);
    const counts = await Promise.all(dataset.tableNames.map(async (table) => (present.has(table) ? countOf(database, table, scope) : 0)));

    return Object.fromEntries(dataset.tableNames.map((table, index) => [table, counts[index] ?? 0]));
};

/**
 * The shard port with the sign-in datasets served from D1. Every other dataset goes to `shard` unchanged.
 */
export const withAuthTables = (shard: DataPort, database: AuthDatabase): DataPort => {
    return {
        collect: async (dataset, subjectId) =>
            SIGN_IN_DATASETS.has(dataset.id) ? collectAuth(database, dataset, subjectId) : shard.collect(dataset, subjectId),
        eraseBatch: async (dataset, subjectId, now, disposition) =>
            SIGN_IN_DATASETS.has(dataset.id)
                ? eraseAuth(database, dataset, subjectId, now, disposition)
                : shard.eraseBatch(dataset, subjectId, now, disposition),
        remaining: async (dataset, subjectId) =>
            SIGN_IN_DATASETS.has(dataset.id) ? remainingAuth(database, dataset, subjectId) : shard.remaining(dataset, subjectId),
    };
};
