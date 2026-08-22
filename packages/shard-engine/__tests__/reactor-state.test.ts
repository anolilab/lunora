import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listReactorStates, migrateReactorState, reactorNeedsRun, readReactorState, writeReactorState } from "../src/reactor-state";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The `__reactor_state` baseline: what each `onQueryChange` reactor saw last.
 *
 * Every case here is really one property — **the failure direction is always
 * "run again", never "skip"**. A missing row, an unparseable footprint, a
 * renamed reactor: each degrades to a redundant run. There is deliberately no
 * state that suppresses a reactor that should have fired, because that failure
 * is silent and permanent while a redundant run costs one query.
 */
let harness: ReturnType<typeof createSqliteExec>;

describe("reactor state", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        migrateReactorState(harness.sql);
    });

    afterEach(() => {
        harness.close();
    });

    it("reads undefined for a reactor that has never run", () => {
        expect.assertions(1);

        expect(readReactorState(harness.sql, "reactors:dispatch")).toBeUndefined();
    });

    it("round-trips the digest and footprint", () => {
        expect.assertions(2);

        writeReactorState(harness.sql, "reactors:dispatch", { digest: "abc123", now: 1_700_000_000_000, result: "ran", tables: ["orders", "desks"] });

        const state = readReactorState(harness.sql, "reactors:dispatch");

        expect(state?.digest).toBe("abc123");
        expect(state?.tables).toStrictEqual(["orders", "desks"]);
    });

    it("replaces the baseline on a later run rather than accumulating rows", () => {
        expect.assertions(2);

        writeReactorState(harness.sql, "reactors:dispatch", { digest: "first", now: 1_700_000_000_000, result: "ran", tables: ["orders"] });
        writeReactorState(harness.sql, "reactors:dispatch", { digest: "second", now: 1_700_000_000_000, result: "ran", tables: ["orders", "desks"] });

        const state = readReactorState(harness.sql, "reactors:dispatch");

        expect(state?.digest).toBe("second");
        expect(state?.tables).toStrictEqual(["orders", "desks"]);
    });

    it("keeps reactors isolated from one another", () => {
        expect.assertions(2);

        writeReactorState(harness.sql, "reactors:a", { digest: "aaa", now: 1_700_000_000_000, result: "ran", tables: ["orders"] });
        writeReactorState(harness.sql, "reactors:b", { digest: "bbb", now: 1_700_000_000_000, result: "ran", tables: ["desks"] });

        expect(readReactorState(harness.sql, "reactors:a")?.digest).toBe("aaa");
        expect(readReactorState(harness.sql, "reactors:b")?.digest).toBe("bbb");
    });

    it("survives a reopen — the baseline is durable, not heap state", () => {
        expect.assertions(1);

        writeReactorState(harness.sql, "reactors:dispatch", { digest: "abc123", now: 1_700_000_000_000, result: "ran", tables: ["orders"] });

        // Standing in for a hibernation eviction. A heap-held baseline would be
        // gone here, and the next flush would re-fire every reactor on the shard.
        migrateReactorState(harness.sql);

        expect(readReactorState(harness.sql, "reactors:dispatch")?.digest).toBe("abc123");
    });

    describe("listReactorStates", () => {
        it("returns nothing on a shard that has never dispatched a reactor", () => {
            expect.assertions(1);

            expect(listReactorStates(harness.sql)).toStrictEqual([]);
        });

        it("returns every reactor, ordered by path", () => {
            expect.assertions(1);

            // Written out of order on purpose: the studio polls this, and an
            // unordered listing would reshuffle the table on every render.
            writeReactorState(harness.sql, "reactors:zeta", { digest: "z", now: 1, result: "ran", tables: ["orders"] });
            writeReactorState(harness.sql, "reactors:alpha", { digest: "a", now: 1, result: "ran", tables: ["desks"] });

            expect(listReactorStates(harness.sql).map((entry) => entry.path)).toStrictEqual(["reactors:alpha", "reactors:zeta"]);
        });

        it("carries each reactor's counters and last error", () => {
            expect.assertions(3);

            writeReactorState(harness.sql, "reactors:dispatch", { digest: "d", now: 1_700_000_000_000, result: "ran", tables: ["orders"] });
            writeReactorState(harness.sql, "reactors:dispatch", { digest: "d", now: 1_700_000_000_001, result: "suppressed", tables: ["orders"] });
            writeReactorState(harness.sql, "reactors:dispatch", { error: "boom", now: 1_700_000_000_002, result: "error" });

            const [entry] = listReactorStates(harness.sql);

            expect(entry?.state.stats).toStrictEqual({ errors: 1, runs: 1, suppressed: 1 });
            expect(entry?.state.lastError).toBe("boom");
            expect(entry?.state.lastRanAt).toBe(1_700_000_000_002);
        });
    });

    it("clears the last error once a later dispatch succeeds", () => {
        expect.assertions(4);

        writeReactorState(harness.sql, "reactors:dispatch", { error: "boom", now: 1_700_000_000_000, result: "error" });

        expect(readReactorState(harness.sql, "reactors:dispatch")?.lastError).toBe("boom");

        writeReactorState(harness.sql, "reactors:dispatch", { digest: "d", now: 1_700_000_000_001, result: "ran", tables: ["orders"] });

        const recovered = readReactorState(harness.sql, "reactors:dispatch");

        // `lastError` describes the LAST dispatch, which is what lets the
        // Studio call a reactor that failed once and has run cleanly since
        // "active". Preserving it across a success would pin the reactor to
        // "failing" forever — nothing else ever nulls the column.
        expect(recovered?.lastError).toBeUndefined();
        // The lifetime error COUNT is a different question and still stands.
        expect(recovered?.stats.errors).toBe(1);
        expect(recovered?.stats.runs).toBe(1);
    });

    it("clears the last error on a suppressed dispatch too", () => {
        expect.assertions(1);

        writeReactorState(harness.sql, "reactors:dispatch", { error: "boom", now: 1_700_000_000_000, result: "error" });
        // A suppressed dispatch means the reactor was offered the change and
        // declined it — it did not fail, so it is not still failing.
        writeReactorState(harness.sql, "reactors:dispatch", { digest: "d", now: 1_700_000_000_001, result: "suppressed", tables: ["orders"] });

        expect(readReactorState(harness.sql, "reactors:dispatch")?.lastError).toBeUndefined();
    });

    describe("counters", () => {
        it("increments only the counter its outcome names", () => {
            expect.assertions(3);

            for (let index = 0; index < 3; index += 1) {
                writeReactorState(harness.sql, "reactors:dispatch", { digest: "d", now: index, result: "ran", tables: ["orders"] });
            }

            writeReactorState(harness.sql, "reactors:dispatch", { digest: "d", now: 9, result: "suppressed", tables: ["orders"] });

            const state = readReactorState(harness.sql, "reactors:dispatch");

            expect(state?.stats.runs).toBe(3);
            expect(state?.stats.suppressed).toBe(1);
            expect(state?.stats.errors).toBe(0);
        });

        it("records a failure without moving the baseline", () => {
            expect.assertions(3);

            writeReactorState(harness.sql, "reactors:dispatch", { digest: "good", now: 1, result: "ran", tables: ["orders"] });
            writeReactorState(harness.sql, "reactors:dispatch", { error: "boom", now: 2, result: "error" });

            const state = readReactorState(harness.sql, "reactors:dispatch");

            // The split this whole signature exists for: a reactor that threw never
            // observed the current result, so its digest and footprint must stay
            // put and the next flush must offer it again — while the failure is
            // still counted and its message retained for the panel.
            expect(state?.digest).toBe("good");
            expect(state?.tables).toStrictEqual(["orders"]);
            expect(state?.stats).toStrictEqual({ errors: 1, runs: 1, suppressed: 0 });
        });
    });

    describe("reactorNeedsRun", () => {
        it("runs when there is no baseline at all", () => {
            expect.assertions(1);

            expect(reactorNeedsRun(undefined, new Set(["orders"]))).toBe(true);
        });

        it("runs when the flush touched a table the reactor read", () => {
            expect.assertions(1);

            expect(reactorNeedsRun({ tables: ["orders", "desks"] }, new Set(["desks"]))).toBe(true);
        });

        it("skips when the flush touched nothing the reactor read", () => {
            expect.assertions(1);

            // The cheap gate: no `select` re-run at all for an unrelated write.
            expect(reactorNeedsRun({ tables: ["orders"] }, new Set(["auditLog"]))).toBe(false);
        });

        it("runs when the stored footprint is unreadable", () => {
            expect.assertions(2);

            // A row written by an older build, or corrupted: "unknown" must mean
            // "assume touched", never "touches nothing" — the latter would stop the
            // reactor forever with no error anywhere.
            harness.sql.exec("UPDATE __reactor_state SET tables = ? WHERE path = ?", "not json", "reactors:dispatch");
            writeReactorState(harness.sql, "reactors:dispatch", { digest: "d", now: 1_700_000_000_000, result: "ran", tables: ["orders"] });
            harness.sql.exec("UPDATE __reactor_state SET tables = ? WHERE path = ?", "not json", "reactors:dispatch");

            const state = readReactorState(harness.sql, "reactors:dispatch");

            expect(state?.tables).toBeUndefined();
            expect(reactorNeedsRun(state, new Set(["anything"]))).toBe(true);
        });

        it("runs when the footprint is a JSON array of the wrong shape", () => {
            expect.assertions(1);

            writeReactorState(harness.sql, "reactors:dispatch", { digest: "d", now: 1_700_000_000_000, result: "ran", tables: ["orders"] });
            harness.sql.exec("UPDATE __reactor_state SET tables = ? WHERE path = ?", "[1, 2, 3]", "reactors:dispatch");

            expect(reactorNeedsRun(readReactorState(harness.sql, "reactors:dispatch"), new Set(["orders"]))).toBe(true);
        });

        it("skips a reactor that genuinely read nothing", () => {
            expect.assertions(1);

            // An empty array IS meaningful when it round-tripped intact: the reactor
            // ran and touched no table, so no write can change its result.
            writeReactorState(harness.sql, "reactors:constant", { digest: "d", now: 1_700_000_000_000, result: "ran", tables: [] });

            expect(reactorNeedsRun(readReactorState(harness.sql, "reactors:constant"), new Set(["orders"]))).toBe(false);
        });
    });
});
