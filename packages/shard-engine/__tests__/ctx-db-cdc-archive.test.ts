import { describe, expect, it } from "vitest";

import type { CdcChange } from "../src/ctx-db-cdc";
import type { CdcArchiveScope } from "../src/ctx-db-cdc-archive";
import { archiveCdcSegment, readArchivedCdcChanges } from "../src/ctx-db-cdc-archive";
import { createFakeR2Bucket as fakeBucket } from "./_helpers/fake-r2";

/**
 * Unit cover for the changelog cold tier. The properties that matter are the
 * refusals, not the happy path: this code exists to serve a consumer the live
 * log has already given up on, and serving it the WRONG rows is worse than the
 * re-seed it replaces.
 */

const scope: CdcArchiveScope = { epoch: "e1", shard: "__root__" };

const change = (seq: number, op: CdcChange["op"] = "insert"): CdcChange => {
    const base = { id: `row-${String(seq)}`, op, seq, table: "messages", ts: seq };

    return op === "delete" ? base : { ...base, doc: { seq } };
};

describe("cdc archive", () => {
    it("serves a trimmed range back in order", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();

        await archiveCdcSegment(bucket, scope, [change(1), change(2), change(3)]);
        await archiveCdcSegment(bucket, scope, [change(4), change(5)]);

        const page = await readArchivedCdcChanges(bucket, scope, 0, 100);

        expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([1, 2, 3, 4, 5]);
        expect(page?.cursor).toBe(5);
    });

    it("keys segments so a mid-range cursor skips the segments it has seen", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();

        await archiveCdcSegment(bucket, scope, [change(1), change(2), change(3)]);
        await archiveCdcSegment(bucket, scope, [change(4), change(5)]);

        // Resuming at 3 sits exactly on the first segment's boundary: it must be
        // excluded, not re-served, and the next one must still be contiguous.
        const page = await readArchivedCdcChanges(bucket, scope, 3, 100);

        expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([4, 5]);
    });

    it("pads keys so segment 9 sorts before segment 10", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();

        await archiveCdcSegment(bucket, scope, [change(9)]);
        await archiveCdcSegment(bucket, scope, [change(10)]);

        // Unpadded, "10" sorts BEFORE "9" and the read-back below silently loses
        // segment 9 — so the ordering is asserted on the keys themselves, not
        // just inferred from a page that happened to come out right.
        expect(bucket.keys().map((key) => key.split("/").at(-1))).toStrictEqual(["0000000000000009.json", "0000000000000010.json"]);

        const page = await readArchivedCdcChanges(bucket, scope, 8, 100);

        expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([9, 10]);
    });

    it("de-overlaps segments whose ranges intersect", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();

        // Reachable state, not a contrived one: sweep 1 archives 1..5 but its
        // trim is clamped by the retention floor at 3, so 4 and 5 stay in the
        // live log and sweep 2 archives 4..8 on top of them.
        await archiveCdcSegment(bucket, scope, [change(1), change(2), change(3), change(4), change(5)]);
        await archiveCdcSegment(bucket, scope, [change(4), change(5), change(6), change(7), change(8)]);

        const page = await readArchivedCdcChanges(bucket, scope, 0, 100);

        // 4 and 5 exactly once, and `seq` never goes backwards. Serving the
        // segments verbatim would emit 1,2,3,4,5,4,5,6,7,8 — for a consumer
        // applying ops in order, a delete replayed after the re-insert that
        // followed it inverts the row's final state.
        expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(page?.cursor).toBe(8);
    });

    it("ignores a segment wholly contained in one already served", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();

        await archiveCdcSegment(bucket, scope, [change(3), change(4)]);
        await archiveCdcSegment(bucket, scope, [change(1), change(2), change(3), change(4), change(5)]);

        // The 3..4 segment sorts FIRST (keys are the range's last seq), so the
        // wider segment is read second and must not rewind the cursor.
        const page = await readArchivedCdcChanges(bucket, scope, 2, 100);

        expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([3, 4, 5]);
    });

    it("clamps a caller-supplied limit instead of materializing every segment", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();

        // Two segments totalling 12,000 changes, so the 10,000 ceiling is the
        // only thing that can bound the page — with fewer rows than the clamp
        // this test would pass whether or not the clamp existed.
        await archiveCdcSegment(
            bucket,
            scope,
            Array.from({ length: 6000 }, (_, index) => change(index + 1)),
        );
        await archiveCdcSegment(
            bucket,
            scope,
            Array.from({ length: 6000 }, (_, index) => change(index + 6001)),
        );

        // An admin RPC passes `limit` straight through unvalidated, so the page
        // ceiling has to hold here rather than upstream.
        const page = await readArchivedCdcChanges(bucket, scope, 0, Number.MAX_SAFE_INTEGER);

        expect(page?.changes).toHaveLength(10_000);
    });

    describe("a foreign object under the prefix", () => {
        /**
         * The bucket is an operator-supplied binding, and nothing forces it to be
         * dedicated. A segment's `from`/`to` are therefore a CLAIM, and coverage
         * has to be decided by what the object actually holds — otherwise anyone
         * who can write a key under the prefix can advance a warehouse cursor over
         * changes it was never handed.
         */
        const plant = async (bucket: ReturnType<typeof fakeBucket>, to: number, segment: unknown): Promise<void> => {
            await bucket.put(`cdc/__root__/e1/${String(to).padStart(16, "0")}.json`, JSON.stringify(segment));
        };

        it("does not let a declared `to` advance the cursor over rows it does not hold", async () => {
            expect.assertions(1);

            const bucket = fakeBucket();

            await archiveCdcSegment(bucket, scope, [change(1), change(2)]);
            // Claims to cover 3..6, holds only 5 and 6.
            await plant(bucket, 6, { changes: [change(5), change(6)], from: 3, to: 6 });

            const page = await readArchivedCdcChanges(bucket, scope, 0, 100);

            // Must stop at the discontinuity, not serve [1,2,5,6] with cursor 6.
            expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([1, 2]);
        });

        it("does not let a huge declared range hide a one-row object", async () => {
            expect.assertions(1);

            const bucket = fakeBucket();

            await plant(bucket, 1000, { changes: [change(1)], from: 1, to: 1000 });
            await archiveCdcSegment(bucket, scope, [change(1001), change(1002)]);

            const page = await readArchivedCdcChanges(bucket, scope, 0, 100);

            // Serving [1, 1001, 1002] would silently swallow 999 changes.
            expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([1]);
        });

        it("stops at a discontinuity inside one object rather than serving across it", async () => {
            expect.assertions(1);

            const bucket = fakeBucket();

            await plant(bucket, 4, { changes: [change(1), change(4), change(2), change(3)], from: 1, to: 4 });

            const page = await readArchivedCdcChanges(bucket, scope, 0, 100);

            // Out of order in the body: serve the ascending run and stop. Serving
            // it verbatim would hand back a cursor below rows already delivered.
            expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([1]);
        });
    });

    it("refuses a range the archive never covered", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();

        // Archiving was enabled after seq 1-3 had already been trimmed away.
        await archiveCdcSegment(bucket, scope, [change(4), change(5)]);

        await expect(readArchivedCdcChanges(bucket, scope, 0, 100)).resolves.toBeUndefined();
    });

    it("refuses when a segment is missing from the middle of the range", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();

        await archiveCdcSegment(bucket, scope, [change(1), change(2)]);
        await archiveCdcSegment(bucket, scope, [change(5), change(6)]);

        // The 3-4 segment never landed. Serving 1,2,5,6 as one page would hand a
        // warehouse a silent hole, so the page stops at the hole instead.
        const page = await readArchivedCdcChanges(bucket, scope, 0, 100);

        expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([1, 2]);
        // And the consumer that comes back at 2 is told to re-seed, not handed 5.
        await expect(readArchivedCdcChanges(bucket, scope, 2, 100)).resolves.toBeUndefined();
    });

    it("serves up to a payload-compacted row, then refuses at it", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();

        // A row compacted before it was archived: op says insert, post-image gone.
        await archiveCdcSegment(bucket, scope, [change(1), { id: "row-2", op: "update", seq: 2, table: "messages", ts: 2 }]);

        // Row 1 is sound and is served. Refusing the whole read instead would
        // deny a page the consumer can use, and would discard anything already
        // collected from earlier segments.
        const page = await readArchivedCdcChanges(bucket, scope, 0, 100);

        expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([1]);

        // Sitting on the compacted row, there is nothing sound to serve, so the
        // consumer is told to re-seed rather than handed a doc-less insert it
        // cannot distinguish from a delete.
        await expect(readArchivedCdcChanges(bucket, scope, 1, 100)).resolves.toBeUndefined();
    });

    it("does not let a compacted row past the limit deny a serveable page", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();

        await archiveCdcSegment(bucket, scope, [change(1), change(2), { id: "row-3", op: "update", seq: 3, table: "messages", ts: 3 }]);

        // The caller asked for one change and the compacted row is two beyond it.
        // Refusing here would fail a request the archive can answer exactly.
        const page = await readArchivedCdcChanges(bucket, scope, 0, 1);

        expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([1]);
    });

    it("keeps a delete's absent post-image serveable", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();

        await archiveCdcSegment(bucket, scope, [change(1, "delete"), change(2)]);

        const page = await readArchivedCdcChanges(bucket, scope, 0, 100);

        expect(page?.changes).toHaveLength(2);
    });

    it("hides another timeline's segments after an epoch fork", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();

        await archiveCdcSegment(bucket, scope, [change(1), change(2)]);

        await expect(readArchivedCdcChanges(bucket, { ...scope, epoch: "e2" }, 0, 100)).resolves.toBeUndefined();
    });

    it("stops at `limit` and reports the cursor it actually reached", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();

        await archiveCdcSegment(bucket, scope, [change(1), change(2), change(3), change(4)]);

        const page = await readArchivedCdcChanges(bucket, scope, 0, 2);

        expect(page?.changes.map((entry) => entry.seq)).toStrictEqual([1, 2]);
        expect(page?.cursor).toBe(2);
    });
});
