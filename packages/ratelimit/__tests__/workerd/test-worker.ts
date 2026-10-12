/**
 * Entry-point Worker and Durable Object for the `workerd` vitest project.
 *
 * `RateLimitDO` runs the rate limiter over three stores, each on real I/O:
 *
 * - `kv`: `createDbStore` over a `ctx.db`-shaped adapter on the DO's own KV
 * storage. This is the shard-local table case: every await between the limiter's
 * read and its write is a DO storage operation, so the input gate stays closed
 * across the whole consume.
 * - `d1`: `createDbStore` over a `ctx.db`-shaped adapter on a D1 binding. This is
 * the `.global()` table case: a shard's `ctx.db` routes a global table's reads and
 * writes to D1, and a D1 call is network I/O, which does not hold the input gate.
 * - `sql`: `createSqlStore` over `storage.sql`, the control. Its `exec` is
 * synchronous, so a consume never yields to the event loop.
 *
 * No barrier, rendezvous or timer is injected anywhere. Concurrency comes only from
 * the test sending several RPCs at once.
 */
import type { Id } from "@lunora/values";
import { DurableObject } from "cloudflare:workers";

import { RateLimiter } from "../../src/rate-limiter";
import type { RateLimitDb, RateLimitDbIndexRange, RateLimitDbQuery, SqlLike } from "../../src/store";
import { createDbStore, createSqlStore } from "../../src/store";
import type { RateLimitConfigMap, RateLimitStatus, RateLimitStore } from "../../src/types";

interface Env {
    GLOBAL_DB: D1Database;
    RATE_LIMIT_DO: DurableObjectNamespace<RateLimitDO>;
}

const NOW = 1_700_000_000_000;
const CONFIG = {
    login: { kind: "fixed window", period: 60_000, rate: 1 },
} satisfies RateLimitConfigMap<"login">;
const D1_TABLE = "rateLimits";

type StoreKind = "d1" | "kv" | "sql";

/** Collects the `eq()` condition of an indexed lookup; only `eq` is used by the store. */
const indexRange = (): { builder: RateLimitDbIndexRange; condition: { value?: unknown } } => {
    const condition: { value?: unknown } = {};
    const builder: RateLimitDbIndexRange = {
        eq: (_field, value) => {
            condition.value = value;

            return builder;
        },
        gt: () => builder,
        gte: () => builder,
        lt: () => builder,
        lte: () => builder,
    };

    return { builder, condition };
};

/**
 * A `ctx.db`-shaped adapter over the DO's KV storage. A row is `row:<id>`, and the
 * `key` column is also indexed as `idx:<table>:<key>` -> id, so `first()` after an
 * indexed `eq()` is two awaited storage reads, as an index lookup would be.
 */
const kvDatabase = (storage: DurableObjectStorage): RateLimitDb => {
    const rowKey = (id: string): string => `row:${id}`;
    const indexKey = (table: string, key: unknown): string => `idx:${table}:${String(key)}`;

    const query = (table: string): RateLimitDbQuery => {
        const { builder, condition } = indexRange();
        const self: RateLimitDbQuery = {
            first: async () => {
                const id = await storage.get<string>(indexKey(table, condition.value));

                if (id === undefined) {
                    return null;
                }

                return (await storage.get<Record<string, unknown>>(rowKey(id))) ?? null;
            },
            withIndex: (_index, range) => {
                range(builder);

                return self;
            },
        };

        return self;
    };

    return {
        delete: async (id) => {
            await storage.delete(rowKey(id));
        },
        insert: async (table, document) => {
            const id = `${table}/${crypto.randomUUID()}`;

            await storage.put(rowKey(id), { ...document, _id: id });
            await storage.put(indexKey(table, document["key"]), id);

            return id as Id<typeof table>;
        },
        patch: async (id, patch) => {
            const row = (await storage.get<Record<string, unknown>>(rowKey(id))) ?? {};

            await storage.put(rowKey(id), { ...row, ...patch });
        },
        query,
    };
};

/**
 * A `ctx.db`-shaped adapter over D1, standing in for a `.global()` table. The key
 * index is not UNIQUE, matching a declared `.index("by_key", ["key"])`.
 */
const d1Database = (database: D1Database): RateLimitDb => {
    const query = (table: string): RateLimitDbQuery => {
        const { builder, condition } = indexRange();
        const self: RateLimitDbQuery = {
            first: async () => {
                const row = await database
                    .prepare(`SELECT id AS _id, key, ts, value, prev FROM "${table}" WHERE key = ? LIMIT 1`)
                    .bind(condition.value)
                    .first();

                return row ?? null;
            },
            withIndex: (_index, range) => {
                range(builder);

                return self;
            },
        };

        return self;
    };

    return {
        delete: async (id) => {
            await database.prepare(`DELETE FROM "${D1_TABLE}" WHERE id = ?`).bind(id).run();
        },
        insert: async (table, document) => {
            const id = `${table}/${crypto.randomUUID()}`;

            await database
                .prepare(`INSERT INTO "${table}" (id, key, ts, value, prev) VALUES (?, ?, ?, ?, ?)`)
                .bind(id, document["key"], document["ts"], document["value"], document["prev"] ?? null)
                .run();

            return id as Id<typeof table>;
        },
        patch: async (id, patch) => {
            await database
                .prepare(`UPDATE "${D1_TABLE}" SET ts = ?, value = ?, prev = ? WHERE id = ?`)
                .bind(patch["ts"], patch["value"], patch["prev"] ?? null, id)
                .run();
        },
        query,
    };
};

class RateLimitDO extends DurableObject<Env> {
    readonly #stores = new Map<StoreKind, RateLimitStore>();

    #schema: Promise<unknown> | undefined;

    /** Creates the D1 table once; every consume awaits it before its first read. */
    async #ensureSchema(): Promise<void> {
        this.#schema ??= this.env.GLOBAL_DB.batch([
            this.env.GLOBAL_DB.prepare(
                `CREATE TABLE IF NOT EXISTS "${D1_TABLE}" (id TEXT PRIMARY KEY, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, prev REAL)`,
            ),
            this.env.GLOBAL_DB.prepare(`CREATE INDEX IF NOT EXISTS "${D1_TABLE}_by_key" ON "${D1_TABLE}" (key)`),
        ]);

        await this.#schema;
    }

    #store(kind: StoreKind): RateLimitStore {
        const cached = this.#stores.get(kind);

        if (cached) {
            return cached;
        }

        const { storage } = this.ctx;
        let store: RateLimitStore;

        if (kind === "kv") {
            store = createDbStore({ db: kvDatabase(storage) });
        } else if (kind === "d1") {
            store = createDbStore({ db: d1Database(this.env.GLOBAL_DB) });
        } else {
            // `SqlLike.exec` is generic in its row type and workerd's `SqlStorage` is not,
            // so the real binding needs a cast to meet the projection. Runtime shape matches.
            store = createSqlStore({ sql: storage.sql as unknown as SqlLike });
        }

        this.#stores.set(kind, store);

        return store;
    }

    /**
     * One `limit("login", { key })` through the chosen store, as a handler does it:
     * a fresh store and limiter per call, so no in-memory state is shared between
     * concurrent consumes.
     */
    public async consume(kind: StoreKind, key: string): Promise<RateLimitStatus> {
        // Only the D1 path awaits the schema. Concurrent consumes woken by one shared
        // promise resume in the same microtask drain and interleave at every `await`,
        // which would put a lost update on the SQL control that production never adds.
        if (kind === "d1") {
            await this.#ensureSchema();
        }

        const fresh: RateLimitStore =
            kind === "sql" ? this.#store("sql") : createDbStore({ db: kind === "kv" ? kvDatabase(this.ctx.storage) : d1Database(this.env.GLOBAL_DB) });

        return new RateLimiter({ config: CONFIG, now: () => NOW, store: fresh }).limit("login", { key });
    }

    /** Rows the database store wrote for `login:<key>`. */
    public async rowCount(kind: "d1" | "kv", key: string): Promise<number> {
        await this.#ensureSchema();

        if (kind === "kv") {
            const rows = await this.ctx.storage.list<Record<string, unknown>>({ prefix: "row:" });

            return [...rows.values()].filter((row) => row["key"] === `login:${key}`).length;
        }

        const result = await this.env.GLOBAL_DB.prepare(`SELECT COUNT(*) AS n FROM "${D1_TABLE}" WHERE key = ?`).bind(`login:${key}`).first<{ n: number }>();

        return result?.n ?? 0;
    }
}

const testWorker = {
    fetch(): Response {
        return new Response("ratelimit-test-worker", { status: 200 });
    },
};

export type { Env, StoreKind };
export { RateLimitDO };
export default testWorker;
