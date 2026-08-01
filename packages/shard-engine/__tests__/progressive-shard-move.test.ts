/**
 * Plan 235 spike: prototype the progressive-sharding WAL + applied-watermark +
 * dual-read protocol for a 2-shard ring, entirely in tests.
 *
 * This exercises the state machine in `_helpers/progressive-shard-move.ts`
 * against the real `__cdc_log` WAL primitives (`ctx-db-cdc.ts`) and two
 * independent in-memory SQLite shards (`_helpers/node-sqlite.ts`). Nothing
 * here touches `shard-ring.ts`'s live routing path or `ShardDO` — see
 * `plans/235-progressive-sharding-design.md` for the protocol this models.
 *
 * The three DONE-criteria assertions from plan 235, one `describe` each:
 * (a) every key resolves to exactly one authoritative copy throughout the move;
 * (b) a dual-read fan-out during the propagation window returns each row
 * exactly once, even when source still holds a stale, undeleted copy;
 * (c) a write issued mid-move lands on the correct placement and is visible
 * after cutover.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCdcCursor } from "../src/ctx-db-cdc";
import { vnodeForId } from "../src/shard-ring";
import type { MoveCoordinator, ShardHarness, VnodeMoveState } from "./_helpers/progressive-shard-move";
import {
    beginVnodeMove,
    catchUpVnodes,
    cedeVnodes,
    createMoveCoordinator,
    createShardHarness,
    dualRead,
    quiesceVnodes,
    readMessage,
    resolveAuthoritativeShard,
    routeWrite,
    snapshotVnodes,
    writeMessage,
} from "./_helpers/progressive-shard-move";

const RING_SIZE = 16;
/** Half the ring — the "key range" the plan asks the prototype to move. */
const MOVING_VNODES = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
const SEED_COUNT = 200;

let source: ShardHarness;
let target: ShardHarness;
let coordinator: MoveCoordinator;
/** Ground truth: id -> body, as last durably written, independent of which shard holds it. */
let groundTruth: Map<string, string>;
let clock: number;

/** Seed `SEED_COUNT` deterministic documents on `source` before any move starts. */
const seed = (): void => {
    for (let index = 0; index < SEED_COUNT; index += 1) {
        const id = `doc_${String(index)}`;
        const body = `body-${String(index)}`;

        clock += 1;
        writeMessage(source, id, body, clock);
        groundTruth.set(id, body);
    }
};

/** Every seeded id that falls in a moving vnode, per the fixed ring/hash. */
const movingIds = (): string[] => [...groundTruth.keys()].filter((id) => MOVING_VNODES.has(vnodeForId(id, RING_SIZE)));

/** Every seeded id that stays on the source shard. */
const stayingIds = (): string[] => [...groundTruth.keys()].filter((id) => !MOVING_VNODES.has(vnodeForId(id, RING_SIZE)));

/**
 * Deterministically find an id (never one of the seeded `doc_N` ids) whose
 * vnode falls inside `vnodes` — used so "a write mid-move" provably exercises
 * the moving range rather than assuming a fresh id happens to land there.
 */
const findIdInVnodes = (prefix: string, vnodes: ReadonlySet<number>): string => {
    for (let index = 0; ; index += 1) {
        const candidate = `${prefix}_${String(index)}`;

        if (vnodes.has(vnodeForId(candidate, RING_SIZE))) {
            return candidate;
        }
    }
};

/**
 * Drive the move state machine from `beginVnodeMove` through a quiesced,
 * caught-up state (but NOT yet cut over) — the shared setup every scenario
 * below builds on.
 */
const runToQuiesced = (): VnodeMoveState => {
    let move = beginVnodeMove(source);

    snapshotVnodes(source, target, RING_SIZE, MOVING_VNODES);
    move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move);

    quiesceVnodes(coordinator, MOVING_VNODES);

    const quiesceSeq = readCdcCursor(source.sql);

    move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move, quiesceSeq);

    return { ...move, quiesceSeq };
};

/**
 * Commit cutover: enforces (by throwing, not by counting toward a test's
 * `expect.assertions`) that the target has exactly caught up to the quiesce
 * point — the applied-watermark protocol's precondition for a safe flip. A
 * caller that reaches this with the watermark still behind would otherwise
 * silently cede a vnode the target has not fully replicated.
 */
const cutover = (move: VnodeMoveState): void => {
    if (move.quiesceSeq === undefined || move.appliedWatermark !== move.quiesceSeq) {
        throw new Error(`cutover precondition failed: appliedWatermark=${String(move.appliedWatermark)} quiesceSeq=${String(move.quiesceSeq)}`);
    }

    cedeVnodes(coordinator, MOVING_VNODES);
};

describe("progressive shard move (plan 235 spike)", () => {
    beforeEach(() => {
        source = createShardHarness();
        target = createShardHarness();
        coordinator = createMoveCoordinator(RING_SIZE);
        groundTruth = new Map();
        clock = 0;

        seed();
    });

    afterEach(() => {
        source.close();
        target.close();
    });

    describe("exactly-once resolution", () => {
        it("resolves every key to source before the move starts", () => {
            // One `resolveAuthoritativeShard` check per seeded document.
            expect.assertions(200);

            for (const id of groundTruth.keys()) {
                expect(resolveAuthoritativeShard(coordinator, id)).toBe("source");
            }
        });

        it("keeps resolving to source through snapshot and catch-up — cutover has not committed yet", () => {
            // 1 watermark check + one resolve check and one content check per seeded document.
            expect.assertions(401);

            const move = runToQuiesced();

            // The applied-watermark protocol's signal: target has replayed the
            // source's WAL exactly up to the point writes were quiesced.
            expect(move.appliedWatermark).toBe(move.quiesceSeq);

            for (const id of groundTruth.keys()) {
                expect(resolveAuthoritativeShard(coordinator, id)).toBe("source");
            }

            // And the authoritative copy (source, for everyone right now) is still correct.
            for (const [id, body] of groundTruth) {
                expect(readMessage(source, id)?.body).toBe(body);
            }
        });

        it("flips moved keys to target and leaves staying keys on source after cutover — each with the correct content", () => {
            // One resolve check per seeded document + one content check per seeded document.
            expect.assertions(400);

            const move = runToQuiesced();

            cutover(move);

            for (const id of movingIds()) {
                expect(resolveAuthoritativeShard(coordinator, id)).toBe("target");
            }

            for (const id of stayingIds()) {
                expect(resolveAuthoritativeShard(coordinator, id)).toBe("source");
            }

            // Every key's authoritative shard holds the ground-truth content — never
            // stale, never missing.
            for (const [id, body] of groundTruth) {
                const shard = resolveAuthoritativeShard(coordinator, id) === "target" ? target : source;

                expect(readMessage(shard, id)?.body).toBe(body);
            }
        });
    });

    describe("dual-read window dedup", () => {
        it("returns each row exactly once, preferring target's fresher copy over source's stale, undeleted one", () => {
            expect.assertions(6);

            const move = runToQuiesced();

            cutover(move);

            // Cutover purges nothing from source (the design's drain-close step is
            // separate and deferred) — so source still physically holds its stale
            // pre-move rows for every moved id. A dual-read during the propagation
            // window would see BOTH copies for these ids.
            const [sampleId] = movingIds();
            const originalBody = groundTruth.get(sampleId as string);

            expect(sampleId).toBeDefined();
            expect(readMessage(source, sampleId as string)?.body).toBe(originalBody);

            // Diverge target from source: a write forwarded through the coordinator
            // after cutover lands on target only — source's copy is now genuinely
            // stale, not merely absent.
            clock += 1;

            const newBody = "forwarded-update";
            const route = routeWrite(coordinator, source, target, sampleId as string, newBody, clock);

            expect(route).toBe("forwarded");
            // Source's undeleted copy still reads the OLD body — the divergence the
            // dedup rule must resolve, not just an id present on one side only.
            expect(readMessage(source, sampleId as string)?.body).toBe(originalBody);

            // A fan-out over a mixed batch (moved ids with stale source copies +
            // staying ids that only ever existed on source) must merge to exactly
            // one row per id, and pick target's fresher value where both exist.
            const batch = [...movingIds().slice(0, 20), ...stayingIds().slice(0, 20)];
            const merged = dualRead(source, target, batch);

            expect(merged.size).toBe(batch.length);
            // The merged row for the diverged id is target's fresh value, not
            // source's stale one — this is what "preferring target" actually means.
            expect(merged.get(sampleId as string)?.body).toBe(newBody);
        });

        it("never drops or duplicates a row across a larger mixed batch", () => {
            // 1 size check + one content check per seeded document.
            expect.assertions(201);

            const move = runToQuiesced();

            cutover(move);

            const allIds = [...groundTruth.keys()];
            const merged = dualRead(source, target, allIds);

            expect(merged.size).toBe(allIds.length);

            for (const [id, body] of groundTruth) {
                expect(merged.get(id)?.body).toBe(body);
            }
        });
    });

    describe("mid-move write correctness", () => {
        it("lands a write issued during catch-up on source, replays it via the WAL, and it is visible on target after cutover", () => {
            expect.assertions(4);

            let move = beginVnodeMove(source);

            snapshotVnodes(source, target, RING_SIZE, MOVING_VNODES);

            // A write arrives mid-move, before quiesce — routed to source, same as
            // any pre-cutover write. Deterministically chosen to fall in the
            // MOVING range, so catch-up replay is actually exercised below.
            const midMoveId = findIdInVnodes("doc_mid_move", MOVING_VNODES);
            const midMoveBody = "written-during-catch-up";

            clock += 1;

            const route = routeWrite(coordinator, source, target, midMoveId, midMoveBody, clock);

            expect(route).toBe("source");
            // Not yet caught up — target has no idea this write happened.
            expect(readMessage(target, midMoveId)).toBeUndefined();

            // Catch-up replays it onto target via the WAL.
            move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move);

            quiesceVnodes(coordinator, MOVING_VNODES);

            const quiesceSeq = readCdcCursor(source.sql);

            move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move, quiesceSeq);
            move = { ...move, quiesceSeq };

            cutover(move);

            // midMoveId is in the moving range by construction, so cutover must
            // have flipped it to target, and the replayed write must be there.
            expect(resolveAuthoritativeShard(coordinator, midMoveId)).toBe("target");
            expect(readMessage(target, midMoveId)?.body).toBe(midMoveBody);
        });

        it("rejects a write to a quiesced vnode, so the coordinator retries it through the winning placement instead of losing it", () => {
            expect.assertions(3);

            let move = beginVnodeMove(source);

            snapshotVnodes(source, target, RING_SIZE, MOVING_VNODES);
            move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move);

            quiesceVnodes(coordinator, MOVING_VNODES);

            const [id] = movingIds();

            expect(id).toBeDefined();

            clock += 1;

            const duringQuiesce = routeWrite(coordinator, source, target, id as string, "should-not-land-yet", clock);

            expect(duringQuiesce).toBe("quiesced");

            // The value never landed anywhere — a real coordinator retries after
            // cutover, which is exactly `routeWrite`'s "forwarded" branch.
            const quiesceSeq = readCdcCursor(source.sql);

            move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move, quiesceSeq);
            cutover({ ...move, quiesceSeq });

            clock += 1;

            const afterCutover = routeWrite(coordinator, source, target, id as string, "retried-after-cutover", clock);

            expect(afterCutover).toBe("forwarded");
        });
    });
});
