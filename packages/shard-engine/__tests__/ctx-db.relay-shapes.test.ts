/**
 * The relay-shape registry's persistence round-trip.
 *
 * The registry is what an owner rehydrates from after an eviction, and each row
 * carries the `identity` claim set RLS resolves against — so a value that does
 * not survive the round trip with its type intact is an authorization bug, not a
 * formatting one.
 */
import { describe, expect, it } from "vitest";

import type { RelayShapeRow } from "../src/ctx-db-relay-shapes";
import { migrateRelayShapes, readRelayShapes, writeRelayShape } from "../src/ctx-db-relay-shapes";
import createSqliteExec from "./_helpers/node-sqlite";

const seed = (row: RelayShapeRow): RelayShapeRow | undefined => {
    const harness = createSqliteExec();

    try {
        migrateRelayShapes(harness.sql);
        writeRelayShape(harness.sql, row);

        return readRelayShapes(harness.sql)[0];
    } finally {
        harness.close();
    }
};

describe("relay shape persistence", () => {
    it("round-trips a bigint identity claim, which bare JSON cannot even write", () => {
        expect.assertions(3);

        // `JSON.stringify` throws outright on a bigint, so before the fix this
        // failed on the seed path rather than producing a wrong value.
        // A PROXY row (relayIndex + connectionId), which is the only shape that
        // carries identity: `OwnerRelay.relayShapes` hydrates a cohort row into a
        // `CohortShapeEntry` and discards identity entirely, so seeding a cohort
        // row here would pin the codec on a shape production never stores it in.
        const stored = seed({
            args: { since: 1n },
            connectionId: "conn_1",
            cursor: 0,
            identity: { identity: { orgId: 42n }, userId: "user_1" },
            key: "0:conn_1:sub_1",
            name: "messages:list",
            relayIndex: 0,
        });

        expect(stored?.identity).toStrictEqual({ identity: { orgId: 42n }, userId: "user_1" });
        expect(stored?.args).toStrictEqual({ since: 1n });
        // The proxy addressing survives too — an owner rehydrating the registry
        // needs it to route the delta back to the one connection it belongs to.
        expect({ connectionId: stored?.connectionId, relayIndex: stored?.relayIndex }).toStrictEqual({ connectionId: "conn_1", relayIndex: 0 });
    });

    it("keeps a Date identity claim a Date rather than a string", () => {
        expect.assertions(1);

        // The quiet half: bare JSON round-trips a Date to a string, so a
        // rehydrated shape resolved RLS under a differently-typed claim than the
        // live registry used — no error, just a different answer.
        const issuedAt = new Date("2026-01-02T03:04:05.000Z");
        const stored = seed({
            args: {},
            connectionId: "conn_2",
            cursor: 0,
            identity: { identity: { issuedAt }, userId: "user_1" },
            key: "1:conn_2:sub_2",
            name: "messages:list",
            relayIndex: 1,
        });

        expect(stored?.identity).toStrictEqual({ identity: { issuedAt }, userId: "user_1" });
    });

    it("reads a registry written before this build, and keeps writing to it", () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        try {
            harness.sql.exec(
                "CREATE TABLE __lunora_relay_shapes (key TEXT PRIMARY KEY, relay_idx INTEGER, connection_id TEXT, name TEXT NOT NULL, args TEXT NOT NULL, identity TEXT NOT NULL, cursor INTEGER NOT NULL)",
            );
            harness.sql.exec("INSERT INTO __lunora_relay_shapes VALUES ('old', NULL, NULL, 'feed', '{}', '{}', 3)");

            migrateRelayShapes(harness.sql);
            writeRelayShape(harness.sql, { args: {}, cursor: 4, key: "new", name: "feed" });

            const keys = readRelayShapes(harness.sql).map((row) => row.key);

            expect(new Set(keys)).toStrictEqual(new Set(["new", "old"]));
            expect(readRelayShapes(harness.sql).find((row) => row.key === "old")?.cursor).toBe(3);
        } finally {
            harness.close();
        }
    });
});
