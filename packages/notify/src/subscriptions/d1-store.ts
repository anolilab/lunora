import { LunoraError } from "@lunora/errors";

import { isBareIdentifier } from "../../../../shared/bare-identifier";
import type { StoredSubscription, SubscriptionFilter, SubscriptionKind, SubscriptionStatus, SubscriptionStore } from "../types";
import { claimRefusal, legacyIdFor } from "./normalize";

/**
 * The minimal structural slice of Cloudflare's `D1Database` this store uses. A
 * structural type (rather than importing `@cloudflare/workers-types`) keeps the
 * store runtime-agnostic and trivially fakeable in tests.
 */
interface D1Like {
    prepare: (query: string) => D1PreparedLike;
}

interface D1PreparedLike {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- mirrors Cloudflare's generic D1 result API
    all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
    bind: (...values: unknown[]) => D1PreparedLike;
    first: <T = Record<string, unknown>>() => Promise<T | null>;
    run: () => Promise<unknown>;
}

interface Row {
    auth: string | null;
    created_at: number;
    endpoint: string | null;
    id: string;
    kind: string;
    last_error: string | null;
    last_seen_at: number;
    last_status: string | null;
    metadata: string | null;
    p256dh: string | null;
    token: string | null;
    user_id: string | null;
}

const rowToSubscription = (row: Row): StoredSubscription => {
    const subscription: StoredSubscription = {
        createdAt: row.created_at,
        id: row.id,
        kind: row.kind as SubscriptionKind,
        lastSeenAt: row.last_seen_at,
        userId: row.user_id,
    };

    if (row.endpoint !== null) {
        subscription.endpoint = row.endpoint;
    }

    if (row.p256dh !== null && row.auth !== null) {
        subscription.keys = { auth: row.auth, p256dh: row.p256dh };
    }

    if (row.token !== null) {
        subscription.token = row.token;
    }

    if (row.last_status !== null) {
        subscription.lastStatus = row.last_status as SubscriptionStatus;
    }

    if (row.last_error !== null) {
        subscription.lastError = row.last_error;
    }

    if (row.metadata !== null) {
        try {
            subscription.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
            // A malformed metadata blob must not break reads — drop it silently.
        }
    }

    return subscription;
};

/** Options for {@link d1SubscriptionStore}. */
interface D1StoreOptions {
    /** Table name (default `lunora_push_subscriptions`). Must be a bare identifier. */
    tableName?: string;
}

/**
 * A D1-backed {@link SubscriptionStore}. Edge-safe (D1 is a Worker binding). The
 * backing table is created lazily on first use (`CREATE TABLE IF NOT EXISTS`), so
 * no migration step is required for the subscription table itself.
 *
 * ID SCHEME / LAZY MIGRATION: `id` (the `PRIMARY KEY`, upserted via `ON
 * CONFLICT(id) DO UPDATE`) is a version-prefixed digest of the endpoint/token —
 * currently `wp2_`/`fcm2_` (64-bit FNV-1a; see `normalize.ts`). No table migration
 * runs when the id scheme is revised: a returning device re-registers under its new
 * id and upserts a fresh row, while its old-prefix row (`wp_`/`fcm_`) ages out via
 * the normal gone-pruning on the next failed send. So a table can transiently hold
 * both an old- and new-prefix row for one device — expected, self-healing, and the
 * reason a prefix must NEVER be reused for a different scheme.
 *
 * ```ts
 * export default defineNotify({
 *     webPush: (env) => webPushFromEnv(env),
 *     store: (env) => d1SubscriptionStore(env.DB),
 * });
 * ```
 */
const d1SubscriptionStore = (database: D1Like, options: D1StoreOptions = {}): SubscriptionStore => {
    const table = options.tableName ?? "lunora_push_subscriptions";

    if (!isBareIdentifier(table)) {
        throw new LunoraError("BAD_REQUEST", `@lunora/notify: d1SubscriptionStore tableName "${table}" is not a bare SQL identifier`);
    }

    let schemaReady: Promise<void> | undefined;

    const ensureSchema = (): Promise<void> => {
        if (schemaReady === undefined) {
            // Create the table, then the `user_id` / `kind` indexes that back the
            // two filters `list`/`broadcast` push down (D1 runs one statement per
            // `prepare`, so they are chained). Without them a `broadcast({ userId })`
            // or the Studio device list full-scans the table.
            schemaReady = database
                .prepare(
                    `CREATE TABLE IF NOT EXISTS ${table} (` +
                        "id TEXT PRIMARY KEY, kind TEXT NOT NULL, endpoint TEXT, p256dh TEXT, auth TEXT, token TEXT, " +
                        "user_id TEXT, metadata TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, last_status TEXT, last_error TEXT)",
                )
                .run()
                .then(() => database.prepare(`CREATE INDEX IF NOT EXISTS ${table}_user_id_idx ON ${table} (user_id)`).run())
                .then(() => database.prepare(`CREATE INDEX IF NOT EXISTS ${table}_kind_idx ON ${table} (kind)`).run())
                .then(() => undefined);

            schemaReady.catch(() => {
                schemaReady = undefined;
            });
        }

        return schemaReady;
    };

    const get = async (id: string): Promise<StoredSubscription | undefined> => {
        await ensureSchema();

        const row = await database.prepare(`SELECT * FROM ${table} WHERE id = ?1`).bind(id).first<Row>();

        return row === null ? undefined : rowToSubscription(row);
    };

    const put = async (subscription: StoredSubscription): Promise<StoredSubscription> => {
        await ensureSchema();

        // On re-register (a routine service-worker refresh) the upsert PRESERVES the
        // first-seen `created_at` AND the delivery status/error: `last_status` /
        // `last_error` are deliberately OMITTED from the `DO UPDATE SET` list so a
        // fresh registration (which carries no status) can't wipe the last known
        // delivery outcome — `markStatus` stays their only writer. They are still in
        // the INSERT column list so a brand-new row seeds them.
        //
        // The `DO UPDATE`'s own WHERE is the ownership predicate (see
        // `SubscriptionStore.put`): the update lands only on a row that is unowned or
        // already this user's. Unqualified `user_id` there is the CONFLICTING (stored)
        // row — qualified with the table name so it cannot read as the incoming value —
        // and `user_id = ?7` is never true for a NULL `?7`, so an anonymous register
        // cannot strip an owner either. One statement, not a get-then-write: between a
        // read that checks the owner and the upsert that acts on it, another
        // registration can replace the row.
        await database
            .prepare(
                `INSERT INTO ${table} (id, kind, endpoint, p256dh, auth, token, user_id, metadata, created_at, last_seen_at, last_status, last_error) ` +
                    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) " +
                    "ON CONFLICT(id) DO UPDATE SET kind = ?2, endpoint = ?3, p256dh = ?4, auth = ?5, token = ?6, user_id = ?7, metadata = ?8, last_seen_at = ?10 " +
                    `WHERE ${table}.user_id IS NULL OR ${table}.user_id = ?7`,
            )
            .bind(
                subscription.id,
                subscription.kind,
                subscription.endpoint ?? null,
                subscription.keys?.p256dh ?? null,
                subscription.keys?.auth ?? null,
                subscription.token ?? null,
                subscription.userId ?? null,
                // A `StoredSubscription.metadata` built via `normalizeRegisterInput`
                // has already round-tripped through `JSON.stringify` once at
                // validation time (see `validateMetadata`, NOTIFY-02), so this
                // re-serialisation of the same pure, unchanged object cannot throw
                // mid-write for a subscription that reached `register()` — only a
                // hand-built `StoredSubscription` bypassing normalize (a test, or a
                // caller writing directly to the store) could still supply a
                // non-serialisable value here.
                subscription.metadata === undefined ? null : JSON.stringify(subscription.metadata),
                subscription.createdAt,
                subscription.lastSeenAt,
                subscription.lastStatus ?? null,
                subscription.lastError ?? null,
            )
            .run();

        // Read back the ACTUAL stored row (not the incoming `subscription`, whose
        // `createdAt` is `Date.now()` and disagrees with the preserved value on a
        // re-register) so the caller sees the truthful record — matching the memory
        // store. A read-back rather than `RETURNING *` keeps the fake D1 slice simple
        // and works on any D1-like binding.
        const stored = await get(subscription.id);

        // A refused upsert is silent in SQL — the row is simply not updated — so the
        // read-back is also how the refusal is detected: the only way the stored owner
        // can differ from the one just written is the `DO UPDATE`'s WHERE having
        // rejected it. Throw rather than return the row: it is someone else's, and
        // `register` hands its return value (delivery keys included) back to the caller.
        const refusal = claimRefusal(stored, subscription);

        if (refusal !== undefined) {
            throw refusal;
        }

        // Evict the SAME device's legacy-prefix row (pre-`wp2_`/`fcm2_` 32-bit id).
        // Its PK differs from the canonical id, so the upsert above never touched it;
        // leaving it would make `broadcast` (no id filter) deliver to this device
        // twice forever. Idempotent — a no-op when the legacy row was never present.
        // The `!== subscription.id` guard keeps a (rare) put of a legacy-id row from
        // deleting the very row it just wrote.
        //
        // Owner-scoped for the same reason the upsert is: the legacy row is a
        // DIFFERENT primary key that the guarded upsert never sees, so an unscoped
        // delete here re-opened the whole hole one row over — register the victim's
        // endpoint under your own id and their (still-live) legacy row is removed.
        // The predicate is the CLAIM one (unowned, or already this user's), not
        // `deleteOwned`'s exact-match one: a device that registered anonymously under
        // the old scheme and signs in under the new one must still lose its legacy
        // row, or it is broadcast to twice forever.
        const legacyId = legacyIdFor(subscription);

        if (legacyId !== undefined && legacyId !== subscription.id) {
            const owner = subscription.userId ?? null;

            await (
                owner === null
                    ? database.prepare(`DELETE FROM ${table} WHERE id = ?1 AND user_id IS NULL`).bind(legacyId)
                    : database.prepare(`DELETE FROM ${table} WHERE id = ?1 AND (user_id IS NULL OR user_id = ?2)`).bind(legacyId, owner)
            ).run();
        }

        return stored ?? subscription;
    };

    const remove = async (id: string): Promise<void> => {
        await ensureSchema();

        await database.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id).run();
    };

    /**
     * One statement, so the owner predicate and the removal cannot be separated
     * by a re-registration. `RETURNING id` reports whether a row matched without
     * needing `run()`'s result metadata, which {@link D1PreparedLike} does not
     * expose.
     * @param id The subscription id.
     * @param userId The owner the row must carry, or `null` for unowned.
     * @returns `true` when a row was removed.
     */
    const removeOwned = async (id: string, userId: string | null): Promise<boolean> => {
        await ensureSchema();

        const statement =
            userId === null
                ? database.prepare(`DELETE FROM ${table} WHERE id = ?1 AND user_id IS NULL RETURNING id`).bind(id)
                : database.prepare(`DELETE FROM ${table} WHERE id = ?1 AND user_id = ?2 RETURNING id`).bind(id, userId);

        return (await statement.first<{ id: string }>()) !== null;
    };

    const list = async (filter?: SubscriptionFilter): Promise<StoredSubscription[]> => {
        await ensureSchema();

        const clauses: string[] = [];
        const bindings: unknown[] = [];

        if (filter?.kind !== undefined) {
            bindings.push(filter.kind);
            clauses.push(`kind = ?${bindings.length.toString()}`);
        }

        if (filter?.userId !== undefined) {
            if (filter.userId === null) {
                clauses.push("user_id IS NULL");
            } else {
                bindings.push(filter.userId);
                clauses.push(`user_id = ?${bindings.length.toString()}`);
            }
        }

        if (filter?.after !== undefined) {
            // Keyset pagination cursor: only rows strictly past the last id of the
            // previous page. Paired with `ORDER BY id ASC` below — see
            // `SubscriptionFilter.after`.
            bindings.push(filter.after);
            clauses.push(`id > ?${bindings.length.toString()}`);
        }

        const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
        // Deterministic ascending order by `id` is required for `after` to page
        // correctly (and for parity with the memory store's explicit sort) —
        // without it, D1/SQLite gives no ordering guarantee across pages.
        const orderBy = " ORDER BY id ASC";

        let limit = "";

        if (filter?.limit !== undefined && filter.limit > 0) {
            // Bind a truncated, non-negative integer so a huge audience never
            // materializes wholesale in the isolate.
            bindings.push(Math.trunc(filter.limit));
            limit = ` LIMIT ?${bindings.length.toString()}`;
        }

        const { results } = await database
            .prepare(`SELECT * FROM ${table}${where}${orderBy}${limit}`)
            .bind(...bindings)
            .all<Row>();

        return results.map((row) => rowToSubscription(row));
    };

    const markStatus = async (id: string, status: SubscriptionStatus, error?: string): Promise<void> => {
        await ensureSchema();

        await database
            .prepare(`UPDATE ${table} SET last_status = ?2, last_error = ?3, last_seen_at = ?4 WHERE id = ?1`)
            .bind(id, status, error ?? null, Date.now())
            .run();
    };

    return { delete: remove, deleteOwned: removeOwned, get, list, markStatus, put };
};

export type { D1Like, D1PreparedLike, D1StoreOptions };
export { d1SubscriptionStore };
