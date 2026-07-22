import { LunoraError } from "@lunora/errors";

import type { StoredSubscription, SubscriptionFilter, SubscriptionKind, SubscriptionStatus, SubscriptionStore } from "../types";

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

const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/u;

/**
 * A D1-backed {@link SubscriptionStore}. Edge-safe (D1 is a Worker binding). The
 * backing table is created lazily on first use (`CREATE TABLE IF NOT EXISTS`), so
 * no migration step is required for the subscription table itself.
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

    if (!IDENTIFIER_PATTERN.test(table)) {
        throw new LunoraError("BAD_REQUEST", `@lunora/notify: d1SubscriptionStore tableName "${table}" is not a bare SQL identifier`);
    }

    let schemaReady: Promise<void> | undefined;

    const ensureSchema = (): Promise<void> => {
        if (schemaReady === undefined) {
            schemaReady = database
                .prepare(
                    `CREATE TABLE IF NOT EXISTS ${table} (` +
                        "id TEXT PRIMARY KEY, kind TEXT NOT NULL, endpoint TEXT, p256dh TEXT, auth TEXT, token TEXT, " +
                        "user_id TEXT, metadata TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, last_status TEXT, last_error TEXT)",
                )
                .run()
                .then(() => undefined);

            schemaReady.catch(() => {
                schemaReady = undefined;
            });
        }

        return schemaReady;
    };

    const put = async (subscription: StoredSubscription): Promise<StoredSubscription> => {
        await ensureSchema();

        // Preserve the original createdAt on re-register (upsert keeps the first-seen time).
        await database
            .prepare(
                `INSERT INTO ${table} (id, kind, endpoint, p256dh, auth, token, user_id, metadata, created_at, last_seen_at, last_status, last_error) ` +
                    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) " +
                    "ON CONFLICT(id) DO UPDATE SET kind = ?2, endpoint = ?3, p256dh = ?4, auth = ?5, token = ?6, user_id = ?7, metadata = ?8, last_seen_at = ?10, last_status = ?11, last_error = ?12",
            )
            .bind(
                subscription.id,
                subscription.kind,
                subscription.endpoint ?? null,
                subscription.keys?.p256dh ?? null,
                subscription.keys?.auth ?? null,
                subscription.token ?? null,
                subscription.userId ?? null,
                subscription.metadata === undefined ? null : JSON.stringify(subscription.metadata),
                subscription.createdAt,
                subscription.lastSeenAt,
                subscription.lastStatus ?? null,
                subscription.lastError ?? null,
            )
            .run();

        return subscription;
    };

    const get = async (id: string): Promise<StoredSubscription | undefined> => {
        await ensureSchema();

        const row = await database.prepare(`SELECT * FROM ${table} WHERE id = ?1`).bind(id).first<Row>();

        return row === null ? undefined : rowToSubscription(row);
    };

    const remove = async (id: string): Promise<void> => {
        await ensureSchema();

        await database.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id).run();
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
            bindings.push(filter.userId);
            clauses.push(filter.userId === null ? "user_id IS NULL" : `user_id = ?${bindings.length.toString()}`);

            if (filter.userId === null) {
                bindings.pop();
            }
        }

        const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
        const { results } = await database
            .prepare(`SELECT * FROM ${table}${where}`)
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

    return { delete: remove, get, list, markStatus, put };
};

export type { D1Like, D1PreparedLike, D1StoreOptions };
export { d1SubscriptionStore };
