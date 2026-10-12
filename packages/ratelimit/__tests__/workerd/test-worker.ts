/**
 * Entry-point Worker and Durable Object for the `workerd` vitest project.
 *
 * `RateLimitDO` runs the rate limiter over three stores, each on real I/O:
 *
 * - `kv`: `createDbStore` over a `ctx.db`-shaped adapter on the DO's own KV
 * storage. This is the shard-local table case: every await between the limiter's
 * read and its write is a DO storage operation, so the input gate stays closed
 * across the whole consume.
 * - `d1`: `createDbStore` over the production `.global()` writer (`createD1CtxDb`)
 * on a D1 binding. A shard's `ctx.db` forwards a global table's reads and writes
 * to that writer, and a D1 call is network I/O, which does not hold the input gate.
 * - `sql`: `createSqlStore` over `storage.sql`, the control. Its `exec` is
 * synchronous, so a consume never yields to the event loop.
 *
 * No barrier, rendezvous or timer is injected anywhere. Concurrency comes only from
 * the test sending several RPCs at once.
 */
import type { D1Exec } from "@lunora/d1";
import { createD1CtxDb, runD1GlobalTableMigrations } from "@lunora/d1";
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import type { Id } from "@lunora/values";
import { DurableObject } from "cloudflare:workers";

import { RateLimiter } from "../../src/rate-limiter";
import type { RateLimitDb, SqlLike } from "../../src/store";
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

/** `where` against a stored row: plain equality, a `null` filter matching an absent field as SQL NULL does. */
const matchesWhere = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([field, value]) => (value === null ? row[field] === undefined || row[field] === null : row[field] === value));

/**
 * A `ctx.db`-shaped adapter over the DO's KV storage. A row is `row:<id>`, and the
 * `key` column is also indexed as `idx:<table>:<key>` -> id, so `findFirst()` by
 * key is two awaited storage reads, as an index lookup would be. Every await is a
 * DO storage operation, which holds the input gate: the shard-local table case.
 */
const kvDatabase = (storage: DurableObjectStorage): RateLimitDb => {
    const rowKey = (id: string): string => `row:${id}`;
    const indexKey = (table: string, key: unknown): string => `idx:${table}:${String(key)}`;

    return {
        delete: async (id) => {
            await storage.delete(rowKey(id));
        },
        findFirst: async (table, args) => {
            const id = await storage.get<string>(indexKey(table, args?.where?.["key"]));

            if (id === undefined) {
                return null;
            }

            return (await storage.get<Record<string, unknown>>(rowKey(id))) ?? null;
        },
        insert: async (table, document, options) => {
            const id = options?.clientId ?? `${table}/${crypto.randomUUID()}`;

            if ((await storage.get(rowKey(id))) !== undefined) {
                throw Object.assign(new Error(`unique constraint violation on "${table}"`), { code: "CONFLICT" });
            }

            await storage.put(rowKey(id), { ...document, _id: id });
            await storage.put(indexKey(table, document["key"]), id);

            return id as Id<typeof table>;
        },
        patchIf: async (_table, id, args) => {
            const row = await storage.get<Record<string, unknown>>(rowKey(id));

            if (row === undefined) {
                return { applied: false, doc: null };
            }

            if (!matchesWhere(row, args.where)) {
                return { applied: false, doc: row };
            }

            const next = { ...row, ...args.patch };

            await storage.put(rowKey(id), next);

            return { applied: true, doc: next };
        },
    };
};

const column = (kind: string, meta: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true }, ...meta }, kind };
};

/**
 * The `.global()` table the `d1` store writes, as the schema declares it. The key
 * index is not UNIQUE, matching a declared `.index("by_key", ["key"])`.
 */
const D1_SCHEMA: SchemaLike = {
    tables: {
        [D1_TABLE]: {
            indexes: [{ fields: ["key"], name: "by_key" }],
            shape: {
                key: column("string"),
                prev: column("optional", { inner: column("number") }),
                ts: column("number"),
                value: column("number"),
            },
            shardMode: { kind: "global" },
        },
    },
};

/** The ctx-db exec over a real D1 binding. */
const d1Exec = (database: D1Database): D1Exec => {
    return {
        all: async (query, parameters) => {
            const result = await database
                .prepare(query)
                .bind(...parameters)
                .all();

            return result.results;
        },
        run: async (query, parameters) => {
            const result = await database
                .prepare(query)
                .bind(...parameters)
                .run();

            return { rowsAffected: result.meta.changes };
        },
    };
};

/**
 * The production `.global()` writer over D1: the same `createD1CtxDb` a shard's
 * `ctx.db` forwards a global table's reads and writes to.
 */
const d1Database = (database: D1Database): RateLimitDb =>
    createD1CtxDb({ exec: d1Exec(database), idGenerator: () => crypto.randomUUID(), schema: D1_SCHEMA }) as unknown as RateLimitDb;

class RateLimitDO extends DurableObject<Env> {
    readonly #stores = new Map<StoreKind, RateLimitStore>();

    #schema: Promise<unknown> | undefined;

    /** Creates the D1 table once; every consume awaits it before its first read. */
    async #ensureSchema(): Promise<void> {
        this.#schema ??= runD1GlobalTableMigrations(d1Exec(this.env.GLOBAL_DB), D1_SCHEMA);

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
        // Only the D1 path needs the schema.
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

        const result = await this.env.GLOBAL_DB.prepare(`SELECT COUNT(*) AS n FROM "${D1_TABLE}" WHERE "${D1_TABLE}"."key" = ?`)
            .bind(`login:${key}`)
            .first<{ n: number }>();

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
