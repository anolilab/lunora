import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { RateLimiter } from "../src/rate-limiter.js";
import { createMemoryStore, createSqlStore } from "../src/store.js";
import { createSqliteSql } from "./_helpers/node-sqlite.js";

describe("memory store", () => {
    test("round-trips and deletes values", () => {
        const store = createMemoryStore();

        expect(store.get("k")).toBeUndefined();

        store.set("k", { ts: 5, value: 3 });

        expect(store.get("k")).toEqual({ ts: 5, value: 3 });

        store.delete("k");

        expect(store.get("k")).toBeUndefined();
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

    test("persists fractional token-bucket values across reads", () => {
        const store = createSqlStore({ sql: harness.sql });

        store.set("send:alice", { ts: 1234, value: 2.5 });

        expect(store.get("send:alice")).toEqual({ ts: 1234, value: 2.5 });
    });

    test("round-trips the sliding-window previous-window count", () => {
        const store = createSqlStore({ sql: harness.sql });

        store.set("hits:bob", { prev: 7, ts: 1000, value: 3 });

        expect(store.get("hits:bob")).toEqual({ prev: 7, ts: 1000, value: 3 });
    });

    test("upserts on conflict and deletes", () => {
        const store = createSqlStore({ sql: harness.sql });

        store.set("k", { ts: 1, value: 1 });

        expect(store.get("k")).toEqual({ ts: 1, value: 1 });

        store.set("k", { ts: 2, value: 9 });

        expect(store.get("k")).toEqual({ ts: 2, value: 9 });

        store.delete("k");

        expect(store.get("k")).toBeUndefined();
    });

    test("backs a RateLimiter end to end", async () => {
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
