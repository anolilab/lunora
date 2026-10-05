import { describe, expect, it, vi } from "vitest";

import type { ControlPlaneDatabase } from "../src/store";
import { drainTable } from "../src/store";
import fakeControlPlaneDb, { FAKE_PAGE_SIZE } from "./_helpers/fake-control-plane-db";

/**
 * Whole-table draining for the control-plane sweeps.
 *
 * `findMany` answers ONE page, capped at 1000 rows, and `ControlPlaneDatabase`
 * had no cursor — so no sweep in `src/` could drain even where it had to. The
 * money path felt it worst: past the cap the overage reconciler read an arbitrary
 * slice, under-counted usage and under-debited, while reporting success.
 *
 * These tests only mean something because the fake now enforces the same cap. It
 * used to return every row for every call, which made the truncation bug and its
 * fix equally invisible — a suite green against a store that does not exist.
 */

const rows = (
    count: number,
    over: (index: number) => Record<string, unknown> = () => {
        return {};
    },
): Record<string, unknown>[] =>
    Array.from({ length: count }, (_, index) => {
        return { _id: `row_${String(index)}`, ...over(index) };
    });

describe(drainTable, () => {
    it("follows the cursor past the page cap", async () => {
        const total = FAKE_PAGE_SIZE + 250;
        const database = fakeControlPlaneDb({ platformUsage: rows(total) });

        await expect(drainTable(database, "platformUsage")).resolves.toHaveLength(total);
    });

    it("is what a single read is NOT — the bug this exists to fix", async () => {
        const total = FAKE_PAGE_SIZE + 250;
        const database = fakeControlPlaneDb({ platformUsage: rows(total) });

        // The shape every sweep used before: one page, silently short.
        const { page } = await database.findMany("platformUsage", {});

        expect(page).toHaveLength(FAKE_PAGE_SIZE);
        expect(page.length).toBeLessThan(total);
    });

    it("carries the where clause through every page", async () => {
        const database = fakeControlPlaneDb({
            platformUsage: rows(FAKE_PAGE_SIZE + 100, (index) => {
                return { periodStart: index % 2 === 0 ? 500 : 999 };
            }),
        });

        const drained = await drainTable<{ periodStart: number }>(database, "platformUsage", { where: { periodStart: 500 } });

        expect(drained).not.toHaveLength(0);
        expect(drained.every((row) => row.periodStart === 500)).toBe(true);
    });

    it("returns everything in one call when the table fits in a page", async () => {
        const findMany = vi.fn<ControlPlaneDatabase["findMany"]>(() => Promise.resolve({ continueCursor: null, isDone: true, page: [{ _id: "a" }] }));

        await expect(drainTable(fakeControlPlaneDb({}, { findMany }), "cells")).resolves.toHaveLength(1);
        // A short table must not cost a second round trip.
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("stops rather than looping forever on a cursor that never terminates", async () => {
        // A store that always claims there is more. The drain must degrade to a
        // truncated read, never an unbounded scheduled invocation.
        const findMany = vi.fn<ControlPlaneDatabase["findMany"]>(() => Promise.resolve({ continueCursor: "always", isDone: false, page: [{ _id: "a" }] }));

        const drained = await drainTable(fakeControlPlaneDb({}, { findMany }), "cells");

        expect(drained.length).toBeGreaterThan(0);
        expect(findMany.mock.calls.length).toBeLessThanOrEqual(100);
    });
});
