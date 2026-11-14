/**
 * Durable store for named admin tokens: one row per token, keyed by name,
 * holding only the SHA-256 digest of the secret. The worker generates the
 * secret and hashes it, so the shard never holds anything a caller can present.
 *
 * Lives in the default shard's SQLite because that is the one store every host
 * reaches from the worker. The `__` prefix makes it framework storage, which the
 * admin write surfaces refuse — so a named token cannot plant a row here
 * through `writeRow` or an import.
 */

import type { AdminTokenScope } from "../../../shared/admin-token-scope";
import { isAdminTokenScope } from "../../../shared/admin-token-scope";
import { ADMIN_TOKEN_TABLE } from "../../../shared/admin-token-table";
import { constantTimeEqual } from "../../../shared/constant-time-equal";
import type { SqlExec } from "./ctx-db";
import { runSql } from "./do-exec";

/** A used token rewrites `last_used_at` at most this often, so a busy CI token costs one write a minute rather than one per request. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** What `list` shows. The digest is deliberately absent. */
interface AdminTokenSummary {
    createdAt: number;
    expiresAt?: number;
    lastUsedAt?: number;
    name: string;
    scopes: AdminTokenScope[];
}

interface AdminTokenRow {
    created_at: number;
    digest: string;
    expires_at: null | number;
    last_used_at: null | number;
    name: string;
    scopes: null | string;
}

/** Shards whose token table already has the `scopes` column. Each shard checks once, not on every verify. */
const scopeColumnChecked = new WeakSet<SqlExec>();

const ensureAdminTokenTable = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${ADMIN_TOKEN_TABLE}" (
            name TEXT PRIMARY KEY,
            digest TEXT NOT NULL,
            created_at REAL NOT NULL,
            last_used_at REAL,
            expires_at REAL,
            scopes TEXT
        )`,
    );

    if (scopeColumnChecked.has(sql)) {
        return;
    }

    // A table created before scopes existed has no column, and `CREATE TABLE IF NOT EXISTS` never adds one.
    const columns = runSql<{ name: string }>(sql, `PRAGMA table_info("${ADMIN_TOKEN_TABLE}")`).toArray();

    if (!columns.some((column) => column.name === "scopes")) {
        runSql(sql, `ALTER TABLE "${ADMIN_TOKEN_TABLE}" ADD COLUMN scopes TEXT`);
    }

    scopeColumnChecked.add(sql);
};

/** A token's scopes as stored: JSON, or NULL for a token minted without one. */
const encodeScopes = (scopes: ReadonlyArray<AdminTokenScope> | undefined): null | string =>
    // eslint-disable-next-line unicorn/no-null -- SQL NULL marks a token minted without scopes
    scopes === undefined || scopes.length === 0 ? null : JSON.stringify([...new Set(scopes)]);

/** A stored token's scopes. Anything unrecognised is dropped, so it grants nothing. */
const decodeScopes = (raw: null | string): AdminTokenScope[] => {
    if (raw === null) {
        return [];
    }

    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.filter(isAdminTokenScope) : [];
};

const findRow = (sql: SqlExec, name: string): AdminTokenRow | undefined =>
    runSql<AdminTokenRow>(
        sql,
        `SELECT name, digest, created_at, last_used_at, expires_at, scopes FROM "${ADMIN_TOKEN_TABLE}" WHERE name = ?`,
        name,
    ).toArray()[0];

/** Insert a token record. Returns `false` when the name is taken — a name is revoked before it is reused. */
const createAdminTokenRecord = (
    sql: SqlExec,
    record: { createdAt: number; digest: string; expiresAt?: number; name: string; scopes?: ReadonlyArray<AdminTokenScope> },
): boolean => {
    ensureAdminTokenTable(sql);

    if (findRow(sql, record.name) !== undefined) {
        return false;
    }

    runSql(
        sql,
        `INSERT INTO "${ADMIN_TOKEN_TABLE}" (name, digest, created_at, expires_at, scopes) VALUES (?, ?, ?, ?, ?)`,
        record.name,
        record.digest,
        record.createdAt,
        // eslint-disable-next-line unicorn/no-null -- SQL NULL marks a token that never expires
        record.expiresAt ?? null,
        encodeScopes(record.scopes),
    );

    return true;
};

const listAdminTokens = (sql: SqlExec): AdminTokenSummary[] => {
    ensureAdminTokenTable(sql);

    return runSql<Omit<AdminTokenRow, "digest">>(sql, `SELECT name, created_at, last_used_at, expires_at, scopes FROM "${ADMIN_TOKEN_TABLE}" ORDER BY name`)
        .toArray()
        .map((row) => {
            const summary: AdminTokenSummary = { createdAt: row.created_at, name: row.name, scopes: decodeScopes(row.scopes) };

            if (row.last_used_at !== null) {
                summary.lastUsedAt = row.last_used_at;
            }

            if (row.expires_at !== null) {
                summary.expiresAt = row.expires_at;
            }

            return summary;
        });
};

/**
 * Delete the token called `name` that was issued at `createdAt`. Returns `false` when no such issuance
 * exists, including when the name now belongs to a token created after the one the caller inspected:
 * a revoke acts on one issuance, never on whatever currently holds the name.
 */
const revokeAdminTokenRecord = (sql: SqlExec, name: string, createdAt: number): boolean => {
    ensureAdminTokenTable(sql);

    const row = findRow(sql, name);

    if (row?.created_at !== createdAt) {
        return false;
    }

    // Conditional in SQL as well, so the row removed is the one inspected even if the table changed in between.
    runSql(sql, `DELETE FROM "${ADMIN_TOKEN_TABLE}" WHERE name = ? AND created_at = ?`, name, createdAt);

    return true;
};

/**
 * The live, unexpired token called `name` whose digest matches — its `createdAt` (with the name, the
 * identity a revocation is recorded under) and its expiry, so a
 * caller caching the answer never trusts it past that — or `undefined`. Compared
 * in constant time; a match refreshes `last_used_at` when it is stale.
 */
const verifyAdminTokenDigest = (
    sql: SqlExec,
    name: string,
    digest: string,
    now: number,
): undefined | { createdAt: number; expiresAt?: number; scopes: AdminTokenScope[] } => {
    ensureAdminTokenTable(sql);

    const row = findRow(sql, name);

    if (row === undefined || !constantTimeEqual(row.digest, digest) || (row.expires_at !== null && row.expires_at <= now)) {
        return undefined;
    }

    if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_WRITE_INTERVAL_MS) {
        runSql(sql, `UPDATE "${ADMIN_TOKEN_TABLE}" SET last_used_at = ? WHERE name = ?`, now, name);
    }

    const scopes = decodeScopes(row.scopes);

    return row.expires_at === null ? { createdAt: row.created_at, scopes } : { createdAt: row.created_at, expiresAt: row.expires_at, scopes };
};

/** Whether a token called `name` exists, live or expired — lets a caller tell an unknown name from a wrong secret. */
const adminTokenExists = (sql: SqlExec, name: string): boolean => {
    ensureAdminTokenTable(sql);

    return findRow(sql, name) !== undefined;
};

export { ADMIN_TOKEN_TABLE } from "../../../shared/admin-token-table";
export { adminTokenExists, createAdminTokenRecord, listAdminTokens, revokeAdminTokenRecord, verifyAdminTokenDigest };
export type { AdminTokenSummary };
