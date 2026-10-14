/**
 * `@lunora/bindings/r2sql` — typed, chainable R2 SQL for Lunora.
 *
 * Query Cloudflare [R2 SQL](https://developers.cloudflare.com/r2-sql/) — the
 * serverless engine over Apache Iceberg tables in R2 Data Catalog — from a
 * Lunora **action** via `ctx.r2sql`. First-class support for the 2026-06-21
 * features: window functions (`fn.rowNumber().over(...)`), `DISTINCT` /
 * `DISTINCT ON`, `QUALIFY`, and set operations (`.union()/.intersect()/.except()`).
 *
 * R2 SQL is non-deterministic external I/O with no Workers binding, so — like
 * `ctx.sql` (Hyperdrive) — it is wired onto `ActionCtx` only and its reads are
 * not tracked by Lunora live queries (see the `r2sql_outside_action` advisor
 * lint). See the README and `createR2Sql` JSDoc.
 */
export { default as SelectBuilder } from "./builder";
export type { R2SqlClient } from "./client";
export { createR2Sql, R2SqlError } from "./client";
export type { OrderTerm } from "./order";
export { asc, desc, renderOrderTerm } from "./order";
export type { Condition, Queryable, QueryExecutor } from "./query";
export { default as SetOperation } from "./set-operation";
export { ident, isSql, joinSql, lit, raw, Sql, sql, tableRef, toText } from "./sql";
export type { R2SqlColumn, R2SqlConfig, R2SqlExplainOptions, R2SqlResult } from "./types";
export type { OverSpec } from "./window";
export { fn, WindowFunction } from "./window";
export { default as WindowExpression } from "./window-expression";
