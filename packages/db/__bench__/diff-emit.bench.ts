import { bench, describe } from "vitest";

import type { SyncWriter } from "../src/internals";
import { makeDiffEmit, toMap } from "../src/internals";

/*
 * `makeDiffEmit` runs on every live-query tick: the server pushes a fresh keyed
 * snapshot and the emitter decides, per row, whether the collection's sync
 * channel sees an insert, an update, or nothing at all. It is the per-row floor
 * of `@lunora/db`'s reactivity, and its cost is dominated by `JSON.stringify`
 * over each incoming row.
 *
 * Two properties are worth guarding, and both are visible here:
 *
 *  1. Each incoming row is serialized EXACTLY once per tick — the serialized
 *     string is reused for both the change comparison and the cache refill.
 *     Re-serializing the previous row for comparison would roughly double the
 *     work; the "steady state, nothing changed" bench is where that shows up,
 *     because it is pure comparison with zero writes.
 *  2. Cost tracks the size of the incoming snapshot, not the size of the
 *     collection — hence the small-delta-over-large-collection bench.
 *
 * `sink` deliberately does nothing: this measures the emitter, not a consumer.
 */

// ---- Fixtures ------------------------------------------------------------

interface Row {
    active: boolean;
    id: string;
    name: string;
    score: number;
    tags: string[];
}

const makeRow = (index: number): Row => {
    return {
        active: index % 3 === 0,
        id: `row-${String(index)}`,
        name: `user ${String(index)}`,
        score: index * 7,
        tags: ["alpha", "beta"],
    };
};

const rows = (count: number): Row[] => Array.from({ length: count }, (_, index) => makeRow(index));

const byId = (row: Row): string => row.id;

/** A writer that records nothing — the bench measures the diff, not the sink. */
const sink: SyncWriter<Row> = {
    begin: () => {},
    commit: () => {},
    write: () => {},
};

const SNAPSHOT_SIZE = 500;

const snapshot = toMap(rows(SNAPSHOT_SIZE), byId);

/** Same rows, one field changed on 5% of them. */
const smallDelta = toMap(
    rows(SNAPSHOT_SIZE).map((row, index) => (index % 20 === 0 ? { ...row, score: row.score + 1 } : row)),
    byId,
);

/** Same rows, every one changed. */
const fullChurn = toMap(
    rows(SNAPSHOT_SIZE).map((row) => {
        return { ...row, score: row.score + 1 };
    }),
    byId,
);

/** Half the rows dropped — exercises the delete sweep over the synced cache. */
const halfRemoved = toMap(rows(SNAPSHOT_SIZE).slice(0, SNAPSHOT_SIZE / 2), byId);

/*
 * The synced-JSON cache as it looks after `snapshot` has been emitted once.
 * Computed ONCE here, then copied per iteration below.
 *
 * A bench body cannot simply call `emit(snapshot)` to prime itself: `emit`
 * mutates the cache it closes over, so the second iteration would compare
 * against the state the first one left behind and measure a no-op instead of
 * the intended delta. Re-priming inside the body would instead fold a full
 * 500-row serialization into every sample and swamp the difference between the
 * cases. Copying a precomputed `Map` of short strings is far cheaper than
 * re-serializing, and every bench below pays it — including cold start, which
 * copies an empty map of the same shape purely so the setup cost is identical
 * across all five. Without that, cold start would be the only case not paying
 * it, and the local run showed the skew flipping `small delta` and `full churn`
 * into an impossible order.
 */
const primedCache = ((): Map<string, string> => {
    const cache = new Map<string, string>();

    makeDiffEmit<Row>(cache, sink)(snapshot);

    return cache;
})();

/** An empty cache, copied per iteration so cold start pays the same setup as the rest. */
const emptyCache = new Map<string, string>();

/** A fresh emitter whose synced cache already reflects `snapshot`. */
const primed = (): ((next: Map<string, Row>) => void) => makeDiffEmit<Row>(new Map(primedCache), sink);

/**
 * Emitting the SAME snapshot is idempotent — it leaves the cache exactly as it
 * found it — so this one emitter can be reused across every iteration with no
 * per-iteration copy at all. That matters here specifically: this is the case
 * whose whole point is that it does no writes, so it is the smallest number on
 * the board and the one a constant setup cost would distort most.
 */
const steadyEmit = makeDiffEmit<Row>(new Map(primedCache), sink);

/** Prebuilt row list for the `toMap` bench — building it is not what is measured. */
const rowList = rows(SNAPSHOT_SIZE);

// ---- Benches -------------------------------------------------------------

describe("makeDiffEmit — 500-row snapshot", () => {
    bench("cold start (every row an insert)", () => {
        makeDiffEmit<Row>(new Map(emptyCache), sink)(snapshot);
    });

    bench("steady state (identical snapshot, zero writes)", () => {
        steadyEmit(snapshot);
    });

    /*
     * Do not be surprised that this lands at or just below `full churn` despite
     * writing 25 rows instead of 500. The writes are the cheap part (the sink is
     * a no-op); the cost is the per-row string compare, and an UNCHANGED row is
     * the expensive case — two equal strings with different backing objects
     * compare character by character to the end, while a changed row can differ
     * early and bail. 5% changed therefore means 95% full-length compares.
     */
    bench("small delta (5% of rows changed)", () => {
        primed()(smallDelta);
    });

    bench("full churn (every row changed)", () => {
        primed()(fullChurn);
    });

    bench("half the rows removed", () => {
        primed()(halfRemoved);
    });
});

describe("toMap — indexing a row list by key", () => {
    bench("500 rows", () => {
        toMap(rowList, byId);
    });
});
