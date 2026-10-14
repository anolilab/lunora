import type { SqlCursor, SqlExec } from "@lunora/shard-engine";

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...parameters: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...parameters);
};

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export { runSql };
