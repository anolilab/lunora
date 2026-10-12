import { DatabaseSync } from "node:sqlite";

import type { D1Exec } from "@lunora/d1";
import { createD1CtxDb, runD1GlobalTableMigrations } from "@lunora/d1";
import type { SchemaLike, SqlCursor, SqlExec, ValidatorLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RateLimiter } from "../src/rate-limiter";
import type { RateLimitDb } from "../src/store";
import { createDbStore } from "../src/store";
import type { RateLimitConfigMap } from "../src/types";

/**
 * `createDbStore` over the two production `ctx.db` writers, each on a real
 * `node:sqlite` database: the shard engine (a shard-local table, stored as a JSON
 * document) and the `.global()` store core as `@lunora/d1` binds it (real columns).
 * The fake in `db-store.test.ts` decides what "the row still matches" means for
 * itself; these decide it in SQL, which is where a float that does not survive the
 * round trip would make every conditional write miss.
 */

const column = (kind: string, meta: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true }, ...meta }, kind };
};

const table = (global: boolean): SchemaLike => {
    return {
        tables: {
            rateLimits: {
                indexes: [{ fields: ["key"], name: "by_key" }],
                shape: { key: column("string"), prev: column("optional", { inner: column("number") }), ts: column("number"), value: column("number") },
                ...(global ? { shardMode: { kind: "global" as const } } : {}),
            },
        },
    };
};

const shardExec = (database: DatabaseSync): SqlExec => {
    return {
        exec: <Row = Record<string, unknown>>(query: string, ...params: unknown[]): SqlCursor<Row> => {
            const rows = database.prepare(query).all(...(params as never[])) as Row[];

            return {
                one: () => rows[0] as Row,
                [Symbol.iterator]: () => rows[Symbol.iterator](),
                toArray: () => rows,
            };
        },
    };
};

const d1Exec = (database: DatabaseSync): D1Exec => {
    return {
        all: async (query, parameters) => database.prepare(query).all(...(parameters as never[])),
        run: async (query, parameters) => {
            return { rowsAffected: Number(database.prepare(query).run(...(parameters as never[])).changes) };
        },
    };
};

type Engine = "global (sql-store / D1)" | "shard-local";

const writerFor = async (engine: Engine, database: DatabaseSync): Promise<RateLimitDb> => {
    if (engine === "shard-local") {
        const sql = shardExec(database);
        const schema = table(false);

        runShardMigrations(sql, schema);

        return createShardCtxDb({ schema, sql }) as unknown as RateLimitDb;
    }

    const schema = table(true);

    await runD1GlobalTableMigrations(d1Exec(database), schema);

    return createD1CtxDb({ exec: d1Exec(database), idGenerator: () => crypto.randomUUID(), schema }) as unknown as RateLimitDb;
};

const rowsFor = (database: DatabaseSync, engine: Engine, key: string): number => {
    const query =
        engine === "shard-local"
            ? `SELECT COUNT(*) AS n FROM "rateLimits" WHERE json_extract(__doc__, '$.key') = ?`
            : `SELECT COUNT(*) AS n FROM "rateLimits" WHERE "rateLimits"."key" = ?`;

    return (database.prepare(query).get(key) as { n: number }).n;
};

describe.each<Engine>(["shard-local", "global (sql-store / D1)"])("createDbStore over the %s writer", (engine) => {
    let database: DatabaseSync;

    beforeEach(() => {
        database = new DatabaseSync(":memory:");
    });

    afterEach(() => {
        database.close();
    });

    it("admits one of ten concurrent consumes on a limit of 1 and keeps one row", async () => {
        expect.assertions(2);

        const db = await writerFor(engine, database);
        const config = { login: { kind: "fixed window", period: 60_000, rate: 1 } } satisfies RateLimitConfigMap<"login">;
        const statuses = await Promise.all(
            Array.from({ length: 10 }, async () => new RateLimiter({ config, now: () => 0, store: createDbStore({ db }) }).limit("login", { key: "u1" })),
        );

        expect(statuses.filter((status) => status.ok)).toHaveLength(1);
        expect(rowsFor(database, engine, "login:u1")).toBe(1);
    });

    it("matches a fractional token-bucket value it stored, so the next consume writes", async () => {
        expect.assertions(4);

        const db = await writerFor(engine, database);
        const clock = { now: 0 };
        const limiter = new RateLimiter({
            config: { send: { kind: "token bucket", period: 1000, rate: 3 } },
            now: () => clock.now,
            store: createDbStore({ db }),
        });

        await expect(limiter.limit("send", { count: 3 })).resolves.toMatchObject({ ok: true });

        // 433 ms refill 1.299 tokens; one consume leaves a fraction that is not a short decimal.
        clock.now = 433;

        await expect(limiter.limit("send")).resolves.toMatchObject({ ok: true });

        // The stored fraction must compare equal to what was read back, or this write
        // would miss every attempt and come back as a contention refusal.
        clock.now = 800;

        await expect(limiter.limit("send")).resolves.toMatchObject({ ok: true });
        await expect(limiter.getValue("send")).resolves.toMatchObject({ value: expect.closeTo(0.4, 9) });
    });

    it("resets a key and starts it over", async () => {
        expect.assertions(3);

        const db = await writerFor(engine, database);
        const limiter = new RateLimiter({ config: { send: { kind: "fixed window", period: 60_000, rate: 1 } }, now: () => 0, store: createDbStore({ db }) });

        await expect(limiter.limit("send", { key: "u1" })).resolves.toMatchObject({ ok: true });

        await limiter.reset("send", { key: "u1" });

        await expect(limiter.limit("send", { key: "u1" })).resolves.toMatchObject({ ok: true });
        expect(rowsFor(database, engine, "send:u1")).toBe(1);
    });
});
