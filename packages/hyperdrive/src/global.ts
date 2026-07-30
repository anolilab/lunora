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
import type { DatabaseWriterLike } from "@lunora/shard-engine";
import type { SqlCtxDbOptions, SqlExec } from "@lunora/sql-store";
import { createSqlCtxDb } from "@lunora/sql-store";

import { mysqlDialect, postgresDialect } from "./global-dialect";
import type { Mysql2Execute, RowClient } from "./global-exec";
import { buildMysqlExec, buildPgExec } from "./global-exec";

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
    createSqlCtxDb({ ...rest, dialect: engine === "postgres" ? postgresDialect : mysqlDialect, exec });

/** Convenience: a **Postgres** `.global()` writer from a row-client (postgres.js/pg over Hyperdrive). */
export const createPostgresGlobalCtxDb = (client: RowClient, options: Omit<CreateHyperdriveGlobalCtxDbOptions, "engine" | "exec">): DatabaseWriterLike =>
    createHyperdriveGlobalCtxDb({ ...options, engine: "postgres", exec: buildPgExec(client) });

/** Convenience: a **MySQL** `.global()` writer from a `mysql2/promise` connection/pool (created with `flags: ["FOUND_ROWS"]`). */
export const createMysqlGlobalCtxDb = (connection: Mysql2Execute, options: Omit<CreateHyperdriveGlobalCtxDbOptions, "engine" | "exec">): DatabaseWriterLike =>
    createHyperdriveGlobalCtxDb({ ...options, engine: "mysql", exec: buildMysqlExec(connection) });

export { mysqlDialect, postgresDialect } from "./global-dialect";
export type { Mysql2Execute, RowClient } from "./global-exec";
export { buildMysqlExec, buildPgExec } from "./global-exec";
