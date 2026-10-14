import { describe, expect, it } from "vitest";

import type { OptimisticMessage, ReconcileDurableMessage } from "../src/agent-chat-reconcile";
import { maxSeq, reconcileOptimistic, RETIRE_AFTER_DURABLE_SEQ_ADVANCE } from "../src/agent-chat-reconcile";

/** A durable user row. */
const user = (content: string, seq: number): ReconcileDurableMessage => {
    return { content, role: "user", seq };
};

/** A durable assistant row. */
const assistant = (content: string, seq: number): ReconcileDurableMessage => {
    return { content, role: "assistant", seq };
};

/** A pending optimistic user turn captured at `maxDurableSeqAtSend`. */
const pending = (id: number, content: string, maxDurableSeqAtSend: number): OptimisticMessage => {
    return { content, id, maxDurableSeqAtSend };
};

interface ReconcileCase {
    /** The durable history the reconcile runs against. */
    durable: ReconcileDurableMessage[];
    name: string;
    /** The pending optimistic rows going in. */
    optimistic: OptimisticMessage[];
    /** The `id`s expected to SURVIVE (still pending) after the reconcile. */
    survivingIds: number[];
}

const cases: ReconcileCase[] = [
    {
        // A normal turn persists a user row (and an assistant row) at a seq above
        // the send-time max — the primary content match retires the pending row.
        durable: [user("hi", 5), assistant("hello", 6)],
        name: "normal turn retires",
        optimistic: [pending(0, "hi", 4)],
        survivingIds: [],
    },
    {
        // P1: an ERRORED turn persists ONLY the user row (+1), never an assistant
        // row, and the window is saturated so older rows slid out. The user row
        // still lands at a seq strictly above the send-time max (11 > 10), so the
        // seq-based primary match retires it even though the window advanced by only
        // 1 (< RETIRE_AFTER_DURABLE_SEQ_ADVANCE) — the exact permanent-ghost this fix
        // targets for errored turns.
        durable: [user("q-8", 8), assistant("a-8", 9), assistant("a-9", 10), user("boom", 11)],
        name: "errored/single-row (+1) turn retires under a saturated window",
        optimistic: [pending(0, "boom", 10)],
        survivingIds: [],
    },
    {
        // The durable history advanced by exactly 1 (an unrelated assistant row from
        // a still-generating turn), and NO matching-content user row landed above the
        // send-time max. A genuinely-pending row must NOT be retired: 1 <
        // RETIRE_AFTER_DURABLE_SEQ_ADVANCE, and there is nothing for the primary match
        // to consume.
        durable: [user("earlier", 9), assistant("thinking", 10)],
        name: "seq-advance-of-1 does not prematurely retire a genuinely-pending row",
        optimistic: [pending(0, "still pending", 9)],
        survivingIds: [0],
    },
    {
        // Two identical prompts sent back-to-back (both captured before either
        // persisted, so both share maxDurableSeqAtSend = 4). Only ONE durable "hi"
        // has landed so far (seq 5): the first pending row consumes it one-to-one and
        // retires; the second must NOT collapse onto the same row — it stays pending
        // until its OWN durable row arrives.
        durable: [user("hi", 5)],
        name: "repeated identical prompts do not collapse when only one durable row landed",
        optimistic: [pending(0, "hi", 4), pending(1, "hi", 4)],
        survivingIds: [1],
    },
    {
        // Same two identical prompts, now BOTH durable rows have landed (seq 5 and
        // seq 7). Each pending row consumes a distinct durable row, so both retire.
        durable: [user("hi", 5), assistant("a", 6), user("hi", 7)],
        name: "repeated identical prompts both retire once both durable rows land",
        optimistic: [pending(0, "hi", 4), pending(1, "hi", 4)],
        survivingIds: [],
    },
    {
        // A durable "hi" already existed BEFORE the send (seq 3, below the send-time
        // max of 5) and no new "hi" has landed since. It must NOT retire the pending
        // row via the primary match (3 is not strictly greater than 5), and the
        // window has not advanced a full turn (5 - 5 = 0), so it stays pending.
        durable: [user("hi", 3), assistant("a", 4), assistant("b", 5)],
        name: "a durable row that predates the send never satisfies the pending row",
        optimistic: [pending(0, "hi", 5)],
        survivingIds: [0],
    },
    {
        // Pathological "identical content already present at send" case: the pending
        // "hi" had a same-content durable row at send time (seq 3), and its OWN
        // acknowledging row was evicted by the bounded window before reconcile saw
        // it — no strictly-greater "hi" is visible. The window has advanced a full
        // turn (7 - 5 = 2 >= RETIRE_AFTER_DURABLE_SEQ_ADVANCE), so the secondary
        // fallback retires it rather than ghosting forever.
        durable: [user("hi", 3), assistant("a", 6), assistant("b", 7)],
        name: "windowed fallback retires when the acknowledging row was evicted",
        optimistic: [pending(0, "hi", 5)],
        survivingIds: [],
    },
    {
        // Empty durable history: nothing to reconcile against, the pending row stays.
        durable: [],
        name: "an unacknowledged row survives against empty durable history",
        optimistic: [pending(0, "hello", -1)],
        survivingIds: [0],
    },
];

describe("reconcileOptimistic", () => {
    it.each(cases)("$name", ({ durable, optimistic, survivingIds }) => {
        expect.hasAssertions();

        const survivors = reconcileOptimistic(optimistic, durable);

        expect(survivors.map((row) => row.id)).toStrictEqual(survivingIds);
    });

    it("is pure — it does not mutate its inputs", () => {
        expect.assertions(2);

        const optimistic = [pending(0, "hi", 4)];
        const durable = [user("hi", 5)];

        reconcileOptimistic(optimistic, durable);

        expect(optimistic).toStrictEqual([pending(0, "hi", 4)]);
        expect(durable).toStrictEqual([user("hi", 5)]);
    });
});

describe("maxSeq", () => {
    it("returns -1 for an empty list so synthetic seqs start at 0", () => {
        expect.assertions(1);

        expect(maxSeq([])).toBe(-1);
    });

    it("returns the highest seq even when rows are out of order or have gaps", () => {
        expect.assertions(1);

        expect(maxSeq([{ seq: 2 }, { seq: 9 }, { seq: 5 }])).toBe(9);
    });
});

describe("the RETIRE_AFTER_DURABLE_SEQ_ADVANCE threshold", () => {
    it("is the documented full-turn fallback threshold", () => {
        expect.assertions(1);

        expect(RETIRE_AFTER_DURABLE_SEQ_ADVANCE).toBe(2);
    });
});
