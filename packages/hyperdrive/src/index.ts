/**
 * `@lunora/hyperdrive` — bring-your-own Postgres/MySQL for Lunora via Cloudflare
 * Hyperdrive.
 *
 * Surfaces a Hyperdrive binding's connection string and a driver-agnostic
 * {@link import("./types").SqlClient | SqlClient} bound to `ctx.sql` on
 * **`ActionCtx` only**. External SQL is non-deterministic (action-only) and
 * non-reactive (live queries do not track external writes) — integrate an
 * existing DB, do not replace the Lunora data layer. See the README and
 * {@link import("./create-hyperdrive").createHyperdrive | createHyperdrive} JSDoc.
 */
export { createHyperdrive, fromMysql2, fromNodePg, fromPostgresJs } from "./create-hyperdrive";
export type { ProjectOptions, PullSourceOptions } from "./source";
export { projectSourceRow, pullSourceRows } from "./source";
export type { HyperdriveConnection, HyperdriveLike, Mysql2Like, NodePgLike, PostgresJsLike, SqlClient } from "./types";
