import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RateLimiter } from "../src/rate-limiter";
import { createMemoryStore, createSqlStore } from "../src/store";
import createSqliteSql from "./_helpers/node-sqlite";

describe("memory store", () => {
    it("round-trips and deletes values", async () => {
        expect.assertions(3);

        const store = createMemoryStore();

        expect(store.get("k")).toBeUndefined();

        await store.set("k", { ts: 5, value: 3 });

        expect(store.get("k")).toEqual({ ts: 5, value: 3 });

        await store.delete("k");

        expect(store.get("k")).toBeUndefined();
    });

    it("sweeps an expired entry written behind a NaN timestamp", async () => {
        expect.assertions(2);

        const store = createMemoryStore();

        await store.set("a", { ts: 100, value: 1 });
        await store.set("nan", { ts: Number.NaN, value: 1 });
        await store.set("old", { ts: 0, value: 1 });

        await store.sweep?.(50, 32);

        expect(store.get("old")).toBeUndefined();
        expect(store.get("a")).toBeDefined();
    });
});

describe("sql store (real node:sqlite)", () => {
    let harness: ReturnType<typeof createSqliteSql>;

    beforeEach(() => {
        harness = createSqliteSql();
    });

    afterEach(() => {
        harness.close();
    });

    it("persists fractional token-bucket values across reads", async () => {
        expect.assertions(1);

        const store = createSqlStore({ sql: harness.sql });

        await store.set("send:alice", { ts: 1234, value: 2.5 });

        expect(store.get("send:alice")).toEqual({ ts: 1234, value: 2.5 });
    });

    it("round-trips the sliding-window previous-window count", async () => {
        expect.assertions(1);

        const store = createSqlStore({ sql: harness.sql });

        await store.set("hits:bob", { prev: 7, ts: 1000, value: 3 });

        expect(store.get("hits:bob")).toEqual({ prev: 7, ts: 1000, value: 3 });
    });

    it("upserts on conflict and deletes", async () => {
        expect.assertions(3);

        const store = createSqlStore({ sql: harness.sql });

        await store.set("k", { ts: 1, value: 1 });

        expect(store.get("k")).toEqual({ ts: 1, value: 1 });

        await store.set("k", { ts: 2, value: 9 });

        expect(store.get("k")).toEqual({ ts: 2, value: 9 });

        await store.delete("k");

        expect(store.get("k")).toBeUndefined();
    });

    it("backs a RateLimiter end to end", async () => {
        expect.assertions(3);

        const clock = { now: 0 };
        const limiter = new RateLimiter({
            config: { send: { kind: "token bucket", period: 1000, rate: 3 } },
            now: () => clock.now,
            store: createSqlStore({ sql: harness.sql }),
        });

        await limiter.limit("send", { count: 3, key: "u1" });

        await expect(limiter.limit("send", { key: "u1" })).resolves.toMatchObject({ ok: false });

        // A fresh limiter sharing the same SQLite sees the persisted state.
        const reopened = new RateLimiter({
            config: { send: { kind: "token bucket", period: 1000, rate: 3 } },
            now: () => clock.now,
            store: createSqlStore({ sql: harness.sql }),
        });

        await expect(reopened.limit("send", { key: "u1" })).resolves.toMatchObject({ ok: false });

        clock.now = 1000;

        await expect(reopened.limit("send", { key: "u1" })).resolves.toMatchObject({ ok: true });
    });
});

// Calls started in the same tick all run up to their first `await` before any of
// them resumes. A synchronous store must therefore read and write a consume in one
// step: an `await` between the read and the write lets every call read the same
// empty prior, and a limit of 1 admits all of them.
describe("concurrent consumes through a synchronous store", () => {
    it.each(["memory", "sql"] as const)("%s store admits exactly one of ten for a limit of 1", async (kind) => {
        expect.assertions(1);

        const harness = createSqliteSql();

        try {
            const limiter = new RateLimiter({
                config: { login: { kind: "fixed window", period: 60_000, rate: 1 } },
                now: () => 0,
                store: kind === "memory" ? createMemoryStore() : createSqlStore({ sql: harness.sql }),
            });

            const statuses = await Promise.all(Array.from({ length: 10 }, async () => limiter.limit("login", { key: "u1" })));

            expect(statuses.filter((status) => status.ok)).toHaveLength(1);
        } finally {
            harness.close();
        }
    });
});

describe("sql store retention sweep (real node:sqlite)", () => {
    let harness: ReturnType<typeof createSqliteSql>;

    beforeEach(() => {
        harness = createSqliteSql();
    });

    afterEach(() => {
        harness.close();
    });

    const keys = (): string[] =>
        harness.sql
            .exec<{ k: string }>(`SELECT k FROM "_lunora_rate_limits" ORDER BY k`)
            .toArray()
            .map((row) => row.k);

    it("creates a partial index on ts that excludes debts", () => {
        expect.assertions(1);

        createSqlStore({ sql: harness.sql });

        expect(harness.sql.exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '_lunora_rate_limits_ts'`).toArray()).toEqual([
            { sql: expect.stringContaining("WHERE value >= 0") as string },
        ]);
    });

    it("deletes rows at or before the horizon and keeps rows inside it", async () => {
        expect.assertions(1);

        const store = createSqlStore({ sql: harness.sql });

        await store.set("old", { ts: 100, value: 1 });
        await store.set("edge", { ts: 500, value: 1 });
        await store.set("fresh", { ts: 900, value: 1 });

        await store.sweep?.(500, 32);

        expect(keys()).toEqual(["fresh"]);
    });

    it("keeps a reserved debt however old, and does not count it against the limit", async () => {
        expect.assertions(1);

        const store = createSqlStore({ sql: harness.sql });

        await store.set("debt", { ts: 1, value: -10 });
        await store.set("a", { ts: 100, value: 1 });
        await store.set("b", { ts: 200, value: 1 });

        await store.sweep?.(500, 1);

        expect(keys()).toEqual(["b", "debt"]);
    });

    it("deletes at most limit rows per call", async () => {
        expect.assertions(2);

        const store = createSqlStore({ sql: harness.sql });

        for (const index of [1, 2, 3, 4, 5]) {
            // eslint-disable-next-line no-await-in-loop -- sequential writes keep the fixture deterministic
            await store.set(`k${String(index)}`, { ts: index, value: 1 });
        }

        await store.sweep?.(500, 2);

        expect(keys()).toHaveLength(3);

        await store.sweep?.(500, 2);

        expect(keys()).toHaveLength(1);
    });

    it("keeps a key with a lone surrogate apart from its U+FFFD look-alike", async () => {
        // UTF-8 TEXT would store the lone surrogate as U+FFFD, so the two keys would share one budget.
        expect.assertions(2);

        const store = createSqlStore({ sql: harness.sql });

        await store.set("ip:a\uD800", { ts: 1, value: 1 });
        await store.set("ip:a\uFFFD", { ts: 2, value: 9 });

        expect(store.get("ip:a\uD800")).toStrictEqual({ ts: 1, value: 1 });
        expect(store.get("ip:a\uFFFD")).toStrictEqual({ ts: 2, value: 9 });
    });

    it("round-trips a key that starts with the escape marker", async () => {
        expect.assertions(2);

        const store = createSqlStore({ sql: harness.sql });

        await store.set("\uFFFFx", { ts: 1, value: 3 });

        expect(store.get("\uFFFFx")).toStrictEqual({ ts: 1, value: 3 });
        expect(store.get(`\uFFFF${JSON.stringify("\uFFFFx")}`)).toBeUndefined();
    });

    it("lets its owner sweep a key that had to be escaped", async () => {
        expect.assertions(2);

        const store = createSqlStore({ sql: harness.sql });

        await store.set("mine:\uD800", { ts: 1, value: 1 });
        await store.set("theirs:\uD800", { ts: 1, value: 1 });
        await store.sweep?.(500, 32, (k) => k.startsWith("mine:"));

        expect(store.get("mine:\uD800")).toBeUndefined();
        expect(store.get("theirs:\uD800")).toStrictEqual({ ts: 1, value: 1 });
    });

    it("sweeps a marker-prefixed row written before keys were escaped", async () => {
        expect.assertions(2);

        const store = createSqlStore({ sql: harness.sql });

        await store.set("warm", { ts: 1000, value: 1 });
        // A row from before escaping: its stored text starts with the marker but is not JSON.
        harness.sql.exec(`INSERT INTO "_lunora_rate_limits" (k, value, ts, prev) VALUES (?, 1, 1, NULL)`, "\uFFFFlegacy");

        const owned: string[] = [];

        await store.sweep?.(500, 32, (k) => {
            owned.push(k);

            return true;
        });

        expect(owned).toStrictEqual(["\uFFFFlegacy"]);
        expect(
            harness.sql
                .exec<{ k: string }>(`SELECT k FROM "_lunora_rate_limits"`)
                .toArray()
                .map((row) => row.k),
        ).toStrictEqual(["warm"]);
    });

    it("deletes only owned rows, in one DELETE however many expired", async () => {
        expect.assertions(2);

        const statements: string[] = [];
        const { exec } = harness.sql;
        const store = createSqlStore({
            sql: {
                exec: <Row = Record<string, unknown>>(query: string, ...params: unknown[]) => {
                    statements.push(query);

                    return exec<Row>(query, ...params);
                },
            },
        });

        for (const key of ["mine:a", "mine:b", "theirs:c", "mine:d"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential writes keep the fixture deterministic
            await store.set(key, { ts: 1, value: 1 });
        }

        statements.length = 0;
        await store.sweep?.(500, 32, (k) => k.startsWith("mine:"));

        expect(keys()).toEqual(["theirs:c"]);
        expect(statements.filter((query) => query.startsWith("DELETE"))).toHaveLength(1);
    });
});
