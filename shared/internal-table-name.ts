/**
 * Reserved table names: SQLite's own bookkeeping (`sqlite_*`), Cloudflare's
 * internals (`_cf_*`), every framework table (`__`-prefixed — the CDC log,
 * idempotency cache, schedule outbox, stream runs, reactor state, commit
 * sequence, `__lunora_*` …) and every per-table index companion, which carries a
 * reserved infix (`todos__agg_byProject`, `messages__rank_byChannel`,
 * `places__geo_near`, `messages__fts_body` and its FTS5 `*_data`/`*_idx`
 * siblings).
 */
const RESERVED_TABLE_PREFIX = /^(?:sqlite_|_cf_|__)/u;
const COMPANION_TABLE_INFIX = /__(?:agg|rank|geo|fts)_/u;

/**
 * Whether `name` is framework storage rather than a user table. One definition
 * for every place that decides it: the admin surfaces hide and refuse these
 * tables (`@lunora/shard-engine`, which `@lunora/d1` and `@lunora/observability`
 * reuse), and schema discovery (`@lunora/codegen`, which shares no runtime edge
 * with the engine) refuses to declare one — so a table can never be declared and
 * then hidden.
 * @returns `true` for a reserved or companion table name
 */
export const isInternalTableName = (name: string): boolean => RESERVED_TABLE_PREFIX.test(name) || COMPANION_TABLE_INFIX.test(name);
