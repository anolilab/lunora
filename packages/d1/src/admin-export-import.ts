/**
 * D1 binding of `@lunora/sql-store`'s admin bulk export/import for `.global()`
 * tables: the shared implementation with the {@link sqliteDialect} injected.
 */
import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import type { ExportGlobalArgs, ExportRow, ImportGlobalArgs, ImportResult, SqlCtxExec } from "@lunora/sql-store";
import { exportSqlGlobalRows, importSqlGlobalRows } from "@lunora/sql-store";

import sqliteDialect from "./sqlite-dialect";

/** Yield every requested D1 `.global()` table's rows, keyset-paged; never-written tables export empty. */
const exportGlobalRows = (exec: SqlCtxExec, schema: SchemaLike, args: ExportGlobalArgs): AsyncGenerator<ExportRow, void, undefined> =>
    exportSqlGlobalRows(exec, schema, sqliteDialect, args);

/** Insert snapshot rows into D1 `.global()` tables; an existing `_id` is a conflict, left unchanged. */
const importGlobalRows = (writer: DatabaseWriterLike, schema: SchemaLike, args: ImportGlobalArgs): Promise<ImportResult> =>
    importSqlGlobalRows(writer, schema, sqliteDialect, args);

export { exportGlobalRows, importGlobalRows };
export type { ExportGlobalArgs, ExportRow, ImportError, ImportGlobalArgs, ImportResult } from "@lunora/sql-store";
export { selectGlobalTables } from "@lunora/sql-store";
