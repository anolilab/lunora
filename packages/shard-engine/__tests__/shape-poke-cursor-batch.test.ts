import { describe, expect, it } from "vitest";

import { migrateShapePokeCursor, minShapePokeCursor, readShapePokeCursor, writeShapePokeCursors } from "../src/ctx-db-shape-poke-cursor";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * One write-flush pokes every subscribed socket, and each delivered poke used to
 * record its baseline with its own upsert — 500 statements for one write. These
 * pin the batched writer that replaced them, with the chunk boundary as the case
 * that matters: workerd refuses a statement binding more than 100 parameters, and
 * three columns per row puts the limit at 33 rows, so anything past that has to
 * split or the fan-out fails at runtime rather than in a type.
 */

const rows = (count: number, cursor: number): { connectionId: string; cursor: number; subId: string }[] =>
    Array.from({ length: count }, (_value, index) => {
        return { connectionId: `conn${String(index)}`, cursor, subId: "s1" };
    });

describe("writeShapePokeCursors", () => {
    it("persists every baseline past the bound-parameter chunk boundary", () => {
        expect.hasAssertions();

        // 500 is the fan-out size the bench models, and ~15 chunks at 33 rows.
        const harness = createSqliteExec();

        migrateShapePokeCursor(harness.sql);
        writeShapePokeCursors(harness.sql, rows(500, 42));

        expect(readShapePokeCursor(harness.sql, "conn0", "s1")).toBe(42);
        expect(readShapePokeCursor(harness.sql, "conn32", "s1")).toBe(42);
        // Straddles the first chunk boundary — the row a naive single statement
        // would have dropped, and the one an off-by-one chunker loses.
        expect(readShapePokeCursor(harness.sql, "conn33", "s1")).toBe(42);
        expect(readShapePokeCursor(harness.sql, "conn499", "s1")).toBe(42);
        expect(harness.raw(`SELECT COUNT(*) AS n FROM "__shape_poke_cursor"`)[0]?.["n"]).toBe(500);
    });

    it("upserts rather than duplicating, so a later flush advances the cursor", () => {
        expect.assertions(2);

        // The `(connection_id, sub_id)` primary key is what keeps one row per
        // subscription; a batched INSERT without the conflict clause would throw
        // on the second flush instead of advancing.
        const harness = createSqliteExec();

        migrateShapePokeCursor(harness.sql);
        writeShapePokeCursors(harness.sql, rows(50, 10));
        writeShapePokeCursors(harness.sql, rows(50, 99));

        expect(readShapePokeCursor(harness.sql, "conn40", "s1")).toBe(99);
        expect(harness.raw(`SELECT COUNT(*) AS n FROM "__shape_poke_cursor"`)[0]?.["n"]).toBe(50);
    });

    it("keeps the retention floor honest across a batch", () => {
        expect.assertions(1);

        // `minShapePokeCursor` is the op-log sweep's input: it must not compact a
        // range a live subscription has yet to be poked through. A batch that lost
        // its lowest row would raise the floor and let the sweep delete it.
        const harness = createSqliteExec();

        migrateShapePokeCursor(harness.sql);
        writeShapePokeCursors(harness.sql, [
            ...rows(40, 500),
            { connectionId: "laggard", cursor: 7, subId: "s1" },
            ...rows(40, 500).map((row) => {
                return { ...row, subId: "s2" };
            }),
        ]);

        expect(minShapePokeCursor(harness.sql)).toBe(7);
    });

    it("is a no-op for an empty batch", () => {
        expect.assertions(1);

        const harness = createSqliteExec();

        migrateShapePokeCursor(harness.sql);
        writeShapePokeCursors(harness.sql, []);

        expect(harness.raw(`SELECT COUNT(*) AS n FROM "__shape_poke_cursor"`)[0]?.["n"]).toBe(0);
    });
});
