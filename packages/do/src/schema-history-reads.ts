/**
 * Admin read resolvers registered as a lookup table.
 *
 * Holds the SQL linter, the schema-version ledger, per-row reverse-relation
 * counts, and the time-ranged query insights. A lookup table rather than more
 * arms on `ShardDO.readAdminOp`'s if-chain: these are pure functions of `(sql, args)` — none of them touches
 * `this` — so expressing them as class methods would mean three more
 * `class-methods-use-this` suppressions in a file that already carries dozens,
 * and three more branches in a dispatch chain that is already long. Registering
 * them here keeps `shard-do.ts`'s growth to a single delegated lookup, and keeps
 * these resolvers next to the storage helpers they wrap.
 */

import { readQueryInsights } from "@lunora/observability";
import type { SqlExec } from "@lunora/shard-engine";
import { lintReadonlySql, readSchemaHistory, readSchemaVersion } from "@lunora/shard-engine";

import { readBackRelationCounts } from "./back-relations";

/** What a resolver hands back: the RPC payload plus the tables the read depends on. */
interface AdminReadOutcome {
    result: unknown;
    tables: Set<string>;
}

/** A resolver for one `__lunora_admin__:*` read. */
type AdminReadResolver = (sql: SqlExec, args: Record<string, unknown>, wildcard: string) => AdminReadOutcome;

/** Read a string argument, defaulting to empty rather than throwing on a bad payload. */
const stringArgument = (args: Record<string, unknown>, name: string): string => (typeof args[name] === "string" ? args[name] : "");

/** The ranges the Studio's query-insights selector offers, in milliseconds. */
const INSIGHT_RANGES: Readonly<Record<string, number>> = {
    "1h": 60 * 60 * 1000,
    "1m": 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
};

/** Resolve a range token to milliseconds, defaulting to 15m for anything unrecognised. */
const rangeMsOf = (args: Record<string, unknown>): number => INSIGHT_RANGES[stringArgument(args, "range")] ?? INSIGHT_RANGES["15m"] ?? 900_000;

/**
 * Resolvers keyed by the BARE function name (the part after
 * `__lunora_admin__:`). Every one of these carries the wildcard table
 * dependency: they read reserved tables that no user-table write signal covers,
 * and they are one-shot reads rather than live subscriptions.
 */
const SCHEMA_HISTORY_READS: Readonly<Record<string, AdminReadResolver>> = {
    /**
     * Plan (never execute) a statement and return its diagnostics. Gated
     * identically to `runSql` — same read-only classifier — because a laxer lint
     * path would be a way around the gate.
     */
    lintSql: (sql, args, wildcard) => {
        return { result: lintReadonlySql(sql, stringArgument(args, "sql")), tables: new Set([wildcard]) };
    },

    /**
     * Per-row reverse-relation counts for the loaded page — one grouped query
     * per relation, never one per row.
     */
    backRelationCounts: (sql, args, wildcard) => {
        const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : [];
        // Element-shape validated here, not cast: a hand-built payload with a
        // non-string `table` would otherwise reach `quoteIdentifier` and throw a
        // 500 rather than being skipped like every other unresolvable edge.
        const relations = Array.isArray(args.relations)
            ? args.relations.filter(
                  (entry): entry is { column: string; table: string } =>
                      typeof entry === "object" &&
                      entry !== null &&
                      typeof (entry as { table?: unknown }).table === "string" &&
                      typeof (entry as { column?: unknown }).column === "string",
              )
            : [];

        return { result: readBackRelationCounts(sql, { ids, relations }), tables: new Set([wildcard]) };
    },

    /**
     * Per-statement activity within the selected range, plus a combined
     * throughput/latency series. Reads the time-bucketed table rather than the
     * lifetime counters, so it answers "what is hot now".
     */
    getQueryInsights: (sql, args, wildcard) => {
        return { result: readQueryInsights(sql, rangeMsOf(args)), tables: new Set([wildcard]) };
    },

    /** Every recorded schema version, newest first, WITHOUT the snapshot payloads. */
    schemaHistory: (sql, _args, wildcard) => {
        return { result: { versions: readSchemaHistory(sql) }, tables: new Set([wildcard]) };
    },

    /**
     * One version's full snapshot JSON, by content hash. An unknown hash yields
     * `{ version: undefined }` rather than an error — a stale deep link is an
     * empty state, not a failure.
     */
    schemaVersion: (sql, args, wildcard) => {
        return { result: { version: readSchemaVersion(sql, stringArgument(args, "hash")) }, tables: new Set([wildcard]) };
    },
};

/**
 * Resolve one of this module's admin reads, or `undefined` when `functionPath`
 * is not one of them (so the caller falls through to its other dispatch).
 */
const resolveSchemaHistoryRead = (
    functionPath: string,
    prefix: string,
    sql: SqlExec,
    args: Record<string, unknown>,
    wildcard: string,
): AdminReadOutcome | undefined => {
    if (!functionPath.startsWith(prefix)) {
        return undefined;
    }

    const name = functionPath.slice(prefix.length);

    // `Object.hasOwn`, not a bare index: a literal's keys resolve through
    // `Object.prototype`, so `__lunora_admin__:toString` would return
    // `Object.prototype.toString` — truthy, called, and handed back as an
    // outcome. Harmless over the one-shot POST, but the subscription bridge then
    // reads `.tables` off it and throws inside the socket handler.
    return Object.hasOwn(SCHEMA_HISTORY_READS, name) ? SCHEMA_HISTORY_READS[name]?.(sql, args, wildcard) : undefined;
};

export { resolveSchemaHistoryRead };
export type { AdminReadOutcome };
