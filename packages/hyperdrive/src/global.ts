/**
 * `@lunora/hyperdrive/global` — a Postgres/MySQL database reached through
 * Cloudflare Hyperdrive (PlanetScale, Neon, RDS, …) as a **first-class,
 * reactive** `.global()` storage backend for Lunora, alongside D1.
 *
 * Unlike the package's `ctx.sql` surface (an action-only, non-reactive escape
 * hatch for an external DB), this makes Lunora the **owner** of the schema:
 * `.global()` tables get a real column-per-field layout and all writes route
 * through the shared store core (`createSqlCtxDb` from `@lunora/sql-store`) with
 * a Postgres or MySQL {@link postgresDialect}/{@link mysqlDialect} and a
 * Hyperdrive-backed {@link SqlExec}. The returned `DatabaseWriterLike` is
 * injected as `globalDb` into `createShardCtxDb`, whose broadcast hook drives
 * live queries — so subscriptions stay reactive with zero extra wiring,
 * identical to D1.
 *
 * Drivers (`postgres`/`pg`/`mysql2`) are optional peer deps — bring your own,
 * constructed from the `HYPERDRIVE` binding's connection string. The binding is
 * reachable from inside the Durable Object that hosts the writer; cache the
 * driver on the DO instance and rebuild it lazily after hibernation.
 *
 * **MySQL connections must enable `CLIENT_FOUND_ROWS`** (mysql2:
 * `createPool({ flags: ["FOUND_ROWS"] })`) so the affected-rows OCC guard sees
 * matched (not changed) rows — see {@link buildMysqlExec}.
 */
import type { CdcChange, DatabaseWriterLike, ImportConflictMode, SchemaLike } from "@lunora/shard-engine";
import { applyCdcChanges, CDC_LOG_TABLE } from "@lunora/shard-engine";
import type {
    ExportRow,
    FacetGlobalColumnOptions,
    GlobalFacetResult,
    GlobalTableInfo,
    GlobalTablePage,
    ImportResult,
    ReadGlobalTablePageOptions,
    SqlCtxDbOptions,
    SqlDialect,
    SqlExec,
} from "@lunora/sql-store";
import {
    createSqlCtxDb,
    exportSqlGlobalRows,
    facetSqlGlobalColumn,
    importSqlGlobalRows,
    listSqlGlobalTables,
    readSqlCdcChanges,
    readSqlGlobalTablePage,
} from "@lunora/sql-store";

import { mysqlDialect, postgresDialect } from "./global-dialect";
import type { Mysql2Execute, RowClient } from "./global-exec";
import { buildMysqlExec, buildPgExec } from "./global-exec";

const dialectFor = (engine: HyperdriveEngine): SqlDialect => (engine === "postgres" ? postgresDialect : mysqlDialect);

/** Which engine a Hyperdrive-backed `.global()` store targets. */
export type HyperdriveEngine = "mysql" | "postgres";

/** Options for {@link createHyperdriveGlobalCtxDb}: the store options minus `exec`/`dialect`, plus the engine and a built `SqlExec`. */
export interface CreateHyperdriveGlobalCtxDbOptions extends Omit<SqlCtxDbOptions, "dialect" | "exec"> {
    /** The engine, selecting the Postgres or MySQL dialect. */
    engine: HyperdriveEngine;
    /** A Hyperdrive-backed exec, e.g. from {@link buildPgExec}/{@link buildMysqlExec}. */
    exec: SqlExec;
}

/**
 * Build a reactive `.global()` writer backed by a Hyperdrive-reachable
 * Postgres/MySQL database. Pass a built {@link SqlExec} (via {@link buildPgExec}/
 * {@link buildMysqlExec}) and the matching `engine`; everything else mirrors the
 * D1 store options.
 */
export const createHyperdriveGlobalCtxDb = ({ engine, exec, ...rest }: CreateHyperdriveGlobalCtxDbOptions): DatabaseWriterLike =>
    createSqlCtxDb({ ...rest, dialect: dialectFor(engine), exec });

/** Options for {@link exportHyperdriveGlobalRows}. */
export interface ExportHyperdriveGlobalRowsOptions {
    engine: HyperdriveEngine;
    exec: SqlExec;
    schema: SchemaLike;
    /** Table allowlist; empty or absent exports every `.global()` table. */
    tables?: ReadonlyArray<string>;
}

/**
 * The admin export's global plane on Hyperdrive: yield every requested
 * `.global()` table's rows, keyset-paged. Provisions the schema's tables first,
 * so a table that was never written exports as empty instead of failing.
 */
export const exportHyperdriveGlobalRows = ({ engine, exec, schema, tables }: ExportHyperdriveGlobalRowsOptions): AsyncGenerator<ExportRow, void, undefined> =>
    exportSqlGlobalRows(exec, schema, dialectFor(engine), tables === undefined ? {} : { tables });

/** Options for {@link importHyperdriveGlobalRows}. */
export interface ImportHyperdriveGlobalRowsOptions {
    /** Append each insert to the global CDC log, like any other write — the app's own `cdc` setting. */
    cdc: boolean;
    /** Validate and report shape errors only; nothing is probed or written. */
    dryRun?: boolean;
    engine: HyperdriveEngine;
    exec: SqlExec;
    /** `"replace"` overwrites a row whose `_id` already exists; `"skip"` (the default) counts it as a conflict. */
    onConflict?: ImportConflictMode;
    rows: ReadonlyArray<ExportRow>;
    schema: SchemaLike;
    startLine?: number;
}

/**
 * The admin import's global plane on Hyperdrive: insert snapshot rows through
 * the same store core `.global()` writes use. A row whose `_id` already exists
 * is a conflict left unchanged, unless `onConflict` is `"replace"`.
 */
export const importHyperdriveGlobalRows = ({
    cdc,
    dryRun,
    engine,
    exec,
    onConflict,
    rows,
    schema,
    startLine,
}: ImportHyperdriveGlobalRowsOptions): Promise<ImportResult> =>
    importSqlGlobalRows(createHyperdriveGlobalCtxDb({ cdc, engine, exec, schema }), schema, dialectFor(engine), {
        dryRun: dryRun === true,
        exec,
        onConflict: onConflict ?? "skip",
        rows,
        ...(startLine === undefined ? {} : { startLine }),
    });

/** Convenience: a **Postgres** `.global()` writer from a row-client (postgres.js/pg over Hyperdrive). */
export const createPostgresGlobalCtxDb = (client: RowClient, options: Omit<CreateHyperdriveGlobalCtxDbOptions, "engine" | "exec">): DatabaseWriterLike =>
    createHyperdriveGlobalCtxDb({ ...options, engine: "postgres", exec: buildPgExec(client) });

/** Convenience: a **MySQL** `.global()` writer from a `mysql2/promise` connection/pool (created with `flags: ["FOUND_ROWS"]`). */
export const createMysqlGlobalCtxDb = (connection: Mysql2Execute, options: Omit<CreateHyperdriveGlobalCtxDbOptions, "engine" | "exec">): DatabaseWriterLike =>
    createHyperdriveGlobalCtxDb({ ...options, engine: "mysql", exec: buildMysqlExec(connection) });

/** The studio's global data browser over a Hyperdrive database — every table in the connection's schema, internal ones hidden. */
export interface HyperdriveGlobalIntrospector {
    facetColumn: (options: FacetGlobalColumnOptions) => Promise<GlobalFacetResult>;
    listTables: () => Promise<GlobalTableInfo[]>;
    readTablePage: (options: ReadGlobalTablePageOptions) => Promise<GlobalTablePage>;
}

/** Build the studio's global-browser introspector for a Hyperdrive `.global()` store. */
export const createHyperdriveGlobalIntrospector = (engine: HyperdriveEngine, exec: SqlExec, schema: SchemaLike): HyperdriveGlobalIntrospector => {
    const dialect = dialectFor(engine);

    return {
        facetColumn: (options) => facetSqlGlobalColumn(exec, schema, dialect, options),
        listTables: () => listSqlGlobalTables(exec, schema, dialect),
        readTablePage: (options) => readSqlGlobalTablePage(exec, schema, dialect, options),
    };
};

/**
 * The admin CDC sync's global plane on Hyperdrive: a page of the global
 * `__cdc_log` past `sinceSeq`. The log only exists once a CDC-enabled writer has
 * run, so its absence is "nothing has changed yet" — an empty page that leaves
 * the cursor where it was — not an error.
 */
export const readHyperdriveGlobalCdc = async (
    engine: HyperdriveEngine,
    exec: SqlExec,
    request: { limit?: number; now?: number; sinceSeq: number },
): Promise<{ changes: CdcChange[]; cursor: number }> => {
    const dialect = dialectFor(engine);
    const { params, sql: text } = dialect.render(dialect.tableExists(CDC_LOG_TABLE));

    const present = await exec.all(text, params);

    if (present.length === 0) {
        return { changes: [], cursor: request.sinceSeq };
    }

    return readSqlCdcChanges(exec, request, dialect);
};

/**
 * The admin point-in-time apply's global plane on Hyperdrive: replay CDC changes
 * in order through the store core (insert, falling back to replace). The writer
 * carries the app's `cdc` setting so the replay appends to the global changelog
 * like any other write. Returns the number replayed.
 */
export const applyHyperdriveGlobalCdc = async (options: {
    cdc: boolean;
    changes: ReadonlyArray<CdcChange>;
    engine: HyperdriveEngine;
    exec: SqlExec;
    schema: SchemaLike;
}): Promise<number> => {
    await applyCdcChanges(
        createHyperdriveGlobalCtxDb({ cdc: options.cdc, engine: options.engine, exec: options.exec, schema: options.schema }),
        options.changes,
    );

    return options.changes.length;
};

export { mysqlDialect, postgresDialect } from "./global-dialect";
export type { Mysql2Execute, RowClient } from "./global-exec";
export { buildMysqlExec, buildPgExec } from "./global-exec";
export type { PgVectorIndexOptions } from "./pg-vector";
export { createPgVectorIndex } from "./pg-vector";
