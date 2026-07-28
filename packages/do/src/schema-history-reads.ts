/**
 * Admin read resolvers for the schema-version ledger and the SQL linter.
 *
 * A lookup table rather than three more arms on `ShardDO.readAdminOp`'s
 * if-chain: these are pure functions of `(sql, args)` — none of them touches
 * `this` — so expressing them as class methods would mean three more
 * `class-methods-use-this` suppressions in a file that already carries dozens,
 * and three more branches in a dispatch chain that is already long. Registering
 * them here keeps `shard-do.ts`'s growth to a single delegated lookup, and keeps
 * these resolvers next to the storage helpers they wrap.
 */

import type { SqlExec } from "./ctx-db";
import { readSchemaHistory, readSchemaVersion } from "./schema-history";
import { lintReadonlySql } from "./sql-console";

/** What a resolver hands back: the RPC payload plus the tables the read depends on. */
interface AdminReadOutcome {
    result: unknown;
    tables: Set<string>;
}

/** A resolver for one `__lunora_admin__:*` read. */
type AdminReadResolver = (sql: SqlExec, args: Record<string, unknown>, wildcard: string) => AdminReadOutcome;

/** Read a string argument, defaulting to empty rather than throwing on a bad payload. */
const stringArgument = (args: Record<string, unknown>, name: string): string => (typeof args[name] === "string" ? args[name] : "");

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

    return SCHEMA_HISTORY_READS[functionPath.slice(prefix.length)]?.(sql, args, wildcard);
};

export { resolveSchemaHistoryRead, SCHEMA_HISTORY_READS };
export type { AdminReadOutcome, AdminReadResolver };
