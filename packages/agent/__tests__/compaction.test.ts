import { describe, expect, it } from "vitest";

import { splitForCompaction } from "../src/agent-loop";
import type { AgentMessageRow } from "../src/types";

/** N user rows `m0..m{N-1}` for exercising the compaction split. */
const rows = (n: number): AgentMessageRow[] =>
    Array.from({ length: n }, (_, index) => {
        return { content: `m${String(index)}`, role: "user" as const, seq: index };
    });

describe(splitForCompaction, () => {
    it("returns undefined when compaction is unset", () => {
        expect(splitForCompaction(rows(50), undefined)).toBeUndefined();
    });

    it("returns undefined when history is within maxMessages", () => {
        expect(splitForCompaction(rows(4), { maxMessages: 4 })).toBeUndefined();
        expect(splitForCompaction(rows(5), { maxMessages: 10 })).toBeUndefined();
    });

    it("splits older vs recent, keeping ceil(maxMessages / 2) by default", () => {
        // maxMessages 6 → default keepRecent = ceil(6/2) = 3; cut = 11 - 3 = 8.
        const split = splitForCompaction(rows(11), { maxMessages: 6 });

        expect(split?.older).toHaveLength(8);
        expect(split?.recent.map((row) => row.content)).toStrictEqual(["m8", "m9", "m10"]);
    });

    it("honors an explicit keepRecent", () => {
        const split = splitForCompaction(rows(20), { keepRecent: 5, maxMessages: 8 });

        expect(split?.older).toHaveLength(15);
        expect(split?.recent).toHaveLength(5);
    });

    it("returns undefined when the kept tail would swallow the whole history", () => {
        // keepRecent ≥ history length ⇒ nothing older to summarize.
        expect(splitForCompaction(rows(6), { keepRecent: 10, maxMessages: 4 })).toBeUndefined();
    });
});
