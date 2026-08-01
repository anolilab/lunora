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
    deleteMessage,
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
            expect.assertions(SEED_COUNT);

            for (const id of groundTruth.keys()) {
                expect(resolveAuthoritativeShard(coordinator, id)).toBe("source");
            }
        });

        it("keeps resolving to source through snapshot and catch-up — cutover has not committed yet", () => {
            // 1 watermark check + one resolve check and one content check per seeded document.
            expect.assertions(2 * SEED_COUNT + 1);

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
            expect.assertions(2 * SEED_COUNT);

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

    describe("applied-watermark protocol under interleaved traffic", () => {
        it("advances past a staying-vnode's tail write, so cutover does not deadlock when it — not a moving-vnode write — is last before quiesce", () => {
            // Every one of the other scenarios writes everything in `seed()` before
            // the move starts, or makes the last pre-quiesce write land inside the
            // moving range — both dodge the realistic case where an ordinary write
            // to a vnode that never moves happens to be the log's tail when quiesce
            // fires. `quiesceSeq` is `readCdcCursor(source)`, the shard's GLOBAL
            // high-watermark across every vnode, so a watermark that only advanced
            // for moving-vnode entries would never consume that tail write and
            // would lag `quiesceSeq` forever — cutover's precondition would never
            // close even though the moving vnodes are fully replicated.
            expect.assertions(2);

            let move = beginVnodeMove(source);

            snapshotVnodes(source, target, RING_SIZE, MOVING_VNODES);
            move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move);

            quiesceVnodes(coordinator, MOVING_VNODES);

            const stayingId = stayingIds()[0] as string;

            clock += 1;

            const route = routeWrite(coordinator, source, target, stayingId, { body: "last-write-before-quiesce-on-a-staying-vnode" }, clock);

            expect(route).toBe("source");

            const quiesceSeq = readCdcCursor(source.sql);

            move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move, quiesceSeq);

            // The watermark protocol's core signal, and cutover's precondition —
            // both must hold even though the tail entry belonged to a vnode that
            // never moves.
            expect(move.appliedWatermark).toBe(quiesceSeq);
        });
    });

    describe("catch-up paging", () => {
        it("replays a WAL tail longer than one `readCdcChanges` page (1000 rows) in a single `catchUpVnodes` call", () => {
            // Design doc §2.4 says catch-up "runs however many times is needed" —
            // a mover that only ever reads one bounded page would silently stop
            // short of a real WAL tail once a busy shard's backlog crosses
            // `readCdcChanges`'s 1000-row page limit.
            expect.assertions(3);

            let move = beginVnodeMove(source);

            snapshotVnodes(source, target, RING_SIZE, MOVING_VNODES);

            const pagedId = findIdInVnodes("doc_paged", MOVING_VNODES);
            const finalBody = "final-body-after-1200-writes";
            const writeCount = 1200;

            for (let index = 0; index < writeCount; index += 1) {
                clock += 1;
                writeMessage(source, pagedId, index === writeCount - 1 ? finalBody : `intermediate-${String(index)}`, clock);
            }

            quiesceVnodes(coordinator, MOVING_VNODES);

            const quiesceSeq = readCdcCursor(source.sql);

            move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move, quiesceSeq);

            expect(move.appliedWatermark).toBe(quiesceSeq);
            expect(() => cutover({ ...move, quiesceSeq })).not.toThrow();
            expect(readMessage(target, pagedId)?.body).toBe(finalBody);
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
            const route = routeWrite(coordinator, source, target, sampleId as string, { body: newBody }, clock);

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
            expect.assertions(SEED_COUNT + 1);

            const move = runToQuiesced();

            cutover(move);

            const allIds = [...groundTruth.keys()];
            const merged = dualRead(source, target, allIds);

            expect(merged.size).toBe(allIds.length);

            for (const [id, body] of groundTruth) {
                expect(merged.get(id)?.body).toBe(body);
            }
        });

        it("forwards a delete on a moved row to target and does not resurrect source's stale pre-move copy via dualRead", () => {
            // The delete path was entirely untested before this: `deleteMessage`
            // was exported but unused, `applyChangeToTarget`'s delete branch was
            // never reached, and `routeWrite` had no delete branch at all. Without
            // a target-side tombstone, a target miss during the dual-read window
            // is indistinguishable from "target hasn't replicated this id yet" —
            // and the read would fall through to source's stale, still-physically-
            // present copy, resurrecting a row the caller believes is gone.
            expect.assertions(5);

            const move = runToQuiesced();

            cutover(move);

            const [movedId] = movingIds();
            const originalBody = groundTruth.get(movedId as string);

            expect(movedId).toBeDefined();
            // Cutover purges nothing from source (drain-close is a separate,
            // deferred step) — source still physically holds the pre-move row.
            expect(readMessage(source, movedId as string)?.body).toBe(originalBody);

            clock += 1;

            // The vnode was ceded at cutover, so this delete is forwarded to
            // target — exercising `routeWrite`'s delete branch and `deleteMessage`.
            const route = routeWrite(coordinator, source, target, movedId as string, { op: "delete" }, clock);

            expect(route).toBe("forwarded");
            expect(readMessage(target, movedId as string)).toBeUndefined();

            // The assertion that actually catches the bug: a dualRead during the
            // propagation window must see the row as absent — not fall through to
            // source's undeleted, stale copy.
            const merged = dualRead(source, target, [movedId as string]);

            expect(merged.has(movedId as string)).toBe(false);
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

            const route = routeWrite(coordinator, source, target, midMoveId, { body: midMoveBody }, clock);

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

            const duringQuiesce = routeWrite(coordinator, source, target, id as string, { body: "should-not-land-yet" }, clock);

            expect(duringQuiesce).toBe("quiesced");

            // The value never landed anywhere — a real coordinator retries after
            // cutover, which is exactly `routeWrite`'s "forwarded" branch.
            const quiesceSeq = readCdcCursor(source.sql);

            move = catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move, quiesceSeq);
            cutover({ ...move, quiesceSeq });

            clock += 1;

            const afterCutover = routeWrite(coordinator, source, target, id as string, { body: "retried-after-cutover" }, clock);

            expect(afterCutover).toBe("forwarded");
        });

        it("replays a delete issued on source during catch-up onto target via the WAL", () => {
            // Exercises `applyChangeToTarget`'s op==="delete" branch, which — like
            // the delete path generally — nothing reached before this: a delete
            // that happens on source (still authoritative pre-quiesce) must be
            // walked past by the SAME `catchUpVnodes` replay as an insert/update,
            // removing the row `snapshotVnodes` already base-copied onto target.
            expect.assertions(3);

            const move = beginVnodeMove(source);

            snapshotVnodes(source, target, RING_SIZE, MOVING_VNODES);

            const [deletedId] = movingIds();

            expect(deletedId).toBeDefined();
            // Base-copied by `snapshotVnodes` above — present on target until the
            // delete replays below.
            expect(readMessage(target, deletedId as string)).toBeDefined();

            clock += 1;
            deleteMessage(source, deletedId as string, clock);

            catchUpVnodes(source, target, RING_SIZE, MOVING_VNODES, move);

            expect(readMessage(target, deletedId as string)).toBeUndefined();
        });
    });
});
