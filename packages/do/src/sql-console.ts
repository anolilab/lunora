import { LunoraError } from "@lunora/errors";

import { classifyStatement } from "../../../shared/sql-readonly";
import type { SqlExec } from "./ctx-db";

/**
 * Result of a `__lunora_admin__:runSql` read-only query: the column names (from
 * the first row), the rows (capped), the total row count the query produced, and
 * whether the rows were truncated to the cap.
 */
interface SqlConsoleResult {
    columns: string[];
    rowCount: number;
    rows: Record<string, unknown>[];
    truncated: boolean;
}

/** Most rows the SQL console returns in one query, so a `SELECT *` on a huge table can't blow up the response. */
const MAX_SQL_ROWS = 1000;

/**
 * Reject anything that isn't a single read-only statement. Throws a 400
 * LunoraError the studio surfaces inline. Enforces: non-empty, a single
 * statement (no `;`-separated batch), a leading `SELECT`/`WITH`/`EXPLAIN`, and no
 * mutating/DDL keyword anywhere.
 *
 * The rules themselves live in `shared/sql-readonly.ts` because the studio's SQL
 * editor lints with the SAME function — a second copy here would drift, and the
 * drift would show up as an editor that green-lights a statement this gate then
 * refuses. This wrapper only turns the returned rejection into the tagged error
 * the runtime serializes.
 */
const assertReadonly = (query: string): void => {
    const rejection = classifyStatement(query);

    if (rejection !== undefined) {
        throw new LunoraError(rejection.code, rejection.message, { status: 400 });
    }
};

/**
 * Run a **read-only** SQL query against the shard's SQLite and shape the result
 * for the studio's SQL editor. The server half of a Supabase/Outerbase-style SQL
 * console: it executes the verbatim query (so power users can `json_extract` the
 * `__doc__` blob, join, aggregate, `EXPLAIN`, …) but {@link assertReadonly}
 * rejects every mutating statement, because raw writes would bypass the
 * schema-aware writer and desync the FTS / aggregate / rank shadow tables.
 * Admin-gated by `ShardDO.handleAdminRpc` like every other introspection RPC.
 *
 * Rows are capped at {@link MAX_SQL_ROWS}; `rowCount` reports the true total and
 * `truncated` flags when more rows existed than were returned.
 */
const runReadonlySql = (sql: SqlExec, query: string): SqlConsoleResult => {
    assertReadonly(query);

    const all = sql.exec(query).toArray();
    const rows = all.length > MAX_SQL_ROWS ? all.slice(0, MAX_SQL_ROWS) : all;
    const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];

    return { columns, rowCount: all.length, rows, truncated: all.length > MAX_SQL_ROWS };
};

/**
 * Result of a `__lunora_admin__:lintSql` call: the diagnostics to render, plus
 * the query plan the statement would use (empty when the statement never got
 * far enough to be planned).
 */
interface SqlLintResult {
    diagnostics: SqlDiagnostic[];
    plan: string[];
}

/** One editor diagnostic; `offset`/`length` index into the query the caller sent. */
interface SqlDiagnostic {
    length?: number;
    message: string;
    offset?: number;
    severity: "error" | "warning";
    source: "gate" | "plan" | "syntax";
}

/**
 * SQLite reports a syntax error as `near "tok": syntax error`. The quoted token
 * is the only location information available, so it is matched back against the
 * query to produce a span. When the token appears more than once the FIRST
 * occurrence is used — a guess, but a bounded one, and the message still carries
 * the token verbatim.
 */
const SQLITE_NEAR = /near "([^"]*)": syntax error/iu;

/**
 * A `SCAN <table>` step in a SQLite query plan — a full table scan, no index used.
 *
 * `CONSTANT ROW` and `SUBQUERY n` are excluded: SQLite emits `SCAN CONSTANT ROW`
 * for a constant select and `SCAN SUBQUERY 1` for a materialized subquery, so
 * matching them warned "full table scan on `CONSTANT`" for statements that read
 * no table at all — a false warning is how an always-on linter loses its
 * credibility.
 */
const PLAN_SCAN = /^SCAN (?:TABLE )?(?!CONSTANT\b|SUBQUERY\b)([^\s(]+)/u;

/** Rows a SQLite `EXPLAIN QUERY PLAN` returns; only `detail` is rendered. */
interface PlanRow {
    detail?: unknown;
}

/** Locate `token` in `query` for a syntax diagnostic, or leave the span unset. */
const spanForToken = (query: string, token: string): Pick<SqlDiagnostic, "length" | "offset"> => {
    if (token === "") {
        return {};
    }

    const offset = query.indexOf(token);

    return offset === -1 ? {} : { length: token.length, offset };
};

/**
 * Lint a statement without running it: apply the same read-only gate as
 * {@link runReadonlySql}, then ask SQLite to plan it via `EXPLAIN QUERY PLAN`,
 * which parses and plans but never executes the underlying statement.
 *
 * Gated IDENTICALLY to `runSql` — a statement this refuses to lint is exactly a
 * statement `runSql` refuses to run. Widening the lint gate "because it does not
 * execute anything" would turn the linter into a side-effect channel: `EXPLAIN`
 * of a DDL statement still parses schema, and the keyword denylist is the only
 * thing keeping a `WITH`-fronted write out.
 *
 * Never throws for a bad statement: a rejection or a syntax error is reported as
 * a diagnostic, because the caller is an editor rendering feedback while the
 * operator types, not an operator asking for something to happen.
 */
const lintReadonlySql = (sql: SqlExec, query: string): SqlLintResult => {
    const rejection = classifyStatement(query);

    if (rejection !== undefined) {
        // An empty buffer is the resting state of an editor, not a mistake to
        // nag about — every other rejection is worth surfacing.
        const diagnostics: SqlDiagnostic[] =
            rejection.code === "SQL_EMPTY"
                ? []
                : [{ length: rejection.length, message: rejection.message, offset: rejection.offset, severity: "error", source: "gate" }];

        return { diagnostics, plan: [] };
    }

    let plan: string[];

    try {
        plan = sql
            .exec(`EXPLAIN QUERY PLAN ${query}`)
            .toArray()
            .map((row) => {
                const { detail } = row as PlanRow;

                return typeof detail === "string" ? detail : "";
            })
            .filter((detail) => detail !== "");
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const near = SQLITE_NEAR.exec(message);

        return {
            diagnostics: [
                {
                    ...(near ? spanForToken(query, near[1] ?? "") : {}),
                    message,
                    severity: "error",
                    source: "syntax",
                },
            ],
            plan: [],
        };
    }

    // Plan-derived warnings. `SCAN` (as opposed to `SEARCH`) means SQLite found
    // no usable index — the same signal the advisor's full-scan attribution
    // reports, deliberately worded the same way so one concept doesn't get two
    // names in one UI.
    const diagnostics: SqlDiagnostic[] = [];

    for (const detail of plan) {
        const scan = PLAN_SCAN.exec(detail);

        if (scan) {
            diagnostics.push({
                message: `full table scan on \`${scan[1] ?? ""}\` — this query reads every row`,
                severity: "warning",
                source: "plan",
            });
        }
    }

    return { diagnostics, plan };
};

export { assertReadonly, lintReadonlySql, MAX_SQL_ROWS, runReadonlySql };
export type { SqlConsoleResult, SqlDiagnostic, SqlLintResult };
