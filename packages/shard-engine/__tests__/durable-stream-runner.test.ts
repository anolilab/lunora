import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableStreamRun } from "../src/durable-stream";
import { appendStreamChunk, claimStreamRun, finishStreamRun, migrateDurableStreams, readStreamRun } from "../src/durable-stream";
import type { DurableStreamSink } from "../src/durable-stream-runner";
import { decideDurableAttach, DurableStreamRunner } from "../src/durable-stream-runner";
import createSqliteExec from "./_helpers/node-sqlite";

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

describe("durableStreamRunner.attach", () => {
    let harness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        harness = createSqliteExec();
        migrateDurableStreams(harness.sql);
    });

    afterEach(() => {
        harness.close();
    });

    interface SinkEvent {
        data?: unknown;
        failure?: { code: string; message: string };
        generation?: number;
        seq?: number;
        type: "chunk" | "complete" | "fail";
    }

    const recordingSink = (): { events: SinkEvent[]; sink: DurableStreamSink } => {
        const events: SinkEvent[] = [];

        return {
            events,
            sink: {
                chunk(chunk) {
                    events.push({ ...chunk, type: "chunk" });

                    return true;
                },
                complete() {
                    events.push({ type: "complete" });
                },
                fail(failure) {
                    events.push({ failure, type: "fail" });
                },
            },
        };
    };

    const chunksOf = (events: SinkEvent[]): SinkEvent[] => events.filter((event) => event.type === "chunk");

    it("starts a fresh run and stamps every chunk with the run's generation", async () => {
        expect.assertions(4);

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const { events, sink } = recordingSink();

        const answer = async function* (): AsyncGenerator<string> {
            yield "the";
            yield " quick";
        };

        await runner.attach({ iterator: () => answer(), runKey: "run-a", sinceChunk: 0, sink });

        expect(
            chunksOf(events).map((event) => {
                return { data: event.data, seq: event.seq };
            }),
        ).toStrictEqual([
            { data: "the", seq: 1 },
            { data: " quick", seq: 2 },
        ]);
        expect(events.at(-1)?.type).toBe("complete");

        const generations = new Set(chunksOf(events).map((event) => event.generation));

        expect(generations.size).toBe(1);
        expect(readStreamRun(harness.sql, "run-a")?.startedAt).toBe([...generations][0]);
    });

    it("joins the live producer on a matching-generation resume, replaying the missed prefix first", async () => {
        expect.assertions(4);

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const first = recordingSink();
        const second = recordingSink();

        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const answer = async function* (): AsyncGenerator<string> {
            yield "one";
            await gate;
            yield "two";
        };

        const producing = runner.attach({ iterator: () => answer(), runKey: "run-a", sinceChunk: 0, sink: first.sink });

        await vi.waitFor(() => {
            expect(chunksOf(first.events)).toHaveLength(1);
        });

        const generation = chunksOf(first.events)[0]?.generation;

        // The resume lands while the producer is still live: chunk 1 is replayed
        // from SQLite, then the sink rides the live fan-out for chunk 2.
        await runner.attach({
            generation,
            iterator: () => answer(),
            runKey: "run-a",
            sinceChunk: 0,
            sink: second.sink,
        });

        release();
        await producing;

        expect(chunksOf(second.events).map((event) => event.data)).toStrictEqual(["one", "two"]);
        expect(second.events.at(-1)?.type).toBe("complete");
    });

    it("replays a finished run's tail and outcome to a matching-generation resume without re-running the handler", async () => {
        expect.assertions(3);

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const first = recordingSink();
        let starts = 0;

        const answer = async function* (): AsyncGenerator<string> {
            starts += 1;
            yield "the";
            yield " quick";
        };

        await runner.attach({ iterator: () => answer(), runKey: "run-a", sinceChunk: 0, sink: first.sink });

        const generation = chunksOf(first.events)[0]?.generation;
        const resumed = recordingSink();

        await runner.attach({ generation, iterator: () => answer(), runKey: "run-a", sinceChunk: 1, sink: resumed.sink });

        expect(
            chunksOf(resumed.events).map((event) => {
                return { data: event.data, seq: event.seq };
            }),
        ).toStrictEqual([{ data: " quick", seq: 2 }]);
        expect(resumed.events.at(-1)?.type).toBe("complete");
        expect(starts).toBe(1);
    });

    it("reclaims a finished run for a fresh attach and stamps the new run with a NEW generation", async () => {
        expect.assertions(3);

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const first = recordingSink();

        const one = async function* (): AsyncGenerator<string> {
            yield "answer-1";
        };

        await runner.attach({ iterator: () => one(), runKey: "run-a", sinceChunk: 0, sink: first.sink });

        const fresh = recordingSink();

        const two = async function* (): AsyncGenerator<string> {
            yield "answer-2";
        };

        await runner.attach({ iterator: () => two(), runKey: "run-a", sinceChunk: 0, sink: fresh.sink });

        expect(
            chunksOf(fresh.events).map((event) => {
                return { data: event.data, seq: event.seq };
            }),
        ).toStrictEqual([{ data: "answer-2", seq: 1 }]);

        const oldGeneration = chunksOf(first.events)[0]?.generation ?? 0;
        const newGeneration = chunksOf(fresh.events)[0]?.generation ?? 0;

        // Strictly newer even inside the same millisecond — the stamp is what a
        // resume uses to tell the two runs apart.
        expect(newGeneration).toBeGreaterThan(oldGeneration);
        expect(readStreamRun(harness.sql, "run-a")?.startedAt).toBe(newGeneration);
    });

    it("replays the persisted tail then fails a resume onto a dead running run", async () => {
        expect.assertions(2);

        // A half-written transcript with no live producer: the instance died
        // mid-generation. Written through the store directly, exactly what a
        // later instance finds in SQLite.
        claimStreamRun(harness.sql, "run-a", 1_700_000_000_000, 86_400_000);
        appendStreamChunk(harness.sql, "run-a", 1, JSON.stringify("half"));
        appendStreamChunk(harness.sql, "run-a", 2, JSON.stringify("way"));

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const { events, sink } = recordingSink();

        await runner.attach({
            iterator: () => {
                throw new Error("a resume must never re-run the handler");
            },
            runKey: "run-a",
            sinceChunk: 1,
            sink,
        });

        expect(
            chunksOf(events).map((event) => {
                return { data: event.data, seq: event.seq };
            }),
        ).toStrictEqual([{ data: "way", seq: 2 }]);
        expect(events.at(-1)).toStrictEqual({ failure: { code: "STREAM_INTERRUPTED", message: expect.any(String) as string }, type: "fail" });
    });

    it("fails a mismatched-generation resume WITHOUT replaying the foreign run's chunks", async () => {
        expect.assertions(1);

        claimStreamRun(harness.sql, "run-a", 1_700_000_000_000, 86_400_000);
        appendStreamChunk(harness.sql, "run-a", 1, JSON.stringify("foreign"));
        appendStreamChunk(harness.sql, "run-a", 2, JSON.stringify("chunks"));
        finishStreamRun(harness.sql, "run-a", "complete", 2);

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const { events, sink } = recordingSink();

        await runner.attach({
            generation: 1_699_999_999_999,
            iterator: () => {
                throw new Error("a refused resume must never run the handler");
            },
            runKey: "run-a",
            sinceChunk: 1,
            sink,
        });

        // No chunks — delivering the stored run's tail under the caller's old
        // watermark is the splice the generation gate exists to prevent.
        expect(events).toStrictEqual([{ failure: { code: "STREAM_INTERRUPTED", message: expect.any(String) as string }, type: "fail" }]);
    });

    it("fails a resume whose transcript no longer exists without starting a new run", async () => {
        expect.assertions(2);

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const { events, sink } = recordingSink();

        await runner.attach({
            iterator: () => {
                throw new Error("a refused resume must never run the handler");
            },
            runKey: "run-a",
            sinceChunk: 3,
            sink,
        });

        expect(events).toStrictEqual([{ failure: { code: "STREAM_INTERRUPTED", message: expect.any(String) as string }, type: "fail" }]);
        expect(readStreamRun(harness.sql, "run-a")).toBeUndefined();
    });
});
