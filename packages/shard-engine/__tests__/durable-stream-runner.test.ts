import { describe, expect, it } from "vitest";

import type { DurableStreamRun } from "../src/durable-stream";
import { decideDurableAttach } from "../src/durable-stream-runner";

/**
 * The pure attach decision the whole durable-stream feature turns on: whether
 * a caller may resume the stored transcript, replay a finished one, reclaim a
 * dead one, or must be told the run it holds a prefix of is gone. The run key
 * is shared across a caller's tabs, so `generation` (the run's `startedAt`
 * stamp) is what distinguishes "continuing this run" from "splicing a
 * different run's tail onto the prefix I hold".
 */

const GENERATION = 1_700_000_000_000;

const run = (status: DurableStreamRun["status"], startedAt = GENERATION): DurableStreamRun => {
    return { lastSeq: 3, startedAt, status };
};

describe(decideDurableAttach, () => {
    describe("run missing", () => {
        it("attaches fresh when the caller holds nothing", () => {
            expect.assertions(1);

            expect(decideDurableAttach(undefined, { live: false, resuming: false })).toBe("attach");
        });

        it("interrupts a resume whose transcript no longer exists", () => {
            expect.assertions(1);

            expect(decideDurableAttach(undefined, { live: false, resuming: true })).toBe("interrupted");
        });

        it("interrupts a resume even when a (foreign, by construction) producer is live under the key", () => {
            expect.assertions(1);

            // `claimStreamRun` writes the row before any chunk flows, so a live
            // producer with no row cannot be the run this caller is resuming.
            expect(decideDurableAttach(undefined, { live: true, resuming: true })).toBe("interrupted");
        });
    });

    describe("generation echo", () => {
        it("interrupts a resume whose generation does not match the stored run, even when it is live", () => {
            expect.assertions(2);

            const stored = run("running");

            expect(decideDurableAttach(stored, { generation: GENERATION - 1, live: true, resuming: true })).toBe("interrupted");
            expect(decideDurableAttach(stored, { generation: GENERATION - 1, live: false, resuming: true })).toBe("interrupted");
        });

        it("interrupts a resume onto a terminal run of a different generation instead of replaying it", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("complete"), { generation: GENERATION - 1, live: false, resuming: true })).toBe("interrupted");
        });

        it("attaches a resume to the live producer when the generation matches", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("running"), { generation: GENERATION, live: true, resuming: true })).toBe("attach");
        });

        it("replays a terminal run when the resume's generation matches", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("complete"), { generation: GENERATION, live: false, resuming: true })).toBe("replay-terminal");
        });

        it("ignores the generation on a fresh attach", () => {
            expect.assertions(1);

            // `sinceChunk: 0` means "asking fresh" — there is no held prefix a
            // mismatch could corrupt, so the stamp carries no meaning.
            expect(decideDurableAttach(run("complete"), { generation: GENERATION - 1, live: false, resuming: false })).toBe("reclaim");
        });

        it("preserves the pre-stamp behavior when the caller sends no generation (older client)", () => {
            expect.assertions(2);

            expect(decideDurableAttach(run("running"), { live: true, resuming: true })).toBe("attach");
            expect(decideDurableAttach(run("complete"), { live: false, resuming: true })).toBe("replay-terminal");
        });
    });

    describe("terminal run", () => {
        it("replays the recorded outcome to a resuming caller", () => {
            expect.assertions(2);

            expect(decideDurableAttach(run("complete"), { live: false, resuming: true })).toBe("replay-terminal");
            expect(decideDurableAttach(run("error"), { live: false, resuming: true })).toBe("replay-terminal");
        });

        it("reclaims for a caller asking fresh", () => {
            expect.assertions(2);

            expect(decideDurableAttach(run("complete"), { live: false, resuming: false })).toBe("reclaim");
            expect(decideDurableAttach(run("error"), { live: false, resuming: false })).toBe("reclaim");
        });
    });

    describe("dead running run", () => {
        it("interrupts a resuming caller — the tail cannot be regenerated without duplicating it", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("running"), { live: false, resuming: true })).toBe("interrupted");
        });

        it("reclaims for a caller asking fresh so an eviction cannot wedge the key", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("running"), { live: false, resuming: false })).toBe("reclaim");
        });
    });

    describe("live run", () => {
        it("joins the live producer", () => {
            expect.assertions(2);

            expect(decideDurableAttach(run("running"), { live: true, resuming: false })).toBe("attach");
            expect(decideDurableAttach(run("running"), { live: true, resuming: true })).toBe("attach");
        });
    });
});
