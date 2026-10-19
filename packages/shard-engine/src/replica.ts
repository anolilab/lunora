/**
 * Region-local read replicas — a shard's rows, followed into a second DO placed
 * near the reader, so a one-shot query is answered locally instead of crossing
 * an ocean to the owner.
 *
 * A DO's role is fixed for its whole life by its name (the same rule the relay
 * tier follows): an un-suffixed name is the **owner**, a `…::replica::<region>`
 * name is a **replica** of that owner. The owner is the sole writer and the
 * source of the changelog; a replica never accepts a write and never originates
 * data — everything it holds arrived through `__cdc_log`.
 *
 * The feed is the CDC changelog that already exists for streaming export and
 * delta-resume subscriptions (`ctx-db-cdc.ts`), which is why this module is
 * small: the owner pages its log, the replica replays the page through the same
 * `applyCdcChanges` writer that point-in-time recovery uses, and the log's
 * `seq` doubles as the replication cursor (the LSN) and the read-your-writes
 * bookmark handed back to clients.
 *
 * Consistency, precisely:
 *
 * **Read-your-writes** is preserved by the caller passing the `minSeq` it got
 * from its last write. The replica catches up to at least that cursor before
 * answering, and reports `stale` if it cannot — never a silently older row.
 *
 * **Without** a `minSeq` a read may be up to `LUNORA_REPLICA_MAX_STALENESS_MS`
 * behind, which is the whole trade being made.
 *
 * A shard with **no changelog at all** (CDC is opt-in, so this is the default)
 * cannot be followed, and the owner refuses the control channel outright rather
 * than handing back a synthetic timeline a follower would agree with forever.
 *
 * A **compacted log** the replica has fallen behind cannot be reconciled by
 * replay, so the replica takes a fresh snapshot instead: every snapshot row is
 * upserted and every local row the snapshot lacks is deleted, in one
 * transaction, so rows changed or removed in the gap cannot survive it.
 *
 * A **forked timeline** (the owner was reset or rolled back, so its CDC epoch
 * changed) cannot be reconciled either way, so the replica reports
 * `unavailable` and the caller sends the read to the owner.
 * ponytail: a fork is a dead end, not a self-heal — and since a Durable Object
 * is never destroyed, "for this DO's lifetime" means indefinitely, at the cost
 * of one wasted hop per read in that region. Wiring `storage.deleteAll()` + a
 * fresh bootstrap is the upgrade path if resets stop being rare,
 * operator-driven events.
 */

import { decodeWire, encodeWire } from "@lunora/wire";

import type { RegionHint } from "../../../shared/region-hint";
import { parseMinSeq, parseReplicaName } from "../../../shared/replica-name";
import type { ExportRow } from "./admin-export-import";
import type { SqlExec } from "./ctx-db";
import type { CdcChange } from "./ctx-db-cdc";
import { cursorBelowRetainedFloor } from "./ctx-db-cdc";
import { envPositiveInt } from "./env-int";
import { RELAY_SIGNATURE_HEADER, siblingSecretOf, siblingStub, signSiblingBody, verifySiblingBody } from "./sibling-channel";

/** How stale a replica read may be when the caller names no cursor (per-deployment via `LUNORA_REPLICA_MAX_STALENESS_MS`). */
const DEFAULT_MAX_STALENESS_MS = 1000;

/** Changelog entries pulled per round trip. */
const PULL_PAGE_SIZE = 1000;

/**
 * Pull rounds one `ensureFresh` will run before giving up and reporting `stale`.
 * Bounds the work a single read can do: a replica far enough behind that ten
 * pages don't close the gap is better served by sending the read to the owner
 * while it keeps catching up in the background.
 *
 * A read with no `minSeq` is only `fresh` once a pull came back short of a full
 * page — the owner had nothing more — because that is the only moment the
 * replica provably matched its owner, and so the only moment `syncedAtMs` may
 * record. A replica still paging through a backlog when the budget runs out is
 * `stale`, and the read goes to the owner.
 */
const MAX_PULL_ROUNDS = 10;

/**
 * Rows a bootstrap will accept in one response (per-deployment via
 * `LUNORA_REPLICA_MAX_BOOTSTRAP_ROWS`). The owner's export RPC is not
 * paginated, so the whole snapshot crosses in a single reply — past this it
 * would risk the DO's memory budget, and a replica that cannot bootstrap
 * reports `unavailable` (reads go to the owner) rather than serving a partial
 * copy of the shard.
 * ponytail: single-response bootstrap; page it when shards outgrow this.
 */
const DEFAULT_MAX_BOOTSTRAP_ROWS = 50_000;

const maxBootstrapRows = (env: unknown): number => envPositiveInt(env, "LUNORA_REPLICA_MAX_BOOTSTRAP_ROWS", DEFAULT_MAX_BOOTSTRAP_ROWS);

/** Reserved table holding a replica's follow position. Owner-role DOs never create it. */
const REPLICA_STATE_TABLE = "__replica_state";

/** Ask the owner for the changelog past `sinceSeq`. */
interface ReplicaPullFrame {
    sinceSeq: number;
    type: "replica_pull";
}

/** Ask the owner for a full snapshot, for a replica that has never followed it. */
interface ReplicaBootstrapFrame {
    type: "replica_bootstrap";
}

type ReplicaFrame = ReplicaBootstrapFrame | ReplicaPullFrame;

/** The owner's answer to a pull: a page of the changelog plus the timeline it belongs to. */
interface ReplicaPullResult {
    changes: CdcChange[];
    cursor: number;
    epoch: string;

    /**
     * Oldest `seq` the owner still retains, or `undefined` when its log holds
     * nothing. Distinct on purpose: `0` would read as "retains everything", so
     * a compaction that emptied the log would look like a complete history.
     */
    floor?: number;
}

/** The owner's answer to a bootstrap: the snapshot plus the cursor it was taken at. */
interface ReplicaBootstrapResult {
    cursor: number;
    epoch: string;
    rows: ExportRow[];
    /** Set when the shard holds more rows than one response may carry, in which case `rows` must not be used. */
    truncated?: boolean;
}

/** Why a replica could not answer a read locally. */
type ReplicaReadiness =
    /** Caught up far enough — serve the read here. */
    | "fresh"
    /** Behind the caller's required cursor after exhausting its pull rounds — send the read to the owner. */
    | "stale"
    /** Cannot follow this owner at all (forked timeline, compacted gap, owner unreachable) — send the read to the owner. */
    | "unavailable";

/**
 * What the replica tier needs from ANY DO it runs on: its own name (the role
 * signal), the worker `env` (the control-channel secret and the tuning knobs),
 * and its SQLite handle. Both halves extend it, and `shard-do.ts` builds it once
 * and spreads it into the relay host and this one.
 */
interface ShardSiblingHost {
    /** This DO's own name, or `undefined` for an unnamed (single-DO) shard. */
    doName: () => string | undefined;
    /** The worker `env`. */
    env: () => unknown;
    /** The env binding name holding the shard namespace, so a DO can address a sibling. */
    shardBinding: () => string | undefined;

    /**
     * The Cloudflare data-residency jurisdiction this DO itself lives in
     * (`ctx.id.jurisdiction`), or `undefined` when unpinned. A sibling must be
     * resolved through the SAME jurisdiction subnamespace — the worker pins the
     * namespace it routes through but stamps the RAW env key as the binding
     * name, and a pinned subnamespace maps a name to a different DO id.
     */
    shardJurisdiction: () => string | undefined;
    /** This DO's SQLite handle. */
    sql: () => SqlExec;
}

/**
 * The owner half: what a shard needs to SERVE the replicas following it.
 *
 * `ownerCursor` / `ownerEpoch` / `ownerFloor` are all optional-returning, and
 * that is load-bearing rather than defensive. `undefined` means "this shard has
 * no changelog" — CDC is opt-in, and without it there is nothing to follow.
 * Collapsing that into a sentinel (`0`, `""`) makes "no log" indistinguishable
 * from "empty log", and a follower comparing `"" === ""` concludes it is caught
 * up with a timeline that does not exist.
 */
interface ReplicaOwnerHost extends ShardSiblingHost {
    /** Every row of the shard, for a bootstrap snapshot. */
    exportRows: () => Promise<ExportRow[]>;

    /** The changelog high-watermark, or `undefined` when this shard has no changelog. */
    ownerCursor: () => number | undefined;
    /** This shard's CDC epoch, or `undefined` when this shard has no changelog. */
    ownerEpoch: () => string | undefined;

    /**
     * The oldest `seq` a follower can still be REPLAYED from, `undefined` when the
     * log is empty or absent.
     *
     * A replica applies post-images, so the floor it needs is the payload floor,
     * not the key floor: payload compaction leaves the keys in place, so the
     * oldest retained `seq` would report a position from which replay is
     * impossible. See `minCdcReplayableSeq`.
     */
    ownerFloor: () => number | undefined;
    /** One page of the changelog past `sinceSeq`. */
    readChanges: (sinceSeq: number, limit: number) => { changes: CdcChange[]; cursor: number };

    /**
     * How many rows a snapshot would carry, WITHOUT building one.
     *
     * The cap exists to protect the owner's memory budget, and checking it
     * against an already-materialized `exportRows()` would protect nothing: an
     * over-cap shard exhausts memory producing the snapshot, long before the
     * refusal could be returned. A count is a `COUNT(*)` per table, which is
     * what makes the refusal arrive first.
     */
    rowCount: () => number;
}

/**
 * The follower half: what a replica needs to APPLY what its owner sends.
 */
interface ReplicaFollowerHost extends ShardSiblingHost {
    /**
     * Replay a changelog page through the schema-aware writer (the `applyCdc` path), atomically.
     * Resolves once the page has COMMITTED: any refresh work after the commit is the host's to
     * absorb, because a rejection here is read as "the page was not applied".
     */
    applyChanges: (changes: ReadonlyArray<CdcChange>) => Promise<number>;
    /** Every row this replica holds, so a re-snapshot can delete the ones its owner no longer has. */
    exportRows: () => Promise<ExportRow[]>;
    /** Insert a bootstrap snapshot verbatim (explicit ids preserved), reporting what did not land. */
    importRows: (rows: ReadonlyArray<ExportRow>) => Promise<{ errors: ReadonlyArray<unknown> }>;
    /** Surface a failure the follow loop absorbed (a page that would not apply) so an operator can see why reads fell back to the owner. */
    reportError?: (scope: string, error: unknown) => void;
}

/** A replica's durable follow position. */
interface ReplicaState {
    appliedSeq: number;
    epoch: string;
    syncedAtMs: number;
}

/**
 * SQL handles whose replica-state table is known to exist.
 *
 * The DDL is idempotent, but it is not free, and it sits on the hot path: the
 * fast "already caught up" check reads the follow position on every
 * replica-routed request, which is the one path the whole tier exists to keep
 * short. A DO's handle is stable for its lifetime, so one statement per DO is
 * enough; keyed weakly so a discarded handle does not pin an entry.
 */
const migratedHandles = new WeakSet<object>();

const migrateReplicaState = (sql: SqlExec): void => {
    if (migratedHandles.has(sql)) {
        return;
    }

    sql.exec(
        `CREATE TABLE IF NOT EXISTS ${REPLICA_STATE_TABLE} (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            epoch TEXT NOT NULL,
            applied_seq INTEGER NOT NULL,
            synced_at REAL NOT NULL
        )`,
    );

    migratedHandles.add(sql);
};

const readReplicaState = (sql: SqlExec): ReplicaState | undefined => {
    migrateReplicaState(sql);

    const rows = sql.exec(`SELECT epoch, applied_seq AS appliedSeq, synced_at AS syncedAtMs FROM ${REPLICA_STATE_TABLE} WHERE id = 1`).toArray() as {
        appliedSeq: number;
        epoch: string;
        syncedAtMs: number;
    }[];

    return rows[0];
};

const writeReplicaState = (sql: SqlExec, state: ReplicaState): void => {
    migrateReplicaState(sql);

    sql.exec(
        `INSERT INTO ${REPLICA_STATE_TABLE} (id, epoch, applied_seq, synced_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, applied_seq = excluded.applied_seq, synced_at = excluded.synced_at`,
        state.epoch,
        state.appliedSeq,
        state.syncedAtMs,
    );
};

/**
 * Whether this DO may serve the control channel at all, decided before a byte
 * of the request is read. Three refusals, none of which depend on the frame.
 *
 * **A replica cannot serve replicas.** It holds a *copy* of a timeline, so its
 * local `seq` numbers are its own and would mean nothing to a follower.
 *
 * **No changelog, nothing to follow.** CDC is opt-in, so this is the DEFAULT
 * shape of a shard, and it must be refused at the source: a follower handed a
 * synthetic epoch would bootstrap once, agree with every later empty page that
 * it is caught up, and serve that first snapshot forever.
 *
 * **No control-channel secret.** Unlike the relay channel — which treats a
 * missing `LUNORA_RELAY_SECRET` as legacy network-trust, because tightening it
 * would break deployments predating the secret — replica reads have no such
 * history, and the prize is different in kind: a forged relay frame delivers a
 * bogus poke, a forged frame here returns **every row of the shard**. An
 * unconfigured deployment gets no replication rather than a weaker default.
 * @returns the refusal, or `undefined` when the channel may proceed
 */
const replicaControlRefusal = (host: ReplicaOwnerHost): Response | undefined => {
    const name = host.doName();

    if (name !== undefined && parseReplicaName(name) !== undefined) {
        return new Response("replica cannot serve replicas", { status: 409 });
    }

    if (host.ownerEpoch() === undefined) {
        return new Response("shard has no changelog to replicate", { status: 409 });
    }

    if (siblingSecretOf(host.env()) === undefined) {
        return new Response("replica control requires LUNORA_RELAY_SECRET", { status: 403 });
    }

    return undefined;
};

/*
 * Serve the owner half of the `/_lunora/replica` control channel: authenticate
 * the frame, then answer a pull or a bootstrap. Stateless — an owner keeps no
 * per-replica bookkeeping, because a replica's position lives with the replica
 * and the changelog it reads is the one the shard already keeps.
 *
 * A section band for what follows, not a docblock: `replicaResponse` sits at the
 * top of the section and documents itself.
 */

/**
 * The outbound bracket for every control-channel body, matched by the
 * {@link decodeWire} in {@link ShardReplica.pull} / {@link ShardReplica.bootstrap}.
 *
 * The documents in these frames came back out of `decodeDocJson`, so a
 * `v.bigint()` column is a REAL `bigint` here and `v.bytes()` a REAL
 * `ArrayBuffer`. Uncoded, the first throws `TypeError: Do not know how to
 * serialize a BigInt` inside `Response.json` — which is precisely the failure
 * {@link servePull}'s docblock describes: a thrown response reaches the follower
 * as a bare non-2xx, its pull path reads that as "owner unreachable", and it
 * retries the identical doomed round trip for the life of the DO without ever
 * latching `divergent`. The second flattens to `{}`, which the follower then
 * writes into its copy of the shard.
 *
 * The same bracket `shard-do.ts`'s `adminResponse` puts around the admin plane,
 * and identical in effect: both codecs are the identity on a pure-JSON body, so
 * the frames carrying no document keep their bytes.
 */
const replicaResponse = (body: ReplicaBootstrapResult | ReplicaPullResult): Response => Response.json(encodeWire(body));

/** Serve a `replica_bootstrap`: the whole shard, or a `truncated` refusal when it is too large for one response. */
const serveBootstrap = async (host: ReplicaOwnerHost, epoch: string): Promise<Response> => {
    // Refuse BEFORE building the snapshot: the cap is the owner's memory budget,
    // and a shard past it would exhaust that budget producing rows nobody is
    // allowed to receive.
    if (host.rowCount() > maxBootstrapRows(host.env())) {
        return replicaResponse({ cursor: 0, epoch, rows: [], truncated: true });
    }

    // Read the cursor BEFORE the snapshot: a write that lands mid-export may or
    // may not be in `rows`, and replaying it again from `cursor` is harmless
    // (both the upsert and the delete replay are idempotent). Reading it after
    // would skip anything committed during the export.
    const cursor = host.ownerCursor() ?? 0;
    const rows = await host.exportRows();

    return replicaResponse({ cursor, epoch, rows });
};

/**
 * Serve a `replica_pull`: one page of the changelog past `sinceSeq`, or the
 * floor alone when the follower has fallen below what can still be replayed.
 *
 * The floor is checked BEFORE the page is read, because a follower below it
 * cannot be served one: `readChanges` refuses a compacted page outright
 * (`CDC_PAYLOAD_COMPACTED`), and a thrown response reaches the follower as a
 * bare non-2xx, which its pull path reads as "owner unreachable" — so it would
 * retry the identical doomed round trip forever instead of bootstrapping, and
 * never latch divergent, because the floor it needed to see was in the response
 * that failed to be built. Answering with the floor and an empty page routes it
 * through `divergenceOf` into a re-snapshot, which is the recovery that exists.
 */
const servePull = (host: ReplicaOwnerHost, epoch: string, sinceSeq: number): Response => {
    const floor = host.ownerFloor();

    if (cursorBelowRetainedFloor(floor, sinceSeq)) {
        return replicaResponse({ changes: [], cursor: host.ownerCursor() ?? sinceSeq, epoch, floor });
    }

    const ownerCursor = host.ownerCursor() ?? 0;

    // A follower ASKING from above the owner's high-watermark has applied changes
    // the owner can no longer account for: the owner's log rolled back under it,
    // which a native point-in-time restore does WITHOUT minting a new epoch —
    // the restore reverts `__cdc_meta` along with everything else, so the epoch
    // comes back identical and cannot report the one fork it exists to report.
    //
    // Answered here rather than left to `readChanges`, which refuses such a
    // cursor outright, for exactly the reason the floor is answered here: a
    // thrown response reaches the follower as a bare non-2xx it reads as "owner
    // unreachable", so it would retry the identical doomed round trip forever
    // instead of reporting the fork. The rewound cursor routes it through
    // `divergenceOf`, which reads it as a fork and stops following.
    if (sinceSeq > ownerCursor) {
        return replicaResponse({ changes: [], cursor: ownerCursor, epoch, ...(floor === undefined ? {} : { floor }) });
    }

    const { changes, cursor } = host.readChanges(sinceSeq, PULL_PAGE_SIZE);

    return replicaResponse({ changes, cursor, epoch, ...(floor === undefined ? {} : { floor }) });
};

const handleReplicaControl = async (host: ReplicaOwnerHost, request: Request): Promise<Response> => {
    const refusal = replicaControlRefusal(host);

    if (refusal !== undefined) {
        return refusal;
    }

    // Non-`undefined` past the preflight, which is what checked it.
    const epoch = host.ownerEpoch() as string;

    let raw: string;

    try {
        raw = await request.text();
    } catch {
        return new Response("bad request", { status: 400 });
    }

    if (!(await verifySiblingBody(host.env(), request.headers.get(RELAY_SIGNATURE_HEADER), raw))) {
        return new Response("forbidden", { status: 403 });
    }

    // Typed as the raw wire shape rather than as {@link ReplicaFrame}: this is
    // untrusted input, so the `type` is a value to test, not a fact to narrow on.
    let frame: { sinceSeq?: unknown; type?: unknown };

    try {
        frame = JSON.parse(raw) as { sinceSeq?: unknown; type?: unknown };
    } catch {
        return new Response("bad request", { status: 400 });
    }

    if (frame.type === "replica_bootstrap") {
        return serveBootstrap(host, epoch);
    }

    if (frame.type === "replica_pull") {
        const sinceSeq = typeof frame.sinceSeq === "number" && Number.isInteger(frame.sinceSeq) && frame.sinceSeq >= 0 ? frame.sinceSeq : 0;

        return servePull(host, epoch, sinceSeq);
    }

    return new Response("unknown replica frame", { status: 400 });
};

/** Whether the platform flagged a failure as transient: worth retrying (`retryable`), or caused by load (`overloaded`). */
const isTransient = (error: unknown): boolean => {
    const flags = error as { overloaded?: unknown; retryable?: unknown } | null | undefined;

    return typeof error === "object" && (flags?.retryable === true || flags?.overloaded === true);
};

/**
 * Why `page` can no longer be replayed onto `state`, or `undefined` when it can.
 *
 * `"fork"`: the owner's timeline is not the one we replayed — a new epoch, or a
 * high-watermark below our applied position. Neither is reconcilable by replay
 * OR by snapshot: applying the page anyway would fabricate a state neither side
 * ever held.
 *
 * `"compacted"`: same timeline, but the owner's log no longer reaches back to our
 * position. The history exists nowhere, yet the owner's current rows are a
 * complete, trustworthy state to converge on, so a fresh snapshot recovers it.
 */
const divergenceOf = (state: ReplicaState, page: ReplicaPullResult): "compacted" | "fork" | undefined => {
    // An absent `floor` means the owner's log holds nothing right now: a
    // shard that has never written (fine — we are at 0 as well), or one whose
    // log was compacted away entirely, which leaves nothing to replay the gap
    // from. What separates them is that the second one hands back an EMPTY
    // page whose high-watermark is nevertheless ahead of us: writes happened
    // and were compacted before we saw them. A page WITH changes and a
    // cursor ahead is just an ordinary catch-up.
    const compactedEmpty = page.changes.length === 0 && page.cursor > state.appliedSeq;
    const floor = page.floor ?? (compactedEmpty ? page.cursor : 0);
    const compactedPastUs = floor > 0 && floor > state.appliedSeq + 1;

    // The owner's high-watermark BELOW our applied position is a rollback on
    // the owner, and it is the case the epoch cannot report: a point-in-time
    // restore reverts the owner's whole SQLite database, the `__cdc_meta` row
    // holding that epoch included, so the epoch comes back identical while
    // the log underneath it is a different timeline. Our own applied position
    // is then the only surviving record of the timeline we replayed, and
    // following on means replaying a second timeline's changes over a first
    // one's rows. Detectable only while the owner is still behind us — once
    // it has written back past our cursor neither side can tell, the same
    // blind spot `ShardDO.sealForkedTimeline` documents for its subscribers.
    const rewoundBeneathUs = page.cursor < state.appliedSeq;

    if (page.epoch !== state.epoch || rewoundBeneathUs) {
        return "fork";
    }

    return compactedPastUs ? "compacted" : undefined;
};

/** The `table`+`id` identity of a row, for matching a snapshot against what a replica holds. */
const rowKey = (table: string, id: string): string => `${table}\u0000${id}`;

/**
 * A replica's follow loop. One instance per replica DO, built once from the
 * DO name; owner-role DOs never have one.
 */
class ShardReplica {
    /**
     * Set once the replica proves it cannot follow this owner (forked timeline,
     * an oversized or lossy snapshot, or a page that can never be applied).
     * Sticky for the DO's lifetime: re-checking on every read would re-pay the
     * round trip to learn the same answer, and the condition is not one that
     * clears itself.
     */
    private divergent = false;

    /**
     * The catch-up currently in flight, if any — the single-flight latch.
     *
     * The follow loop awaits cross-DO fetches, and a Durable Object's input gate
     * does NOT hold other requests across an await. Without this, a burst of
     * first reads in a cold region each issues its own bootstrap (making the
     * owner export the whole shard once per caller), and concurrent catch-ups
     * write `__replica_state` out of order — regressing `appliedSeq` and
     * re-applying an older page over newer changes, while a third caller has
     * already been told `fresh` on the higher cursor.
     */
    private inFlight: Promise<ReplicaReadiness> | undefined;

    public constructor(
        private readonly host: ReplicaFollowerHost,
        /** The shard this replica follows. */
        public readonly ownerKey: string,
        /** The region this replica serves. */
        public readonly region: RegionHint,
    ) {}

    /**
     * Bring the replica far enough forward to answer a read, and say whether it
     * got there.
     *
     * `minSeq` is the caller's read-your-writes bookmark — the owner cursor its
     * last write returned. When it is set, "fresh enough" means *at least* that
     * cursor and nothing weaker; when it is absent, the staleness window
     * applies and a recently-synced replica answers with no round trip at all.
     */
    public async ensureFresh(minSeq?: number): Promise<ReplicaReadiness> {
        if (this.divergent) {
            return "unavailable";
        }

        // The fast path — already caught up — is synchronous and takes no latch:
        // it is the case the whole tier exists for, and it cannot race anything
        // because it neither fetches nor writes.
        if (this.isCaughtUp(minSeq)) {
            return "fresh";
        }

        // Everything else joins the one in-flight advance.
        this.inFlight ??= this.advance(minSeq).finally(() => {
            this.inFlight = undefined;
        });

        const readiness = await this.inFlight;

        // The run we joined may have been started for a weaker requirement than
        // ours, so its verdict is re-checked against the durable cursor:
        // joining can delay a read, never under-serve it.
        return readiness === "fresh" && !this.isCaughtUp(minSeq) ? "stale" : readiness;
    }

    /** The cursor this replica has applied, for diagnostics and the outbound bookmark header. */
    public appliedSeq(): number {
        return readReplicaState(this.host.sql())?.appliedSeq ?? 0;
    }

    /** Whether this replica has given up on following its owner. */
    public isDivergent(): boolean {
        return this.divergent;
    }

    /** Bootstrap if this replica holds nothing yet, then page the changelog forward. */
    private async advance(minSeq: number | undefined): Promise<ReplicaReadiness> {
        let state = readReplicaState(this.host.sql());

        if (state === undefined) {
            const bootstrapped = await this.bootstrap();

            if (bootstrapped === undefined) {
                // No snapshot means no rows at all — there is nothing here to
                // serve a read from, stale or otherwise.
                return "unavailable";
            }

            state = bootstrapped;
        }

        return this.catchUp(state, minSeq);
    }

    /** Whether the durable follow position already satisfies this read. */
    private isCaughtUp(minSeq: number | undefined): boolean {
        const state = readReplicaState(this.host.sql());

        return state !== undefined && this.isFreshEnough(state, minSeq);
    }

    /**
     * Page the owner's changelog forward from `state` until the read can be
     * answered, the pages run out, or the follow proves impossible.
     *
     * Applying a page is one atomic step from the follower's point of view:
     * changes are replayed in commit order, then the position is written. A
     * crash between the two re-applies the page, which is safe — every replay
     * is an upsert or a delete by id.
     */
    private async catchUp(from: ReplicaState, minSeq: number | undefined): Promise<ReplicaReadiness> {
        let state = from;
        let resnapshotted = false;

        for (let round = 0; round < MAX_PULL_ROUNDS; round += 1) {
            // eslint-disable-next-line no-await-in-loop -- catching up is inherently sequential: each page's cursor is the next page's `sinceSeq`.
            const page = await this.pull(state.appliedSeq);

            if (page === undefined) {
                return this.whenOwnerUnreachable(state, minSeq);
            }

            const divergence = divergenceOf(state, page);

            if (divergence !== undefined) {
                // eslint-disable-next-line no-await-in-loop -- the snapshot replaces the position every later pull starts from.
                const recovered = await this.recover(state, divergence, resnapshotted);

                if (typeof recovered === "string") {
                    return recovered;
                }

                resnapshotted = true;
                state = recovered;

                continue;
            }

            // An empty page means the owner has nothing more, so stop rather than
            // loop: running to `MAX_PULL_ROUNDS` against an empty log is how an
            // unreachable `minSeq` (a stale bookmark, or one a caller supplied)
            // turns a single query into ten sequential cross-region round trips.
            const exhausted = page.changes.length < PULL_PAGE_SIZE;

            // eslint-disable-next-line no-await-in-loop -- see above: pages must be applied in commit order.
            const applied = await this.applyPage(page, state, exhausted);

            if (applied === undefined) {
                return "unavailable";
            }

            state = applied;

            if (exhausted || this.isFreshEnough(state, minSeq)) {
                return this.verdict(state, minSeq);
            }
        }

        return this.verdict(state, minSeq);
    }

    /** What `state` is worth to the read once paging has stopped: fresh enough, or stale. */
    private verdict(state: ReplicaState, minSeq: number | undefined): ReplicaReadiness {
        return this.isFreshEnough(state, minSeq) ? "fresh" : "stale";
    }

    /**
     * Act on a divergence: a fork latches {@link divergent}; a compacted gap is closed by a re-snapshot.
     * Only one re-snapshot runs per catch-up: an owner trimming faster than a snapshot can be taken is
     * reported as unavailable (reads go to the owner), not looped on or latched.
     * @returns the position to keep following from, or the verdict to stop with
     */
    private async recover(state: ReplicaState, divergence: "compacted" | "fork", resnapshotted: boolean): Promise<ReplicaReadiness | ReplicaState> {
        if (divergence === "fork") {
            this.divergent = true;

            return "unavailable";
        }

        return resnapshotted ? "unavailable" : ((await this.resnapshot(state)) ?? "unavailable");
    }

    /**
     * What a read gets when the owner cannot be reached. Anything already applied
     * is still valid, so a read with no cursor requirement can still be served
     * from it; one that needs a newer cursor cannot.
     */
    private whenOwnerUnreachable(state: ReplicaState, minSeq: number | undefined): ReplicaReadiness {
        return minSeq === undefined && this.isFreshEnough(state, undefined) ? "fresh" : "unavailable";
    }

    /**
     * Replay one page and record the position it reached. Applying and recording
     * are one step from the follower's point of view: a crash between them
     * re-applies the page, which is safe because every replay is an upsert or a
     * delete by id.
     *
     * `syncedAtMs` is when the replica last provably matched its owner — now for
     * the page that drained the log (`exhausted`), `from`'s for a full page with
     * more behind it. Stamping now on a partial page made the staleness window
     * vouch for a replica still thousands of changes behind.
     *
     * A change that will not replay fails identically on every retry, so letting
     * it reject made each read 500 and re-pull the same page for the life of the
     * DO. It latches {@link divergent} instead, like any other timeline the
     * replica cannot follow: the cursor stays put (the host applies a page
     * atomically or not at all), reads go to the owner, and a restarted DO tries
     * again. A failure the platform marks as transient does not latch; see
     * {@link applyAtomically}.
     * @returns the new position, or `undefined` when the page could not be applied
     */
    private async applyPage(page: ReplicaPullResult, from: ReplicaState, exhausted: boolean): Promise<ReplicaState | undefined> {
        if (!(await this.applyAtomically("replica.applyPage", page.changes))) {
            return undefined;
        }

        const state: ReplicaState = { appliedSeq: page.cursor, epoch: page.epoch, syncedAtMs: exhausted ? Date.now() : from.syncedAtMs };

        writeReplicaState(this.host.sql(), state);

        return state;
    }

    /**
     * Replay `changes` as one atomic step and report whether they committed. Resolution means committed
     * (see {@link ReplicaFollowerHost.applyChanges}), so a rejection leaves the replica exactly where it was.
     *
     * The failure is reported either way. It latches {@link divergent} unless the platform flagged it as
     * transient (`retryable`, or `overloaded`): a transient failure says nothing about the changes, so the
     * next sync pulls the same page again instead of cutting the replica off until the DO restarts.
     */
    private async applyAtomically(scope: string, changes: ReadonlyArray<CdcChange>): Promise<boolean> {
        if (changes.length === 0) {
            return true;
        }

        try {
            await this.host.applyChanges(changes);

            return true;
        } catch (error) {
            if (!isTransient(error)) {
                this.divergent = true;
            }

            this.host.reportError?.(scope, error);

            return false;
        }
    }

    /** The owner's snapshot, or `undefined` when it can't be had (unreachable, or too large for one response). */
    private async fetchSnapshot(): Promise<ReplicaBootstrapResult | undefined> {
        const response = await this.request({ type: "replica_bootstrap" });

        if (response === undefined) {
            return undefined;
        }

        const result = decodeWire(await response.json()) as ReplicaBootstrapResult;

        if (result.truncated === true) {
            // Too big to copy in one reply. Reads go to the owner rather than to
            // a replica holding an arbitrary prefix of the shard.
            this.divergent = true;

            return undefined;
        }

        return result;
    }

    /**
     * Converge a replica that holds rows onto a fresh snapshot, because the owner's log no longer reaches back
     * to its position. The snapshot is replayed through the schema-aware writer as one atomic page: every
     * snapshot row is upserted and every local row it lacks is deleted. An append-only import would keep
     * the stale version of each row changed in the gap, and the rows deleted in it, and then serve both as fresh.
     * ponytail: rewrites every row, changed or not; diff against the local documents if snapshots get large.
     * @returns the position the snapshot was taken at, or `undefined` when it could not be applied
     */
    private async resnapshot(from: ReplicaState): Promise<ReplicaState | undefined> {
        const snapshot = await this.fetchSnapshot();

        if (snapshot === undefined) {
            return undefined;
        }

        const changes: CdcChange[] = [];
        const kept = new Set<string>();

        for (const { doc, table } of snapshot.rows) {
            const id = String(doc["_id"]);

            kept.add(rowKey(table, id));
            changes.push({ doc, id, op: "insert", seq: snapshot.cursor, table, ts: 0 });
        }

        for (const { doc, table } of await this.host.exportRows()) {
            const id = String(doc["_id"]);

            if (!kept.has(rowKey(table, id))) {
                changes.push({ id, op: "delete", seq: snapshot.cursor, table, ts: 0 });
            }
        }

        if (!(await this.applyAtomically("replica.resnapshot", changes))) {
            return undefined;
        }

        // `syncedAtMs` stays `from`'s: the replica provably matches its owner only once a pull comes back drained.
        const state: ReplicaState = { appliedSeq: snapshot.cursor, epoch: snapshot.epoch, syncedAtMs: from.syncedAtMs };

        writeReplicaState(this.host.sql(), state);

        return state;
    }

    /** Take the owner's snapshot into an empty replica, or `undefined` when it can't be had. */
    private async bootstrap(): Promise<ReplicaState | undefined> {
        const result = await this.fetchSnapshot();

        if (result === undefined) {
            return undefined;
        }

        const { errors } = await this.host.importRows(result.rows);

        if (errors.length > 0) {
            // The import surfaces per-row failures rather than aborting, so a
            // snapshot that lost rows to validation drift would otherwise be
            // recorded as complete and then served as `fresh` for good.
            this.divergent = true;

            return undefined;
        }

        const state: ReplicaState = { appliedSeq: result.cursor, epoch: result.epoch, syncedAtMs: Date.now() };

        writeReplicaState(this.host.sql(), state);

        return state;
    }

    /** Whether `state` already satisfies the read: past the caller's cursor, or inside the staleness window when there is none. */
    private isFreshEnough(state: ReplicaState, minSeq: number | undefined): boolean {
        if (minSeq !== undefined) {
            return state.appliedSeq >= minSeq;
        }

        return Date.now() - state.syncedAtMs <= envPositiveInt(this.host.env(), "LUNORA_REPLICA_MAX_STALENESS_MS", DEFAULT_MAX_STALENESS_MS);
    }

    /** One page of the owner's changelog, or `undefined` when the owner can't be reached. */
    private async pull(sinceSeq: number): Promise<ReplicaPullResult | undefined> {
        const response = await this.request({ sinceSeq, type: "replica_pull" });

        return response === undefined ? undefined : (decodeWire(await response.json()) as ReplicaPullResult);
    }

    /**
     * POST a frame to the owner over the authenticated sibling channel.
     * Best-effort: an unreachable owner returns `undefined` and the caller
     * degrades to an owner-served read rather than throwing into the dispatch.
     */
    private async request(frame: ReplicaFrame): Promise<Response | undefined> {
        const binding = this.host.shardBinding();
        const stub = siblingStub(this.host.env(), binding, this.ownerKey, this.host.shardJurisdiction());

        if (stub === undefined) {
            return undefined;
        }

        const body = JSON.stringify(frame);
        const headers: Record<string, string> = { "content-type": "application/json", "x-lunora-shard-binding": binding ?? "" };
        const secret = siblingSecretOf(this.host.env());

        if (secret !== undefined) {
            headers[RELAY_SIGNATURE_HEADER] = await signSiblingBody(secret, body);
        }

        try {
            const response = await stub.fetch("https://replica.internal/_lunora/replica", { body, headers, method: "POST" });

            return response.ok ? response : undefined;
        } catch {
            return undefined;
        }
    }
}

/**
 * Build the replica collaborator for a DO, chosen ONCE from its name: a
 * `…::replica::<region>` name follows that owner, anything else is an owner (or
 * an unnamed single-DO shard) and gets none.
 * @returns the collaborator, or `undefined` for an owner-role name
 */
const createReplicaLink = (host: ReplicaFollowerHost): ShardReplica | undefined => {
    const name = host.doName();

    if (name === undefined) {
        return undefined;
    }

    const parsed = parseReplicaName(name);

    return parsed === undefined ? undefined : new ShardReplica(host, parsed.ownerKey, parsed.region);
};

/**
 * Decide whether `replica` may serve a dispatch, or the caller must be sent back
 * to the owner. Returns the refusal response, or `undefined` to proceed.
 *
 * Two independent refusals, both fail-closed.
 *
 * **Anything the runtime did not mark as a replica read.** A replica cannot
 * classify a `functionPath` — the generated dispatch owns that knowledge — so
 * rather than guessing which calls are writes it refuses every call without the
 * runtime's explicit read marker. A mutation reaching a replica by any route is
 * rejected instead of applied to a copy the owner will never see.
 *
 * **A read it cannot answer at the required freshness.** Anything short of
 * `fresh` is a `421` carrying the reason, which the runtime turns into one
 * retry against the owner.
 * @returns the refusal response, or `undefined` when the replica may serve it
 */
const gateReplicaDispatch = async (replica: ShardReplica, request: Request, functionPath: string): Promise<Response | undefined> => {
    if (request.headers.get("x-lunora-replica-read") !== "1") {
        return Response.json(
            { error: { code: "REPLICA_READ_ONLY", message: `"${functionPath}" is a write and cannot run on a read replica` } },
            { status: 421 },
        );
    }

    const readiness = await replica.ensureFresh(parseMinSeq(request.headers.get("x-lunora-min-seq")));

    if (readiness === "fresh") {
        return undefined;
    }

    return Response.json(
        { error: { code: "REPLICA_NOT_READY", message: `replica is ${readiness} for this read` } },
        { headers: { "x-lunora-replica-fallback": readiness }, status: 421 },
    );
};

export type { ReplicaFollowerHost, ReplicaOwnerHost, ReplicaReadiness, ShardSiblingHost };
export { createReplicaLink, gateReplicaDispatch, handleReplicaControl };
