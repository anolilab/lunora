import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableStreamRun } from "../src/durable-stream";
import {
    appendStreamChunk,
    claimStreamRun,
    finishStreamRun,
    migrateDurableStreams,
    readStreamChunks,
    readStreamRun,
    trimStreamRuns,
} from "../src/durable-stream";
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

/** A live producer under the key, stamped with the same generation as the stored row. */
const LIVE = { generation: GENERATION };

const run = (status: DurableStreamRun["status"], startedAt = GENERATION): DurableStreamRun => {
    return { lastSeq: 3, startedAt, status };
};

describe(decideDurableAttach, () => {
    describe("run missing", () => {
        it("attaches fresh when the caller holds nothing", () => {
            expect.assertions(1);

            expect(decideDurableAttach(undefined, { resuming: false })).toBe("attach");
        });

        it("interrupts a resume whose transcript no longer exists", () => {
            expect.assertions(1);

            expect(decideDurableAttach(undefined, { resuming: true })).toBe("interrupted");
        });

        it("still joins a live producer whose row a TTL sweep removed", () => {
            expect.assertions(2);

            // `trimStreamRuns` deletes on `startedAt + ttlMs` regardless of
            // status, so a generator outliving its procedure's `ttlMs` keeps
            // producing under a key with no row. The producer IS the run —
            // failing its consumers here would break a resume that used to work.
            expect(decideDurableAttach(undefined, { live: LIVE, resuming: true })).toBe("attach");
            expect(decideDurableAttach(undefined, { generation: GENERATION, live: LIVE, resuming: true })).toBe("attach");
        });

        it("interrupts a resume onto a rowless live producer of a different generation", () => {
            expect.assertions(1);

            // The row is gone, but the producer's own stamp still proves this is
            // not the run the caller holds a prefix of.
            expect(decideDurableAttach(undefined, { generation: GENERATION - 1, live: LIVE, resuming: true })).toBe("interrupted");
        });
    });

    describe("generation echo", () => {
        it("interrupts a resume whose generation does not match the stored run, even when it is live", () => {
            expect.assertions(2);

            const stored = run("running");

            expect(decideDurableAttach(stored, { generation: GENERATION - 1, live: LIVE, resuming: true })).toBe("interrupted");
            expect(decideDurableAttach(stored, { generation: GENERATION - 1, resuming: true })).toBe("interrupted");
        });

        it("interrupts a resume onto a terminal run of a different generation instead of replaying it", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("complete"), { generation: GENERATION - 1, resuming: true })).toBe("interrupted");
        });

        it("attaches a resume to the live producer when the generation matches", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("running"), { generation: GENERATION, live: LIVE, resuming: true })).toBe("attach");
        });

        it("replays a terminal run when the resume's generation matches", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("complete"), { generation: GENERATION, resuming: true })).toBe("replay-terminal");
        });

        it("ignores the generation on a fresh attach", () => {
            expect.assertions(1);

            // `sinceChunk: 0` means "asking fresh" — there is no held prefix a
            // mismatch could corrupt, so the stamp carries no meaning.
            expect(decideDurableAttach(run("complete"), { generation: GENERATION - 1, resuming: false })).toBe("reclaim");
        });

        it("preserves the pre-stamp behavior when the caller sends no generation (older client)", () => {
            expect.assertions(2);

            expect(decideDurableAttach(run("running"), { live: LIVE, resuming: true })).toBe("attach");
            expect(decideDurableAttach(run("complete"), { resuming: true })).toBe("replay-terminal");
        });
    });

    describe("terminal run", () => {
        it("replays the recorded outcome to a resuming caller", () => {
            expect.assertions(2);

            expect(decideDurableAttach(run("complete"), { resuming: true })).toBe("replay-terminal");
            expect(decideDurableAttach(run("error"), { resuming: true })).toBe("replay-terminal");
        });

        it("reclaims for a caller asking fresh", () => {
            expect.assertions(2);

            expect(decideDurableAttach(run("complete"), { resuming: false })).toBe("reclaim");
            expect(decideDurableAttach(run("error"), { resuming: false })).toBe("reclaim");
        });
    });

    describe("dead running run", () => {
        it("interrupts a resuming caller — the tail cannot be regenerated without duplicating it", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("running"), { resuming: true })).toBe("interrupted");
        });

        it("reclaims for a caller asking fresh so an eviction cannot wedge the key", () => {
            expect.assertions(1);

            expect(decideDurableAttach(run("running"), { resuming: false })).toBe("reclaim");
        });
    });

    describe("live run", () => {
        it("joins the live producer", () => {
            expect.assertions(2);

            expect(decideDurableAttach(run("running"), { live: LIVE, resuming: false })).toBe("attach");
            expect(decideDurableAttach(run("running"), { live: LIVE, resuming: true })).toBe("attach");
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

    /** Wait until the producer has fanned out its first chunk. Not an `expect` — a retried assertion would inflate `expect.assertions`. */
    const waitForFirstChunk = async (events: SinkEvent[]): Promise<void> =>
        vi.waitFor(() => {
            if (chunksOf(events).length === 0) {
                throw new Error("no chunk delivered yet");
            }
        });

    it("sweeps expired transcripts on a replay-terminal attach, not only when a NEW run starts", async () => {
        expect.assertions(3);

        // A run whose retention lapsed long ago...
        claimStreamRun(harness.sql, "expired", Date.now() - 100_000, 1);
        appendStreamChunk(harness.sql, "expired", 1, JSON.stringify("stale"));
        finishStreamRun(harness.sql, "expired", "complete", 1);

        // ...alongside a finished, still-in-retention run a caller replays.
        const kept = Date.now();

        claimStreamRun(harness.sql, "kept", kept, 86_400_000);
        appendStreamChunk(harness.sql, "kept", 1, JSON.stringify("hello"));
        appendStreamChunk(harness.sql, "kept", 2, JSON.stringify("again"));
        finishStreamRun(harness.sql, "kept", "complete", 2);

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const { events, sink } = recordingSink();

        // The replay-terminal branch returns before the run-claim path — the only
        // place the sweep used to run. A shard whose streaming settled into
        // replays (or stopped starting runs at all) therefore kept every expired
        // transcript forever, however long its retention had been set to.
        await runner.attach({
            generation: kept,
            iterator: () => {
                throw new Error("a replay must never re-run the handler");
            },
            runKey: "kept",
            sinceChunk: 1,
            sink,
        });

        expect(chunksOf(events).map((event) => event.data)).toStrictEqual(["again"]);
        expect(readStreamRun(harness.sql, "expired")).toBeUndefined();
        expect(readStreamRun(harness.sql, "kept")).toBeDefined();
    });

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
        expect.assertions(2);

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

        await waitForFirstChunk(first.events);

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

    it("rejoins a live producer whose row a TTL sweep deleted mid-run", async () => {
        expect.assertions(3);

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const first = recordingSink();
        const second = recordingSink();

        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const answer = async function* (): AsyncGenerator<string> {
            yield "live";
            await gate;
            yield "tail";
        };

        // A short retention with a generator that outlives it: the sweep deletes
        // on `startedAt + ttlMs` regardless of status, so the row goes while the
        // producer is still running.
        const producing = runner.attach({ iterator: () => answer(), runKey: "run-a", sinceChunk: 0, sink: first.sink, ttlMs: 50 });

        await waitForFirstChunk(first.events);

        const generation = chunksOf(first.events)[0]?.generation;

        trimStreamRuns(harness.sql, Date.now() + 60_000);

        expect(readStreamRun(harness.sql, "run-a")).toBeUndefined();

        // The consumer reconnects into that window. The producer IS the run —
        // it must rejoin and keep streaming, not be told the run is gone.
        await runner.attach({ generation, iterator: () => answer(), runKey: "run-a", sinceChunk: 1, sink: second.sink });

        release();
        await producing;

        expect(chunksOf(second.events).map((event) => event.data)).toStrictEqual(["tail"]);
        expect(second.events.at(-1)?.type).toBe("complete");
    });

    it("leaves no chunks behind when a TTL sweep took its run row mid-production", async () => {
        expect.assertions(3);

        const runner = new DurableStreamRunner({ sql: () => harness.sql });
        const first = recordingSink();

        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Long enough that the halves either side of the sweep both matter: the
        // first 20 chunks are persisted under a live row, the last 20 under a key
        // whose row the sweep already removed.
        const answer = async function* (): AsyncGenerator<string> {
            for (let index = 1; index <= 20; index += 1) {
                yield `dead-${String(index)}`;
            }

            await gate;

            for (let index = 21; index <= 40; index += 1) {
                yield `dead-${String(index)}`;
            }
        };

        const producing = runner.attach({ iterator: () => answer(), runKey: "run-a", sinceChunk: 0, sink: first.sink, ttlMs: 50 });

        await waitForFirstChunk(first.events);

        trimStreamRuns(harness.sql, Date.now() + 60_000);

        expect(readStreamRun(harness.sql, "run-a")).toBeUndefined();

        release();
        await producing;

        // The sweep's chunk delete is scoped by `run_key IN (SELECT ... FROM
        // __stream_runs ...)`, so anything appended after the row went is
        // unreachable by every future sweep — a permanent leak in the shard's
        // shared SQLite.
        expect(readStreamChunks(harness.sql, "run-a", 0)).toStrictEqual([]);

        // ...and because `appendStreamChunk` is `INSERT OR IGNORE`, the next run
        // under the same key silently inherits them: its own chunks at the
        // colliding seqs are dropped and the dead run's tail is what a reconnect
        // replays, under the new run's generation stamp.
        const fresh = recordingSink();

        const replacement = async function* (): AsyncGenerator<string> {
            for (let index = 1; index <= 40; index += 1) {
                yield `live-${String(index)}`;
            }
        };

        await runner.attach({ iterator: () => replacement(), runKey: "run-a", sinceChunk: 0, sink: fresh.sink });

        expect(readStreamChunks(harness.sql, "run-a", 0).map((chunk) => JSON.parse(chunk.dataJson) as string)).toStrictEqual(
            Array.from({ length: 40 }, (_, index) => `live-${String(index + 1)}`),
        );
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
