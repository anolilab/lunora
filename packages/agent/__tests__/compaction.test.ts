import { describe, expect, it } from "vitest";

import { splitForCompaction } from "../src/agent-loop";
import type { AgentMessageRow } from "../src/types";

/** N user rows `m0..m{N-1}` for exercising the compaction split. */
const rows = (n: number): AgentMessageRow[] =>
    Array.from({ length: n }, (_, index) => {
        return { content: `m${String(index)}`, role: "user" as const, seq: index };
    });

/** One message row of a given role (for the tool-pairing boundary test). */
const msg = (role: AgentMessageRow["role"], seq: number, extra: Partial<AgentMessageRow> = {}): AgentMessageRow => {
    return { content: `m${String(seq)}`, role, seq, ...extra };
};

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

    it("never lets the recent tail start on an orphan tool row — keeps tool-call/result paired", () => {
        // Naive cut (len 12, keepRecent ceil(6/2)=3 → cut 9) lands on the tool row.
        const history: AgentMessageRow[] = [
            msg("user", 0),
            msg("assistant", 1),
            msg("user", 2),
            msg("assistant", 3),
            msg("user", 4),
            msg("assistant", 5),
            msg("user", 6),
            msg("assistant", 7),
            msg("assistant", 8, { toolCalls: [{ id: "c", input: {}, name: "t" }] }),
            msg("tool", 9, { toolCallId: "c", toolName: "t" }),
            msg("assistant", 10),
            msg("user", 11),
        ];

        const split = splitForCompaction(history, { maxMessages: 6 });

        // The boundary snapped back off the tool row onto its assistant tool-call,
        // pulling the pair into `recent` and ending `older` on a clean row.
        expect(split?.recent[0]?.role).not.toBe("tool");
        expect(split?.recent[0]?.seq).toBe(8);
        expect(split?.older).toHaveLength(8);
    });
});
