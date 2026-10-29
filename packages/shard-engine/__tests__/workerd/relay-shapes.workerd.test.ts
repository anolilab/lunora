/**
 * The relay-shape registry over a real Durable Object's `state.storage.sql`.
 *
 * `../ctx-db.relay-shapes.test.ts` runs the same statements on `node:sqlite`, whose
 * SQLite differs from workerd's. The registry is what an evicted owner rehydrates
 * from, so the round trip has to hold on the engine that actually stores it.
 */
import { aroundEach, beforeEach, describe, expect, it } from "vitest";

import { migrateRelayShapes, readRelayShapes, writeRelayShape, writeRelayShapeCursor } from "../../src/ctx-db-relay-shapes";
import type { SqlHarness } from "../_helpers/sql-harness";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);

let harness: SqlHarness;

describe("relay-shape registry on workerd SQLite", () => {
    beforeEach(() => {
        harness = createWorkerdExec();
        migrateRelayShapes(harness.sql);
    });

    it("rehydrates a cohort and a proxy row, including a bigint argument and identity claim", () => {
        expect.assertions(2);

        writeRelayShape(harness.sql, { args: { room: "lobby" }, cursor: 7, key: "cohort", name: "messages:list" });
        writeRelayShape(harness.sql, {
            args: { limit: 5n },
            connectionId: "conn_1",
            cursor: 9,
            identity: { identity: { seats: 3n }, userId: "user_1" },
            key: "2:conn_1:sub_1",
            name: "messages:list",
            relayIndex: 2,
        });

        const byKey = new Map(readRelayShapes(harness.sql).map((row) => [row.key, row]));

        expect(byKey.get("cohort")).toMatchObject({ args: { room: "lobby" }, cursor: 7, name: "messages:list" });
        expect(byKey.get("2:conn_1:sub_1")).toMatchObject({
            args: { limit: 5n },
            cursor: 9,
            identity: { identity: { seats: 3n }, userId: "user_1" },
            relayIndex: 2,
        });
    });

    it("moves a cursor without rewriting the row, and an upsert keeps one row per key", () => {
        expect.assertions(2);

        writeRelayShape(harness.sql, { args: {}, cursor: 1, key: "cohort", name: "feed" });
        writeRelayShapeCursor(harness.sql, "cohort", 4);
        writeRelayShape(harness.sql, { args: {}, cursor: 5, key: "cohort", name: "feed" });

        const rows = readRelayShapes(harness.sql);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.cursor).toBe(5);
    });
});
