import { describe, expect, it } from "vitest";

import { parseBaselineSeqHeader } from "../src/admin-rpc-args";
import { buildBatchEntryRequest, SHARED_BATCH_HEADERS } from "../src/batch";

const batchRequest = (headers: Record<string, string> = {}): Request => new Request("https://shard.internal/rpc-batch", { headers, method: "POST" });

describe(buildBatchEntryRequest, () => {
    it("copies the shared identity/bookmark headers off the batch request", () => {
        expect.assertions(2);

        const request = buildBatchEntryRequest(batchRequest({ "x-d1-bookmark": "bk-1", "x-lunora-userid": "user-1" }), {
            functionPath: "docs:rename",
            id: 0,
        });

        expect(request.headers.get("x-lunora-userid")).toBe("user-1");
        expect(request.headers.get("x-d1-bookmark")).toBe("bk-1");
    });

    // The baseline is PER ENTRY, never an outer header: one batch carries writes
    // composed at different cursors, so a single outbound value cannot speak for
    // all of them. Omitting it left every batched replay with no baseline at the
    // shard, which applies the write unchanged — so a stale write clobbered a
    // newer value precisely when two or more writes were queued together.
    it("forwards the entry's own baselineSeq as `x-lunora-base-seq`", () => {
        expect.assertions(1);

        const request = buildBatchEntryRequest(batchRequest(), { baselineSeq: 10, functionPath: "docs:rename", id: 0 });

        expect(request.headers.get("x-lunora-base-seq")).toBe("10");
    });

    it("sets no baseline header when the entry carries none", () => {
        expect.assertions(1);

        const request = buildBatchEntryRequest(batchRequest(), { functionPath: "docs:rename", id: 0 });

        expect(request.headers.get("x-lunora-base-seq")).toBeNull();
    });

    it("forwards a zero baseline rather than treating it as absent", () => {
        // `0` is a real cursor — "the client had seen nothing" — and is exactly the
        // baseline that should make every field look changed. A truthiness check
        // here would silently drop it and apply the write unchanged instead.
        //
        // The DO parses this header with `parseBaselineSeqHeader`, which admits
        // `0`; the client-sequence parser next to it floors at `> 0`, because a
        // mutation sequence starts at 1. Using that one here was what discarded a
        // zero baseline one hop past this assertion.
        expect.assertions(1);

        const request = buildBatchEntryRequest(batchRequest(), { baselineSeq: 0, functionPath: "docs:rename", id: 0 });

        expect(request.headers.get("x-lunora-base-seq")).toBe("0");
    });

    it("keeps each entry's mutation/client headers off the entry, not the batch", () => {
        expect.assertions(3);

        const request = buildBatchEntryRequest(batchRequest(), {
            clientId: "c1",
            clientSeq: 4,
            functionPath: "docs:rename",
            id: 0,
            mutationId: "c1:7",
        });

        expect(request.headers.get("x-lunora-mutation-id")).toBe("c1:7");
        expect(request.headers.get("x-lunora-client-id")).toBe("c1");
        expect(request.headers.get("x-lunora-client-seq")).toBe("4");
    });

    it("does not list the per-entry baseline among the shared batch headers", () => {
        expect.assertions(1);

        expect([...SHARED_BATCH_HEADERS]).not.toContain("x-lunora-base-seq");
    });
});

describe(parseBaselineSeqHeader, () => {
    // Separate from the client-sequence parser on purpose: a mutation sequence
    // starts at 1, but `0` is a valid BASELINE ("had seen nothing") and is what
    // `readCdcCursor` reports for an empty changelog. Flooring it to `undefined`
    // makes `.dropStalePatches()` apply the write unchanged — the opposite verdict.
    it.each([
        ["0", 0],
        ["10", 10],
    ])("admits %s as a baseline", (raw, expected) => {
        expect.assertions(1);

        expect(parseBaselineSeqHeader(raw)).toBe(expected);
    });

    it.each([["-1"], ["1.5"], ["abc"], [""]])("rejects %s", (raw) => {
        expect.assertions(1);

        expect(parseBaselineSeqHeader(raw)).toBeUndefined();
    });

    it("rejects an absent header", () => {
        expect.assertions(1);

        expect(parseBaselineSeqHeader(null)).toBeUndefined();
    });
});
