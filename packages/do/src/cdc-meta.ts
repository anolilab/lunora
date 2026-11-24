/**
 * The CDC presence and epoch memos for `ShardDO`, and the once-per-wake seal that
 * re-mints the epoch when a consumer proves the changelog forked.
 *
 * The memos and the seal latch are per-instance state that every flush, resume
 * and frame stamp consults, so they live together behind {@link CdcMetaHost}.
 * The protected `currentCdcCursor`/`currentCdcEpoch`/`sealForkedTimeline` surface
 * stays on `ShardDO` and reads through here.
 */
import type { SqlExec } from "@lunora/shard-engine";
import { bumpCdcEpoch, CDC_LOG_TABLE, readCdcEpoch } from "@lunora/shard-engine";

/** What the memos need of the shard: its storage, read per call because the field initializer runs before the constructor. */
interface CdcMetaHost {
    sql: () => SqlExec;
}

/**
 * Per-instance CDC memo state. A class, like `CdcRetentionRunner`, because the
 * memos must reset with the instance: a native PITR restore only takes effect on
 * restart, and module state would carry a pre-restore epoch across it.
 */
class CdcMeta {
    private readonly host: CdcMetaHost;

    /**
     * Whether this wake has already re-minted the epoch to seal a rolled-back
     * timeline. In-memory on purpose — see {@link CdcMeta.sealForkedTimeline} for
     * why the seal is capped at one per wake, and why losing the flag on eviction
     * is the correct direction.
     */
    private forkSealed = false;

    /**
     * Memos for {@link CdcMeta.cdcEnabled} and {@link CdcMeta.cachedCdcEpoch},
     * which every flush and resume consults.
     *
     * Instance fields, never module state: a native PITR restore reverts
     * `__cdc_meta` but only takes effect when the object restarts, so a fresh
     * instance is what guarantees the restored row is read. Presence is
     * remembered only once TRUE — a migration creates `__cdc_log` mid-instance,
     * and nothing outside a restore drops it, so a cached `false` is the one
     * answer that can go stale.
     */
    private cdcLogPresent = false;

    private cdcEpochCache: string | undefined;

    public constructor(host: CdcMetaHost) {
        this.host = host;
    }

    /**
     * Mint a fresh CDC epoch because a resume claim just proved this shard's
     * changelog forked under it, and return the new value for the outgoing frame.
     *
     * The trigger is a client presenting `sinceEpoch === epoch` with `sinceSeq >
     * cursor`: it holds a cursor this shard once issued on THIS timeline and can
     * no longer account for. Only a rollback produces that — in practice a native
     * PITR restore, which is armed in `ShardDO.handlePitrAdminOp`.
     *
     * **Why the signal has to come from outside SQLite.** A restore reverts the
     * whole SQLite database, `__cdc_meta` included, so the proactive bump
     * `pitrRestore` performs is rolled back along with everything else — the
     * epoch cannot detect the one event it exists for. Nothing durable inside a
     * SQLite-backed Durable Object escapes that: the KV half of `state.storage`
     * is the same database, and an alarm is a row in it. So every record of the
     * pre-restore timeline that survives is somewhere the restore could not
     * reach, and this shard has exactly two: the cursor a CONSUMER cached (a
     * subscriber's `sinceSeq` here, a connector's in
     * `ShardDO.runShardCdcSync`, a follower's in `replica.ts`), and the
     * changelog ARCHIVE's own segments, which R2 keeps while the watermark
     * naming them rolls back (`cdcArchiveRewound`, consulted by the retention
     * sweep). Either one calls this, and turning one witness into a shard-wide
     * epoch bump is what extends the protection to clients that reconnect later,
     * after post-restore writes have climbed the AUTOINCREMENT back past their
     * own `sinceSeq` and the `sinceSeq > cursor` guard no longer fires for them.
     *
     * **What it detects.** Any rollback under a live subscriber base, promptly: a
     * restore restarts the object (`ctx.abort()`, or the eviction that lets a
     * deferred restore apply), which drops every hibernated socket, so the whole
     * subscriber set reconnects with pre-restore cursors while the restored
     * cursor is still low. The first of them seals the fork for the rest.
     *
     * **What it cannot detect.** A rollback on a shard whose consumers ALL stay
     * offline until the cursor has climbed back past their cursors, and which
     * archives nothing — nobody is left to present the proof. A shard with no
     * subscribers, no connector, no follower and no archive bucket is the
     * degenerate case of that, and is also the case where nothing is stale.
     *
     * **On trusting `sinceSeq`.** It is client-supplied, so a caller that already
     * knows this shard's epoch can force a bump, and a bump is shard-wide: every
     * subscriber takes a full snapshot instead of a resume on its NEXT reconnect.
     * The cost is bounded (the once-per-wake latch below) and deferred — nothing
     * is pushed and no live subscription is interrupted — and it stays strictly
     * less than what the same caller can already spend by subscribing without a
     * `sinceSeq` at all.
     * @returns the freshly minted epoch, to stamp on the frame this verdict produces
     */
    public sealForkedTimeline(): string {
        // At most once per wake, and that bound is a security property rather
        // than an optimisation.
        //
        // The proof this acts on — "a client presents a cursor ahead of ours on
        // our own epoch" — is CLIENT-SUPPLIED, and the epoch it must match is
        // stamped on every frame the client has ever received. So any subscriber
        // can manufacture the proof at will, and without a bound each forged
        // frame would cost one SQLite write and invalidate the cached resume of
        // every other subscriber on the shard: a one-frame request amplified into
        // N full snapshots.
        //
        // One seal is all a real restore needs — it re-mints the epoch shard-wide,
        // so every client that reconnects afterwards is refused by the epoch
        // comparison above rather than by re-proving the rollback. Latching after
        // the first therefore costs the genuine case nothing.
        //
        // What it caps the forged case AT is one epoch bump per wake, and that is
        // not free: an eviction leaves the epoch intact and every client resumes
        // across it, whereas a bump forces all N subscribers to take a full
        // snapshot on their next reconnect. So the honest bound is "one forged
        // frame buys N snapshots, once per wake", not "the cost of a cold wake" —
        // still bounded, still deferred (nothing is pushed and no live
        // subscription is interrupted), and still strictly less than the same
        // caller can spend by simply subscribing without a `sinceSeq`. Stated
        // plainly because a latch defended by an understated threat is a latch
        // someone deletes as unnecessary. A restore evicts the object, so the next
        // real fork gets a fresh instance and a fresh latch.
        if (this.forkSealed) {
            // Already sealed this wake: hand back the epoch minted then, so the
            // caller still stamps the post-fork timeline on its refusal.
            return this.cachedCdcEpoch();
        }

        this.forkSealed = true;

        return this.bumpCdcEpochUncached();
    }

    /**
     * Whether this shard has a `__cdc_log` table. The single source of the
     * "is CDC on here?" probe shared by `ShardDO.currentCdcCursor`,
     * `ShardDO.currentCdcEpoch`, `ShardDO.evaluateResume`, and the PITR-restore epoch
     * bump. Returns `false` (rather than throwing) on a stub `sql` handle (unit
     * harness double) or a pre-CDC shard, so callers degrade to the no-CDC path.
     */
    public cdcEnabled(): boolean {
        if (this.cdcLogPresent) {
            return true;
        }

        try {
            this.cdcLogPresent = this.host.sql().exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, CDC_LOG_TABLE).toArray().length > 0;
        } catch {
            return false;
        }

        return this.cdcLogPresent;
    }

    /**
     * The `__cdc_meta` epoch, read from SQLite at most once until
     * {@link invalidateCdcMetaCache} runs. Callers gate on {@link cdcEnabled}
     * first, except {@link sealForkedTimeline}, whose callers already proved it.
     */
    public cachedCdcEpoch(): string {
        this.cdcEpochCache ??= readCdcEpoch(this.host.sql());

        return this.cdcEpochCache;
    }

    /** Bump the CDC epoch and drop the CDC memos in one step, so no caller can bump without invalidating. */
    public bumpCdcEpochUncached(): string {
        const epoch = bumpCdcEpoch(this.host.sql());

        this.invalidateCdcMetaCache();

        return epoch;
    }

    /**
     * Drop both CDC memos — the single exit for every path that can change
     * `__cdc_log`'s presence or the `__cdc_meta` row behind this instance's back.
     */
    public invalidateCdcMetaCache(): void {
        this.cdcLogPresent = false;
        this.cdcEpochCache = undefined;
    }
}

export default CdcMeta;
