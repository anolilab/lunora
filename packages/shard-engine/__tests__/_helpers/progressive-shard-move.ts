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

/** Create a shard: an in-memory SQLite store with the `messages` table and `__cdc_log` migrated. */
const createShardHarness = (): ShardHarness => {
    const harness = createSqliteExec();

    harness.raw("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    migrateCdcLog(harness.sql);

    return harness;
};

/** Write (insert-or-update) a document on `shard` and append the matching WAL entry. */
const writeMessage = (shard: ShardHarness, id: string, body: string, ts: number): void => {
    const existing = shard.raw("SELECT id FROM messages WHERE id = ?", id);

    shard.raw("INSERT INTO messages (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", id, body);
    appendCdcChange(shard.sql, ts, "messages", id, existing.length > 0 ? "update" : "insert", { body });
};

/** Delete a document on `shard` and append the matching WAL entry. */
const deleteMessage = (shard: ShardHarness, id: string, ts: number): void => {
    shard.raw("DELETE FROM messages WHERE id = ?", id);
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

/** Apply one WAL entry (already known to belong to a moving vnode) onto `target`. */
const applyChangeToTarget = (target: ShardHarness, change: { body?: string; id: string; op: "delete" | "insert" | "update" }): void => {
    if (change.op === "delete") {
        target.raw("DELETE FROM messages WHERE id = ?", change.id);

        return;
    }

    target.raw("INSERT INTO messages (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", change.id, change.body ?? "");
};

/**
 * Replay `source`'s WAL onto `target`, filtered to `movingVnodes`, from the
 * move's current `appliedWatermark` up to `upToSeq` (inclusive) if given, else
 * to the end of the log. Returns the move state with `appliedWatermark`
 * advanced to the highest replayed `seq` — the applied-watermark signal a
 * target uses to tell a coordinator "I have caught up to this point".
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
    // replayed yet.
    const { changes } = readCdcChanges(source.sql, { sinceSeq: move.appliedWatermark, tables: new Set(["messages"]) });

    let watermark = move.appliedWatermark;

    for (const change of changes) {
        if (upToSeq !== undefined && change.seq > upToSeq) {
            break;
        }

        if (!movingVnodes.has(vnodeForId(change.id, ringSize))) {
            continue;
        }

        applyChangeToTarget(target, { body: change.doc?.["body"] as string | undefined, id: change.id, op: change.op });
        watermark = change.seq;
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

/**
 * Route a write through the coordinator: forwarded to `target` if the write's
 * vnode has already been ceded (post-cutover), rejected if the vnode is
 * mid-cutover-quiesce (the brief window a real shard would queue-and-retry
 * rather than throw), else applied on `source` as normal. This is the
 * write-side half of the "no missing/duplicated rows" guarantee: `source`
 * enforces its own cede state on every write it receives, regardless of which
 * directory version the caller resolved from.
 */
const routeWrite = (
    coordinator: MoveCoordinator,
    source: ShardHarness,
    target: ShardHarness,
    id: string,
    body: string,
    ts: number,
): "forwarded" | "quiesced" | "source" => {
    const vnode = vnodeForId(id, coordinator.ringSize);

    if (coordinator.cededVnodes.has(vnode)) {
        writeMessage(target, id, body, ts);

        return "forwarded";
    }

    if (coordinator.quiescedVnodes.has(vnode)) {
        return "quiesced";
    }

    writeMessage(source, id, body, ts);

    return "source";
};

/**
 * Dual-read fan-out for the propagation window: query both shards for `ids`
 * and merge by identity, target-wins-if-present (see the design doc's dedup
 * rule). Returns a `Map` keyed by id, which is what makes "each row exactly
 * once" a structural property of the merge rather than a manual count.
 */
const dualRead = (source: ShardHarness, target: ShardHarness, ids: ReadonlyArray<string>): Map<string, MessageRow> => {
    const merged = new Map<string, MessageRow>();

    for (const id of ids) {
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
