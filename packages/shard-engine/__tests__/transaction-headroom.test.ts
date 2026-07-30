import { isLunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { estimateBytes } from "../src/estimate-bytes";
import { DEFAULT_TRANSACTION_LIMITS, TransactionHeadroomTracker } from "../src/transaction-headroom";

/** Run `act` and return the thrown error's code, or undefined if it did not throw. */
const codeOf = (act: () => void): string | undefined => {
    try {
        act();
    } catch (error) {
        return isLunoraError(error) ? error.code : "NOT_A_LUNORA_ERROR";
    }

    return undefined;
};

describe("transactionHeadroomTracker", () => {
    it("allows work up to each ceiling", () => {
        expect.assertions(2);

        const tracker = new TransactionHeadroomTracker({ maxReadRows: 10, maxWrittenRows: 2 });

        tracker.recordRead(10);
        tracker.recordWrite({ a: 1 });
        tracker.recordWrite({ a: 2 });

        expect(tracker.headroom().remainingReadRows).toBe(0);
        expect(tracker.headroom().remainingWrittenRows).toBe(0);
    });

    it("stops a runaway read with an attributable error", () => {
        expect.assertions(1);

        const tracker = new TransactionHeadroomTracker({ maxReadRows: 10 });

        expect(
            codeOf(() => {
                tracker.recordRead(11);
            }),
        ).toBe("TRANSACTION_LIMIT_EXCEEDED");
    });

    it("counts reads cumulatively across calls, not per call", () => {
        expect.assertions(1);

        const tracker = new TransactionHeadroomTracker({ maxReadRows: 10 });

        tracker.recordRead(6);

        // Each page is under the cap; their sum is not. A per-call check would
        // let an unbounded pagination loop through.
        expect(
            codeOf(() => {
                tracker.recordRead(6);
            }),
        ).toBe("TRANSACTION_LIMIT_EXCEEDED");
    });

    it("stops a runaway write by row count", () => {
        expect.assertions(1);

        const tracker = new TransactionHeadroomTracker({ maxWrittenRows: 1 });

        tracker.recordWrite({ a: 1 });

        expect(
            codeOf(() => {
                tracker.recordWrite({ a: 2 });
            }),
        ).toBe("TRANSACTION_LIMIT_EXCEEDED");
    });

    it("stops a runaway write by byte size even when the row count is fine", () => {
        expect.assertions(1);

        const tracker = new TransactionHeadroomTracker({ maxWrittenBytes: 64, maxWrittenRows: 1000 });

        expect(
            codeOf(() => {
                tracker.recordWrite({ body: "x".repeat(200) });
            }),
        ).toBe("TRANSACTION_LIMIT_EXCEEDED");
    });

    it("leaves room for the isolate the ceilings protect", () => {
        expect.assertions(1);

        // The cap must sit well under a Durable Object's 128 MiB so the JS-object
        // expansion of the same data still fits alongside it.
        expect(DEFAULT_TRANSACTION_LIMITS.maxWrittenBytes * 3).toBeLessThan(128 * 1024 * 1024);
    });
});

describe("estimateBytes", () => {
    it("charges the fallback for a value that cannot be serialized", () => {
        expect.assertions(1);

        const cyclic: Record<string, unknown> = {};

        cyclic["self"] = cyclic;

        expect(estimateBytes(cyclic, 999)).toBe(999);
    });

    it("charges nothing for a value JSON drops", () => {
        expect.assertions(1);

        expect(estimateBytes(undefined, 999)).toBe(0);
    });
});
