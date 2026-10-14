/**
 * Drift detection between the tables better-auth writes and the tables the
 * database actually holds.
 *
 * ## The failure this replaces
 *
 * `lunoraD1Adapter` builds its SQL from better-auth's own field list, and the
 * tables it writes into are created somewhere else entirely — by `ensureMigrated`
 * / `compileMigrationsSql`, or by `authTables(options)` in the app's own
 * `lunora/schema.ts` + `lunora migrate`. Nothing compared the two halves, so a
 * plugin added to `options.plugins` without the matching table, or a column
 * transcribed under another framework's name (`account.providerAccountId` is
 * NextAuth's spelling of better-auth's `accountId`), surfaced only as `no such
 * table: apikey` / `no column named accountId` inside a 500 with an empty body.
 *
 * The timing is what made it expensive: better-auth's durable rate limiter writes
 * a row **before** the handler runs, so the first failing write is the first
 * request of a session — `get-session` included — and the app merely looks "not
 * signed in" while all four auth tables sit at 0 rows.
 *
 * ## Why the live database is the authority
 *
 * The "expected" side is `getExpectedSchema(options)`: better-auth derives it from
 * the plugin list, so a table nobody declared anywhere is still expected. The
 * "actual" side could come from two places — the `defineTable` definitions the app
 * declared, or the database itself — and only the database answers the question
 * the adapter is actually asking. A `defineTable` walk proves the app *declared*
 * `apikey`; it cannot prove the migration that creates it ever ran, and it needs
 * the schema plumbed into the adapter, which `lunoraD1Adapter(env.DB)` is not
 * given. Introspection covers both drifts with no extra plumbing, and it is the
 * same authority (`SchemaSource` `"database"`) better-auth's own adapters report
 * against.
 *
 * ## Why this hangs off better-auth's hook rather than throwing at init
 *
 * better-auth 1.7 exposes {@link registerSchemaCheck} for "adapters Better Auth
 * does not own", and then awaits the registered check itself: once eagerly at
 * `betterAuth()` (logging the mismatch), and again in the router's `onRequest`
 * **before** the rate limiter writes — exactly where the empty 500 came from.
 * {@link createSchemaCheck} supplies the caching, the shared promise across
 * concurrent callers, and the invalidation after a migration, so nothing here has
 * to. A round trip on a `D1Database` also cannot happen at module-eval time in
 * workerd; deferring it to the first check is not an optimisation, it is the only
 * way it can run at all.
 *
 * The check is therefore **lazy, cached, and single-flighted**: one `PRAGMA
 * table_info` per expected table, once per adapter instance, and never again
 * unless `ensureMigrated` invalidates it.
 */
import type { IntrospectedColumn, IntrospectedTable, SchemaFinding } from "@better-auth/core/db/internal";
import { checksSchema, createSchemaCheck, diffSchema, formatSchemaFinding, getExpectedSchema, registerSchemaCheck } from "@better-auth/core/db/internal";
import type { createAdapterFactory } from "better-auth/adapters";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import CREATION_TIME_COLUMN from "./framework-columns";
import type { SqlExecutor } from "./sql-store";

/** better-auth's adapter factory shape — `(options) => Adapter`, the thing `database:` is given. */
type AdapterFactory = ReturnType<typeof createAdapterFactory>;

/** The options better-auth hands the factory: its own resolved `BetterAuthOptions`. */
type AdapterOptions = Parameters<AdapterFactory>[0];

/**
 * The statement that reads one table's column metadata. Two SQLite backends sit
 * behind {@link SqlExecutor} and they do **not** accept the same one, so the
 * caller that knows which backend it is supplies the right form.
 */
type TableInfoQuery = (table: string) => { parameters: ReadonlyArray<unknown>; sql: string };

/**
 * D1: the `PRAGMA` **statement** form, with the table name inlined as a quoted
 * identifier.
 *
 * Not `SELECT … FROM pragma_table_info(?)`. D1's authorizer refuses every pragma
 * table-valued function through the Worker binding — with a bound parameter or an
 * inline literal — which is the whole reason `d1-index-introspection.ts` exists.
 * The plain statement is a different authorizer action and is on D1's documented
 * supported-pragma list. A parameter cannot carry the name either: SQLite does not
 * bind inside a pragma argument, hence {@link quoteIdentifier} rather than `?`.
 */
const d1TableInfo: TableInfoQuery = (table) => {
    return { parameters: [], sql: `PRAGMA table_info(${quoteIdentifier(table)})` };
};

/**
 * Durable Object storage: the table-valued **function** form, which SQLite-in-DO
 * allows (`auth-do.ts` already reads its column names this way) and which takes
 * the table name as a real binding.
 */
const doTableInfo: TableInfoQuery = (table) => {
    return { parameters: [table], sql: "SELECT * FROM pragma_table_info(?)" };
};

/**
 * One `pragma_table_info` row as better-auth compares it.
 *
 * `hasDefault` is documented as "the store fills the column when an insert omits
 * it" — which is broader than a DDL `DEFAULT`, and the difference is load-bearing
 * here. A table generated by `authTables(...)` and created by `lunora migrate`
 * carries Lunora's own `_creationTime REAL NOT NULL`, a column better-auth never
 * writes and cannot know about; read literally off the DDL it is an
 * `unexpected-required-column` on **every** auth table, which would fail every
 * such app on its first request. `createSqlAuthStore` fills that column on insert
 * (see its `_creationTime` probe), so the honest answer to "does an insert that
 * omits it succeed" is yes.
 */
const introspectedColumn = (row: Record<string, unknown>): IntrospectedColumn => {
    const name = String(row["name"]);
    const columnDefault = row["dflt_value"];

    return {
        hasDefault: (columnDefault !== null && columnDefault !== undefined) || name === CREATION_TIME_COLUMN,
        name,
        // SQLite reports `notnull` as 0/1; anything unreadable is treated as nullable,
        // which can only ever suppress a finding rather than invent one.
        nullable: Number(row["notnull"] ?? 0) === 0,
    };
};

/**
 * The live shape of `name`, or `undefined` when the table does not exist —
 * `pragma_table_info` answers an unknown table with zero rows rather than an
 * error, which is exactly the "missing table" signal `diffSchema` needs.
 */
const introspectTable = async (executor: SqlExecutor, tableInfo: TableInfoQuery, name: string): Promise<IntrospectedTable | undefined> => {
    const { parameters, sql } = tableInfo(name);
    const rows = await executor.all(sql, parameters);

    if (rows.length === 0) {
        return undefined;
    }

    return { columns: rows.map((row) => introspectedColumn(row)), name };
};

/**
 * What the app has to change, in Lunora's terms.
 *
 * better-auth's own hint for a `"database"` finding is "Run `npx auth migrate`",
 * which is the one remedy a Lunora app does not have — so the findings are
 * restated here with the two places its auth tables actually come from. Logged
 * once per verdict (the check caches a mismatch and rethrows it without asking the
 * store again), not once per request.
 */
const reportFindings = (findings: ReadonlyArray<SchemaFinding>): void => {
    const lines = [
        "@lunora/auth: the auth tables do not match the better-auth options this app runs.",
        ...findings.map((finding) => `  - ${formatSchemaFinding(finding, "database")}`),
        "Fix the schema, not the adapter. better-auth's own tables are created by `ensureMigrated(...)` or by",
        "`compileMigrationsSql(...)` at deploy time; tables you declared yourself come from `authTables(options)`",
        "in `lunora/schema.ts` plus `lunora migrate`. `npx auth migrate` does not apply to a Lunora app.",
    ];

    // eslint-disable-next-line no-console -- no injected logger at this layer (workerd/Node both capture console)
    console.error(lines.join("\n"));
};

/**
 * Compare the tables this configuration writes with the tables the database
 * holds.
 *
 * Only the tables better-auth would migrate are introspected: `diffSchema` skips a
 * `disableMigrations` table anyway (the app manages its storage itself), so asking
 * about it would be a round trip that can only be ignored.
 */
const findSchemaProblems = async (options: AdapterOptions, executor: SqlExecutor, tableInfo: TableInfoQuery): Promise<SchemaFinding[]> => {
    const expected = getExpectedSchema(options);
    const names = Object.entries(expected)
        .filter(([, table]) => !table.disableMigrations)
        .map(([name]) => name);

    // Concurrent, not sequential: these are independent single-statement reads, and
    // on D1 each is its own round trip. The whole sweep runs once per adapter
    // instance, so the cost is a cold-start one and not a per-request one.
    const introspected = await Promise.all(names.map(async (name) => introspectTable(executor, tableInfo, name)));
    const findings = diffSchema(
        expected,
        introspected.filter((table): table is IntrospectedTable => table !== undefined),
    );

    if (findings.length > 0) {
        reportFindings(findings);
    }

    return findings;
};

/** Everything the check needs to read the live schema of one backend. */
interface AuthSchemaIntrospection {
    /**
     * The object identity better-auth keys this database's schema revision on. Pass
     * the D1 binding / DO storage rather than the adapter, so `ensureMigrated`'s
     * `invalidateSchemaChecks(options.database)` — which only ever sees the raw
     * binding — invalidates the verdict this check cached.
     */
    database: object;

    /** The seam the introspection statements run on; the same one the store uses. */
    executor: SqlExecutor;

    /** How this backend answers "what columns does this table have?". */
    tableInfo: TableInfoQuery;
}

/**
 * Wrap an adapter factory so every instance it builds carries a schema check.
 *
 * `checksSchema(options)` is better-auth's documented opt-out
 * (`advanced.database.validateSchema: false`); honouring it here means an app that
 * has turned validation off gets no check registered at all, and better-auth's own
 * "schema validation is not available for adapter …" path takes over.
 */
const withAuthSchemaCheck =
    (factory: AdapterFactory, introspection: AuthSchemaIntrospection): AdapterFactory =>
    (options) => {
        // The instance better-auth stores as `ctx.adapter` — `getBaseAdapter` uses the
        // object this returns verbatim, and `schemaCheckFor` looks the check up by that
        // identity. Registering on anything else (a nested transaction adapter, the
        // factory) would attach a check nothing ever awaits.
        const instance = factory(options);

        if (checksSchema(options)) {
            const { database, executor, tableInfo } = introspection;

            registerSchemaCheck(
                instance,
                createSchemaCheck(async () => findSchemaProblems(options, executor, tableInfo), "database", database),
            );
        }

        return instance;
    };

export type { AuthSchemaIntrospection, TableInfoQuery };
export { d1TableInfo, doTableInfo, findSchemaProblems, withAuthSchemaCheck };
