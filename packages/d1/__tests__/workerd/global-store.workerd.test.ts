/**
 * Real-D1 coverage for the two `.global()` provisioning/changelog guards whose
 * correctness rests on engine behaviour the `node:sqlite` harness cannot settle.
 *
 * Whether the refusal a `CREATE UNIQUE INDEX` over duplicate rows raises is one
 * `sqliteDialect.isUniqueViolation` recognises. D1 wraps SQLite's message in a
 * `D1_ERROR` envelope; the guard only fires when the dialect agrees the failure
 * was a unique violation, so a D1 wrapper the matcher missed would disable it
 * silently and leave the bare engine error in its place.
 *
 * Whether `sqlite_sequence` — the AUTOINCREMENT bookkeeping row the changelog
 * watermark is read from — outlives a `DELETE` of every row on workerd's SQLite
 * build. The whole rewind witness rests on that, and on `MAX(seq)` going NULL
 * where the sequence does not.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface UniqueResult {
    code: null | string;
    message?: string;
    outcome: string;
}

interface RewindResult {
    afterRestore: string;
    afterSweep: string;
    consumedCursor: number;
    sweptMaxSeq: null | number;
    sweptSequence: null | number;
}

const post = async <T>(path: string): Promise<T> => await SELF.fetch(`https://test${path}`, { method: "POST" }).then(async (r) => await r.json<T>());

describe("global store (workerd)", () => {
    it("refuses a `.unique()` column over existing duplicates with a diagnostic, not a bare engine error", async () => {
        expect.assertions(3);

        const result = await post<UniqueResult>("/unique-over-duplicates");

        expect(result.outcome).toBe("threw");
        expect(result.code).toBe("INTERNAL");
        expect(result.message).toMatch(/dups_unique_slug.*duplicates/isu);
    });

    it("reads a changelog watermark that a sweep cannot lower but a restore does", async () => {
        expect.assertions(5);

        const result = await post<RewindResult>("/cdc-rewind");

        expect(result.consumedCursor).toBe(2);
        // The sweep took every row: `MAX(seq)` is gone, the bookkeeping row is not.
        expect(result.sweptMaxSeq).toBeNull();
        expect(result.sweptSequence).toBe(2);
        // So a caught-up consumer of a fully swept log is still served.
        expect(result.afterSweep).toBe("served");
        // And one holding a cursor the rewound timeline never issued is refused.
        expect(result.afterRestore).toBe("threw:CDC_TIMELINE_FORKED");
    });
});
