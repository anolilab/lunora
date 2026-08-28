import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    appendStreamChunk,
    claimStreamRun,
    deleteStreamRun,
    finishStreamRun,
    migrateDurableStreams,
    readStreamChunks,
    readStreamRun,
    trimStreamRuns,
} from "../src/durable-stream";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The persisted backing store for durable streams, driven through a real
 * SQLite engine: claim → append → read → finish is the lifecycle every run
 * goes through, and per-row TTL trimming is what keeps the shard's SQLite from
 * accumulating dead transcripts.
 */

const STARTED_AT = 1_700_000_000_000;
const TTL_MS = 86_400_000;

let harness: ReturnType<typeof createSqliteExec>;

describe("durable-stream store", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        migrateDurableStreams(harness.sql);
    });

    afterEach(() => {
        harness.close();
    });

    it("claims a run once and refuses the second claim under the same key", () => {
        expect.assertions(3);

        expect(claimStreamRun(harness.sql, "run-a", STARTED_AT, TTL_MS)).toBe(true);
        expect(claimStreamRun(harness.sql, "run-a", STARTED_AT + 1, TTL_MS)).toBe(false);

        // The losing claim did not overwrite the winner's row.
        expect(readStreamRun(harness.sql, "run-a")).toStrictEqual({ lastSeq: 0, startedAt: STARTED_AT, status: "running" });
    });

    it("round-trips a run: claim, append, read, finish", () => {
        expect.assertions(3);

        claimStreamRun(harness.sql, "run-a", STARTED_AT, TTL_MS);
        appendStreamChunk(harness.sql, "run-a", 1, JSON.stringify("the"));
        appendStreamChunk(harness.sql, "run-a", 2, JSON.stringify(" quick"));
        appendStreamChunk(harness.sql, "run-a", 3, JSON.stringify(" fox"));

        expect(readStreamChunks(harness.sql, "run-a", 0)).toStrictEqual([
            { dataJson: JSON.stringify("the"), seq: 1 },
            { dataJson: JSON.stringify(" quick"), seq: 2 },
            { dataJson: JSON.stringify(" fox"), seq: 3 },
        ]);

        finishStreamRun(harness.sql, "run-a", "complete", 3);

        expect(readStreamRun(harness.sql, "run-a")).toStrictEqual({ lastSeq: 3, startedAt: STARTED_AT, status: "complete" });

        // The transcript survives the terminal — that is what a late attach replays.
        expect(readStreamChunks(harness.sql, "run-a", 0)).toHaveLength(3);
    });

    it("filters replay to the chunks after sinceChunk", () => {
        expect.assertions(2);

        claimStreamRun(harness.sql, "run-a", STARTED_AT, TTL_MS);

        for (const seq of [1, 2, 3, 4]) {
            appendStreamChunk(harness.sql, "run-a", seq, JSON.stringify(seq));
        }

        expect(readStreamChunks(harness.sql, "run-a", 2).map((chunk) => chunk.seq)).toStrictEqual([3, 4]);
        // A watermark at the tail replays nothing.
        expect(readStreamChunks(harness.sql, "run-a", 4)).toStrictEqual([]);
    });

    it("records a failure's redacted code and message on the run row", () => {
        expect.assertions(1);

        claimStreamRun(harness.sql, "run-a", STARTED_AT, TTL_MS);
        appendStreamChunk(harness.sql, "run-a", 1, JSON.stringify("partial"));
        finishStreamRun(harness.sql, "run-a", "error", 1, { code: "UPSTREAM_TIMEOUT", message: "model timed out" });

        expect(readStreamRun(harness.sql, "run-a")).toStrictEqual({
            error: "model timed out",
            errorCode: "UPSTREAM_TIMEOUT",
            lastSeq: 1,
            startedAt: STARTED_AT,
            status: "error",
        });
    });

    it("deletes a run and its chunks together", () => {
        expect.assertions(2);

        claimStreamRun(harness.sql, "run-a", STARTED_AT, TTL_MS);
        appendStreamChunk(harness.sql, "run-a", 1, JSON.stringify("gone"));
        deleteStreamRun(harness.sql, "run-a");

        expect(readStreamRun(harness.sql, "run-a")).toBeUndefined();
        expect(readStreamChunks(harness.sql, "run-a", 0)).toStrictEqual([]);
    });

    it("trims each run by its OWN retention window", () => {
        expect.assertions(4);

        // A short-lived progress stream and a long-lived chat transcript on the
        // same shard: the sweep must take the first and leave the second.
        claimStreamRun(harness.sql, "run-short", STARTED_AT, 60_000);
        appendStreamChunk(harness.sql, "run-short", 1, JSON.stringify("tick"));
        claimStreamRun(harness.sql, "run-long", STARTED_AT, TTL_MS);
        appendStreamChunk(harness.sql, "run-long", 1, JSON.stringify("hello"));

        trimStreamRuns(harness.sql, STARTED_AT + 60_001);

        expect(readStreamRun(harness.sql, "run-short")).toBeUndefined();
        expect(readStreamChunks(harness.sql, "run-short", 0)).toStrictEqual([]);
        expect(readStreamRun(harness.sql, "run-long")).toBeDefined();
        expect(readStreamChunks(harness.sql, "run-long", 0)).toHaveLength(1);
    });
});
