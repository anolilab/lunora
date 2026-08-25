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
        expect.assertions(2);

        // `JSON.stringify` throws outright on a bigint, so before the fix this
        // failed on the seed path rather than producing a wrong value.
        const stored = seed({
            args: { since: 1n },
            cursor: 0,
            identity: { identity: { orgId: 42n }, userId: "user_1" },
            key: "k1",
            name: "messages:list",
        });

        expect(stored?.identity).toStrictEqual({ identity: { orgId: 42n }, userId: "user_1" });
        expect(stored?.args).toStrictEqual({ since: 1n });
    });

    it("keeps a Date identity claim a Date rather than a string", () => {
        expect.assertions(1);

        // The quiet half: bare JSON round-trips a Date to a string, so a
        // rehydrated shape resolved RLS under a differently-typed claim than the
        // live registry used — no error, just a different answer.
        const issuedAt = new Date("2026-01-02T03:04:05.000Z");
        const stored = seed({
            args: {},
            cursor: 0,
            identity: { identity: { issuedAt }, userId: "user_1" },
            key: "k2",
            name: "messages:list",
        });

        expect(stored?.identity).toStrictEqual({ identity: { issuedAt }, userId: "user_1" });
    });
});
