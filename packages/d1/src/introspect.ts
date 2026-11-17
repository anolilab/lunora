/**
 * D1 binding of `@lunora/sql-store`'s read-only `.global()` introspection for
 * the studio's database browser: the shared implementation with the
 * {@link sqliteDialect} injected.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import type { FacetGlobalColumnOptions, GlobalFacetResult, GlobalTableInfo, GlobalTablePage, ReadGlobalTablePageOptions, SqlCtxExec } from "@lunora/sql-store";
import { facetSqlGlobalColumn, listSqlGlobalTables, readSqlGlobalTablePage } from "@lunora/sql-store";

import sqliteDialect from "./sqlite-dialect";

/** Every browsable D1 table with its row count (schema `.global()` tables provisioned first). */
const listGlobalTables = (exec: SqlCtxExec, schema: SchemaLike): Promise<GlobalTableInfo[]> => listSqlGlobalTables(exec, schema, sqliteDialect);

/** One page of a D1 table's rows, eq-filtered. */
const readGlobalTablePage = (exec: SqlCtxExec, schema: SchemaLike, options: ReadGlobalTablePageOptions): Promise<GlobalTablePage> =>
    readSqlGlobalTablePage(exec, schema, sqliteDialect, options);

/** The distinct values of one D1 column over the active view. */
const facetGlobalColumn = (exec: SqlCtxExec, schema: SchemaLike, options: FacetGlobalColumnOptions): Promise<GlobalFacetResult> =>
    facetSqlGlobalColumn(exec, schema, sqliteDialect, options);

export { facetGlobalColumn, listGlobalTables, readGlobalTablePage };
export type {
    FacetGlobalColumnOptions,
    GlobalFacetResult,
    GlobalFacetValue,
    GlobalFilterClause,
    GlobalTableInfo,
    GlobalTablePage,
    ReadGlobalTablePageOptions,
} from "@lunora/sql-store";
