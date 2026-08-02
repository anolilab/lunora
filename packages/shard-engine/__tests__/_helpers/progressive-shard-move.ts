// Test-only prototype for plan 235 — the progressive-sharding WAL + applied-watermark
// + dual-read protocol, exercised entirely against the existing in-memory SQLite
// harness (`node-sqlite.ts`) and the existing `__cdc_log` WAL primitives from
// `ctx-db-cdc.ts`. Nothing here is imported by, or wired into, `ShardDO` or
// `shard-ring.ts`'s live routing path — see `plans/235-progressive-sharding-design.md`
// for the protocol this models and its open questions.
//
// The design's central claim, tested below: a shard receiving a write enforces
// placement authority itself (source refuses/forwards once it has ceded a vnode),
// so correctness does not depend on every caller holding a fresh directory —
// only on the shard being the one true arbiter of whether it currently owns a key.

import type { SqlExec } from "../../src/ctx-db";
import type { CdcChange } from "../../src/ctx-db-cdc";
import { appendCdcChange, migrateCdcLog, readCdcChanges, readCdcCursor } from "../../src/ctx-db-cdc";
import { vnodeForId } from "../../src/shard-ring";
import createSqliteExec from "./node-sqlite";

/** A single shard's store in the prototype: one `messages` table plus its `__cdc_log` WAL. */
interface ShardHarness {
    close: () => void;
    raw: (query: string, ...params: unknown[]) => Record<string, unknown>[];
    sql: SqlExec;
}

/** One row of the toy `messages` table the prototype moves between shards. */
interface MessageRow {
    body: string;
    id: string;
}

/**
 * Create a shard: an in-memory SQLite store with the `messages` table, its
 * `__cdc_log` migrated, and a `__tombstones` side table.
 *
 * `__tombstones` exists to make a shard's own delete authoritative over a
 * stale row another shard still physically holds (see `dualRead`'s tombstone
 * check below, and design doc §6 "delete-during-move"). Without it, a target
 * that deletes a moved row during the dual-read window looks identical — to a
 * fan-out read — to a target that simply hasn't replicated that id yet, and
 * the read falls through to `source`'s stale pre-move copy, resurrecting a
 * delete.
 */
const createShardHarness = (): ShardHarness => {
    const harness = createSqliteExec();

    harness.raw("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    harness.raw("CREATE TABLE IF NOT EXISTS __tombstones (id TEXT PRIMARY KEY)");
    migrateCdcLog(harness.sql);

    return harness;
};

/** Record that `shard` has authoritatively deleted `id` — see `createShardHarness`'s doc. */
const markTombstone = (shard: ShardHarness, id: string): void => {
    shard.raw("INSERT INTO __tombstones (id) VALUES (?) ON CONFLICT(id) DO NOTHING", id);
};

/** Clear `id`'s tombstone on `shard` — a row live again (re-created after a delete) is no longer a deletion. */
const clearTombstone = (shard: ShardHarness, id: string): void => {
    shard.raw("DELETE FROM __tombstones WHERE id = ?", id);
};

/** Whether `shard` has authoritatively deleted `id` (and so must not be skipped past to a peer's stale copy). */
const hasTombstone = (shard: ShardHarness, id: string): boolean => shard.raw("SELECT id FROM __tombstones WHERE id = ?", id).length > 0;

/** Write (insert-or-update) a document on `shard` and append the matching WAL entry. */
const writeMessage = (shard: ShardHarness, id: string, body: string, ts: number): void => {
    const existing = shard.raw("SELECT id FROM messages WHERE id = ?", id);

    shard.raw("INSERT INTO messages (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", id, body);
    clearTombstone(shard, id);
    appendCdcChange(shard.sql, ts, "messages", id, existing.length > 0 ? "update" : "insert", { body });
};

/** Delete a document on `shard`, mark its tombstone, and append the matching WAL entry. */
const deleteMessage = (shard: ShardHarness, id: string, ts: number): void => {
    shard.raw("DELETE FROM messages WHERE id = ?", id);
    markTombstone(shard, id);
    appendCdcChange(shard.sql, ts, "messages", id, "delete", undefined);
};

/** Read one document from `shard`, or `undefined` if it does not hold that id. */
const readMessage = (shard: ShardHarness, id: string): MessageRow | undefined => {
    const rows = shard.raw("SELECT id, body FROM messages WHERE id = ?", id) as unknown as MessageRow[];

    return rows[0];
};

/** All document ids currently stored on `shard`. */
const listMessageIds = (shard: ShardHarness): string[] => (shard.raw("SELECT id FROM messages") as { id: string }[]).map((row) => row.id);

/**
 * Progress of moving a set of vnodes from one shard to another.
 * `snapshotSeq` is the source WAL cursor at the moment the base copy ran;
 * `appliedWatermark` is the target's cursor into the source's WAL — the
 * applied-watermark protocol's whole state. `quiesceSeq`, once set, is the
 * source cursor captured when new writes to the moving vnodes were paused for
 * cutover; cutover is legal exactly when `appliedWatermark === quiesceSeq`.
 */
interface VnodeMoveState {
    readonly appliedWatermark: number;
    readonly quiesceSeq?: number;
    readonly snapshotSeq: number;
}

/**
 * Start a move: record the source's current WAL cursor as the snapshot
 * boundary. `appliedWatermark` starts equal to `snapshotSeq`, not `0` — the
 * base copy a caller is about to take (see {@link snapshotVnodes}) already
 * captures every write up to this cursor, so the target is "caught up
 * through `snapshotSeq`" the moment the copy finishes, before any WAL replay
 * happens at all. Treating the watermark as `0` here would make the target
 * look permanently behind on a quiet ring — `catchUpVnodes` would keep
 * waiting for the (never-arriving) tail below `snapshotSeq` that the
 * snapshot, not the WAL, already accounts for.
 */
const beginVnodeMove = (source: ShardHarness): VnodeMoveState => {
    const snapshotSeq = readCdcCursor(source.sql);

    return { appliedWatermark: snapshotSeq, snapshotSeq };
};

/**
 * Base-copy every row belonging to `movingVnodes` from `source` to `target`, as
 * of right now. Must run without interleaved writes to those vnodes (the
 * prototype's tests never write mid-snapshot; a real shard would enforce this
 * with the same single-threaded-DO guarantee it already relies on for OCC).
 */
const snapshotVnodes = (source: ShardHarness, target: ShardHarness, ringSize: number, movingVnodes: ReadonlySet<number>): void => {
    const rows = source.raw("SELECT id, body FROM messages") as unknown as MessageRow[];

    for (const row of rows) {
        if (movingVnodes.has(vnodeForId(row.id, ringSize))) {
            target.raw("INSERT INTO messages (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", row.id, row.body);
        }
    }
};

/** Apply one WAL entry (already known to belong to a moving vnode) onto `target`, keeping its tombstone state in sync. */
const applyChangeToTarget = (target: ShardHarness, change: CdcChange): void => {
    if (change.op === "delete") {
        target.raw("DELETE FROM messages WHERE id = ?", change.id);
        markTombstone(target, change.id);

        return;
    }

    target.raw("INSERT INTO messages (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", change.id, change.doc?.["body"] ?? "");
    clearTombstone(target, change.id);
};

/** `readCdcChanges` clamps a single call to this many rows; `catchUpVnodes` pages past it below. */
const CATCH_UP_PAGE_LIMIT = 1000;

/**
 * Replay `source`'s WAL onto `target`, filtered to `movingVnodes`, from the
 * move's current `appliedWatermark` up to `upToSeq` (inclusive) if given, else
 * to the end of the log. Pages through `readCdcChanges` — which clamps a
 * single call to `CATCH_UP_PAGE_LIMIT` rows — until a page comes back short
 * (or `upToSeq` truncates it), so a WAL tail longer than one page is fully
 * consumed in one call, matching the design doc's §2.4 "runs however many
 * times is needed" claim rather than silently stopping at the first page.
 *
 * Returns the move state with `appliedWatermark` advanced to the highest
 * `seq` it has consumed (not the highest it has applied — see the comment
 * inline below). That is the applied-watermark signal a target uses to tell a
 * coordinator "I have caught up to this point", and it must track the WAL
 * position walked past, or cutover's `appliedWatermark === quiesceSeq` gate
 * can never close under interleaved traffic (see `catchUpVnodes`'s test
 * coverage in `progressive-shard-move.test.ts`).
 */
const catchUpVnodes = (
    source: ShardHarness,
    target: ShardHarness,
    ringSize: number,
    movingVnodes: ReadonlySet<number>,
    move: VnodeMoveState,
    upToSeq?: number,
): VnodeMoveState => {
    // `appliedWatermark` already incorporates the snapshot floor (see
    // `beginVnodeMove`), so paging from it alone is correct and idempotent
    // across repeated calls — each call only ever sees the tail it hasn't
    // consumed yet.
    let watermark = move.appliedWatermark;

    for (;;) {
        const { changes } = readCdcChanges(source.sql, { limit: CATCH_UP_PAGE_LIMIT, sinceSeq: watermark, tables: new Set(["messages"]) });

        if (changes.length === 0) {
            break;
        }

        let truncatedByUpToSeq = false;

        for (const change of changes) {
            if (upToSeq !== undefined && change.seq > upToSeq) {
                truncatedByUpToSeq = true;

                break;
            }

            // Advance the watermark for EVERY entry consumed, not only the ones
            // that belong to a moving vnode. `quiesceSeq` (the cutover gate's
            // other side) is `readCdcCursor(source)` — the shard's GLOBAL
            // high-watermark across ALL vnodes, staying ones included. Under
            // realistic interleaved traffic the last write before quiesce is
            // just as likely to land on a staying vnode as a moving one; if
            // the watermark only moved inside the `movingVnodes` filter below,
            // a staying-vnode tail write would never be consumed and
            // `appliedWatermark` would lag `quiesceSeq` forever — cutover's
            // precondition would never close even though every moving vnode is
            // already fully replicated. Tracking "log position consumed"
            // rather than "last moving-vnode seq applied" is what keeps the
            // two cursors on the same footing.
            watermark = change.seq;

            if (!movingVnodes.has(vnodeForId(change.id, ringSize))) {
                continue;
            }

            applyChangeToTarget(target, change);
        }

        if (truncatedByUpToSeq || changes.length < CATCH_UP_PAGE_LIMIT) {
            // A short page (or an `upToSeq` cutoff mid-page) means there is
            // nothing further to fetch right now — `readCdcChanges` applies no
            // filter besides `sinceSeq`/`tables`, so a page smaller than the
            // limit is proof the log's tail (for this table) has been reached.
            break;
        }
    }

    return { ...move, appliedWatermark: Math.max(watermark, move.appliedWatermark) };
};

/**
 * A move coordinator's live routing state for one migration: which vnodes are
 * momentarily blocking new writes (the cutover quiesce gate) and which vnodes
 * the source has already ceded to the target (post-cutover forwarding). This
 * is the test-local stand-in for the directory-flip + forwarding shim the
 * design doc specifies — deliberately NOT `shard-ring.ts`'s `VnodeDirectory`,
 * since that type stays routing-only and untouched by this spike.
 */
interface MoveCoordinator {
    readonly cededVnodes: Set<number>;
    readonly quiescedVnodes: Set<number>;
    readonly ringSize: number;
}

const createMoveCoordinator = (ringSize: number): MoveCoordinator => {
    return { cededVnodes: new Set(), quiescedVnodes: new Set(), ringSize };
};

/** Enter the cutover gate: block new writes to `vnodes` on the source (the brief window before the atomic directory flip). */
const quiesceVnodes = (coordinator: MoveCoordinator, vnodes: ReadonlySet<number>): void => {
    for (const vnode of vnodes) {
        coordinator.quiescedVnodes.add(vnode);
    }
};

/**
 * Commit the atomic directory flip: `vnodes` move from quiesced to ceded, so
 * `resolveAuthoritativeShard` now answers `"target"` and any write source still
 * receives for them is forwarded rather than applied locally.
 */
const cedeVnodes = (coordinator: MoveCoordinator, vnodes: ReadonlySet<number>): void => {
    for (const vnode of vnodes) {
        coordinator.quiescedVnodes.delete(vnode);
        coordinator.cededVnodes.add(vnode);
    }
};

/** Which shard is authoritative for `id` right now, per the coordinator's cede state. */
const resolveAuthoritativeShard = (coordinator: MoveCoordinator, id: string): "source" | "target" =>
    coordinator.cededVnodes.has(vnodeForId(id, coordinator.ringSize)) ? "target" : "source";

/** What `routeWrite` applies for one routed operation: an upsert (`body`) or a delete. */
type RouteChange = { readonly body: string } | { readonly op: "delete" };

/**
 * Route a write or delete through the coordinator: forwarded to `target` if
 * the key's vnode has already been ceded (post-cutover), rejected if the
 * vnode is mid-cutover-quiesce (the brief window a real shard would
 * queue-and-retry rather than throw), else applied on `source` as normal.
 * This is the write-side half of the "no missing/duplicated rows" guarantee:
 * `source` enforces its own cede state on every operation it receives,
 * regardless of which directory version the caller resolved from — deletes
 * included, so a delete issued against a moved key during the propagation
 * window still lands (forwarded) on the shard that is actually authoritative
 * for it, and marks that shard's tombstone (see `deleteMessage`), rather than
 * being silently dropped or misapplied to `source`.
 */
const routeWrite = (
    coordinator: MoveCoordinator,
    source: ShardHarness,
    target: ShardHarness,
    id: string,
    change: RouteChange,
    ts: number,
): "forwarded" | "quiesced" | "source" => {
    const vnode = vnodeForId(id, coordinator.ringSize);
    const apply = (shard: ShardHarness): void => {
        if ("op" in change && change.op === "delete") {
            deleteMessage(shard, id, ts);
        } else if ("body" in change) {
            writeMessage(shard, id, change.body, ts);
        }
    };

    if (coordinator.cededVnodes.has(vnode)) {
        apply(target);

        return "forwarded";
    }

    if (coordinator.quiescedVnodes.has(vnode)) {
        return "quiesced";
    }

    apply(source);

    return "source";
};

/**
 * Dual-read fan-out for the propagation window: query both shards for `ids`
 * and merge by identity, target-wins-if-present (see the design doc's dedup
 * rule). Returns a `Map` keyed by id, which is what makes "each row exactly
 * once" a structural property of the merge rather than a manual count.
 *
 * A target tombstone is authoritative and short-circuits the merge for that
 * id — it is NOT treated the same as "target doesn't have it yet" (which
 * falls through to `source`). Without this check, a delete applied to
 * `target` during the dual-read window is indistinguishable, from a fan-out
 * read's point of view, from a row `target` simply hasn't replicated yet —
 * and falling through would hand back `source`'s stale, undeleted pre-move
 * copy, resurrecting a delete the caller believes already happened (see
 * design doc §6).
 */
const dualRead = (source: ShardHarness, target: ShardHarness, ids: ReadonlyArray<string>): Map<string, MessageRow> => {
    const merged = new Map<string, MessageRow>();

    for (const id of ids) {
        if (hasTombstone(target, id)) {
            continue;
        }

        const fromTarget = readMessage(target, id);

        if (fromTarget) {
            merged.set(id, fromTarget);

            continue;
        }

        const fromSource = readMessage(source, id);

        if (fromSource) {
            merged.set(id, fromSource);
        }
    }

    return merged;
};

export {
    applyChangeToTarget,
    beginVnodeMove,
    catchUpVnodes,
    cedeVnodes,
    createMoveCoordinator,
    createShardHarness,
    deleteMessage,
    dualRead,
    listMessageIds,
    quiesceVnodes,
    readMessage,
    resolveAuthoritativeShard,
    routeWrite,
    snapshotVnodes,
    writeMessage,
};
export type { MessageRow, MoveCoordinator, ShardHarness, VnodeMoveState };
