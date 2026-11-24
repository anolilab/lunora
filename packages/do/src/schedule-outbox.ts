/**
 * Durable custody for a shard's deferred `ctx.scheduler` calls: the outbox the
 * generated `buildCtx` records into inside the mutation's transaction, the retry
 * loop that re-offers what never reached the scheduler, and the operator's drop
 * and retry.
 *
 * Owns the in-memory hand-off and drop bookkeeping and reaches the shard only
 * through {@link ScheduleOutboxHost}. `ShardDO` keeps the protected
 * `scheduleOutbox`/`pollScheduleOutbox` surface the generated subclass calls, the
 * `scheduleOutboxScheduler` hook, and the admin RPC wrappers.
 */
import { isLunoraError, LunoraError } from "@lunora/errors";
import type { LogBuffer } from "@lunora/observability";
import type { ScheduleOutbox, ScheduleOutboxEnvelope, ScheduleOutboxRow, SchedulerLike, SqlExec } from "@lunora/shard-engine";
import {
    deferScheduleOutbox,
    dropScheduleOutbox,
    forgetScheduleOutbox,
    parkScheduleOutbox,
    probeScheduleOutbox,
    readDueScheduleOutbox,
    readDueScheduleOutboxEntry,
    readScheduleOutboxState,
    recordScheduleOutbox,
    requeueScheduleOutbox,
    trimScheduleOutbox,
} from "@lunora/shard-engine";
import { decodeWire, isPlainObject } from "@lunora/wire";

/**
 * The trace a log line is stamped with. Structurally `ShardDO`'s `TraceRefLike`,
 * restated because this module cannot import `shard-do.ts` without a cycle.
 */
interface TraceRef {
    traceId: string;
}

/**
 * How many deferred-schedule outbox entries one alarm tick may attempt. The
 * dispatches are outbound RPCs, so a backlog is drained across several ticks
 * rather than held open in one — the same bound `TTL_SWEEP_BATCH` puts on the
 * sweep tier for the same reason.
 */
const SCHEDULE_OUTBOX_BATCH = 32;

/**
 * How many times a deferred schedule is re-offered to the scheduler before the
 * entry is parked. Together with {@link SCHEDULE_OUTBOX_BACKOFF_MS} this spans a
 * little over an hour — long enough to ride out a scheduler restart or a
 * rebalance, short enough that a job the scheduler will never accept (a caller
 * error it refuses as `INVALID_INPUT`) stops costing alarms and starts being a
 * reported fact instead.
 *
 * A `retry.forever` call is not parked here: it is retried at the ladder's last
 * rung for as long as the scheduler keeps failing, and this count is only where
 * the one warning that it is still waiting gets logged.
 */
const SCHEDULE_OUTBOX_MAX_ATTEMPTS = 8;

/**
 * The retry ladder, indexed by attempt count: 5s, 15s, 45s, 2m, 6m, 18m, 30m,
 * 30m. Exponential until it flattens, so a transient blip is picked up almost
 * immediately while a persistent outage does not spin the alarm.
 */
const SCHEDULE_OUTBOX_BACKOFF_MS: ReadonlyArray<number> = [5000, 15_000, 45_000, 120_000, 360_000, 1_080_000, 1_800_000, 1_800_000];

/**
 * How long after a failed hand-off the first retry is offered — also the wake the
 * settle and the cold-start probe ask for, so custody that survived a dispatch is
 * re-offered promptly rather than at whatever cadence another tier happens to
 * want.
 */
const SCHEDULE_OUTBOX_FIRST_RETRY_MS = 5000;

/** The ladder's rung for `attempts` failures so far, flattening at its last entry. */
const scheduleOutboxBackoffFor = (attempts: number): number =>
    SCHEDULE_OUTBOX_BACKOFF_MS[Math.min(attempts, SCHEDULE_OUTBOX_BACKOFF_MS.length - 1)] ?? SCHEDULE_OUTBOX_FIRST_RETRY_MS;

/**
 * The attempt count after one more failure. Saturates rather than overflowing: a
 * `retry.forever` entry is never parked, so its count has no other ceiling.
 */
const nextScheduleOutboxAttempt = (attempts: number): number => Math.min(Number.MAX_SAFE_INTEGER, attempts + 1);

const isScheduleOutboxTarget = (target: unknown): boolean => {
    if (typeof target === "string") {
        return target.length > 0;
    }

    if (!isPlainObject(target)) {
        return false;
    }

    // The brand first: the scheduler routes any branded target to the workflow
    // path, so a stray `__lunoraRef` must not vouch for a workflow with no class.
    if (target["isLunoraWorkflow"] === true) {
        return (
            typeof target["className"] === "string" && target["className"].length > 0 && (target["name"] === undefined || typeof target["name"] === "string")
        );
    }

    return typeof target["__lunoraRef"] === "string" && target["__lunoraRef"].length > 0;
};

/**
 * Read one stored call back, or say why it cannot be replayed. Checked field by
 * field rather than cast: under the default policy a malformed entry would at
 * worst cost eight attempts, but a `retry.forever` one would never park, so an
 * envelope that can never become a job has to be recognised up front.
 *
 * `args` only has to decode: a workflow's params may be an array or a `Date`, so
 * the root is not required to be an object. A refusal carries whatever `target`
 * the JSON named, so the park log still says which job was lost.
 */
const parseScheduleOutboxEnvelope = (
    envelopeJson: string,
): { args: unknown; envelope: ScheduleOutboxEnvelope; ok: true } | { ok: false; reason: string; target: unknown } => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(envelopeJson);
    } catch {
        return { ok: false, reason: "its stored payload is not valid JSON", target: undefined };
    }

    if (!isPlainObject(parsed) || !Object.hasOwn(parsed, "args")) {
        return { ok: false, reason: "its stored payload is not a scheduled call", target: undefined };
    }

    const { args, options, target, when } = parsed;

    if (!isScheduleOutboxTarget(target)) {
        return { ok: false, reason: "its target is neither a function reference nor a workflow", target };
    }

    if (typeof when !== "number" || !Number.isFinite(when)) {
        return { ok: false, reason: "its fire time is missing", target };
    }

    if (options !== undefined && !isPlainObject(options)) {
        return { ok: false, reason: "its options are not an object", target };
    }

    // Built from the checked fields, so a field added to the envelope has to be validated here first.
    const envelope: ScheduleOutboxEnvelope = { args, options, target, when };

    try {
        return { args: decodeWire(args), envelope, ok: true };
    } catch {
        return { ok: false, reason: "its arguments cannot be decoded", target };
    }
};

/**
 * Ask the scheduler to cancel `id`, or reject when it cannot be asked. `SchedulerLike` only
 * declares the hand-off methods, but the scheduler a shard is configured with is the real client,
 * which has `cancel`. A missing scheduler or `cancel` is not a confirmation: the job may have been
 * accepted under a binding that has since gone, so the caller must keep the entry. Resolves to what the
 * scheduler answered: whether it held the job.
 */
/** Cancel errors raised because there is no scheduler (or none with `cancel`) to ask, as opposed to one that was asked and failed: waiting cannot fix them. */
const schedulerUnavailableErrors = new WeakSet<Error>();

const isSchedulerUnavailable = (error: unknown): boolean => error instanceof Error && schedulerUnavailableErrors.has(error);

const cancelScheduleOutboxJob = async (scheduler: SchedulerLike | undefined, id: string): Promise<boolean> => {
    const cancel = (scheduler as { cancel?: (jobId: string) => Promise<unknown> } | undefined)?.cancel;

    if (typeof cancel !== "function") {
        const error = new TypeError("no scheduler with a cancel method is configured on this shard, so the cancel cannot be confirmed");

        schedulerUnavailableErrors.add(error);

        throw error;
    }

    const answer = (await cancel.call(scheduler, id)) as { cancelled?: unknown } | undefined;

    // `false` is "no such job": never accepted, or already ended. The caller decides what that means.
    return answer?.cancelled === true;
};

/**
 * One hand-off awaiting the scheduler. `version` identifies the outbox row it was made for, so a
 * failure of an older attempt does not land on a row recorded anew under the same id. `token` is the
 * recording it carries (the `created_at` `record` answered), which is what a drop is compared against.
 */
interface ScheduleOutboxAttempt {
    stale: boolean;
    token: number | undefined;
    version: string | undefined;
}

/**
 * The dedup key a replay carries when its envelope was recorded without one (before the facade
 * fixed a key with its custody record): derived from the row, so every replay of the entry sends
 * the same key and a replay after one that landed is answered from that run.
 */
const replayDedupKey = (options: Record<string, unknown> | undefined, id: string, createdAt: number | undefined): { dedupKey?: string } =>
    options?.["dedupKey"] !== undefined || createdAt === undefined || !Number.isFinite(createdAt) || createdAt < 0
        ? {}
        : // `created_at` can be fractional (the outbox nudges it to keep rows ordered); `.` is outside the key grammar.
          { dedupKey: `${id}-${String(createdAt).replace(".", "_")}` };

/**
 * What a drop reports when it could not confirm the cancel. A plain error would be redacted to
 * "internal error" at the admin edge; this one is catalogued, so the operator learns the entry was
 * parked rather than dropped and that the drop has to be repeated.
 */
const scheduleOutboxDropFailure = (id: string, reason: string, cause: unknown): LunoraError =>
    new LunoraError(
        "SERVICE_UNAVAILABLE",
        `deferred schedule ${id} was parked, not dropped: ${reason}. It will not be handed over; ${
            isSchedulerUnavailable(cause) ? "drop it again to remove it without a confirmed cancel" : "drop it again once the scheduler answers"
        }.`,
        { cause },
    );

const retriesForever = (envelope: ScheduleOutboxEnvelope): boolean => {
    const retry = envelope.options?.["retry"];

    return isPlainObject(retry) && retry["forever"] === true;
};

/**
 * Why a failed attempt ends custody, or `undefined` to retry it. A `retry.forever`
 * entry parks only on a refusal no retry can change; anything else parks once the
 * attempt ceiling is reached.
 */
const scheduleOutboxParkReason = (error: unknown, forever: boolean, attempts: number): string | undefined => {
    if (forever) {
        return isLunoraError(error) && (error.code === "INVALID_INPUT" || error.code === "INVALID_SCHEDULE_ID")
            ? `the scheduler refused the stored call: ${error.code}`
            : undefined;
    }

    if (attempts >= SCHEDULE_OUTBOX_MAX_ATTEMPTS) {
        return `${String(SCHEDULE_OUTBOX_MAX_ATTEMPTS)} attempts all failed — last: ${error instanceof Error ? error.message : String(error)}`;
    }

    return undefined;
};

/**
 * How long a PARKED outbox entry is kept. A job that exhausted its attempts is
 * evidence — the operator needs to know what was promised and never enqueued —
 * so it is retained for a week rather than deleted, and trimmed after. Live
 * entries are never trimmed; the attempt ceiling is what bounds those.
 */
const SCHEDULE_OUTBOX_RETENTION_MS = 604_800_000;

/**
 * What the outbox needs of the shard. Thunks, because the runner is built as a
 * field initializer before the DO's constructor runs, and because `scheduler`
 * is the generated subclass's override hook, asked on every call.
 */
interface ScheduleOutboxHost {
    /** `ShardDO.admitScheduleRate`: the per-target schedule budget the facade consults. */
    admitScheduleRate: (target: string) => number | undefined;
    /** The in-memory log ring the Studio reads; outbox parks and drops are reported there. */
    logs: () => LogBuffer;
    recordAudit: (call: Record<string, unknown>, op: string, fields?: { detail?: Record<string, unknown>; id?: string }) => void;
    /** Arm the shared poll alarm; see `ShardDO.scheduleGlobalPoll`. */
    scheduleGlobalPoll: (atMs?: number, rethrow?: boolean) => Promise<void>;
    scheduler: () => SchedulerLike | undefined;
    sql: () => SqlExec;
}

/**
 * Per-instance outbox bookkeeping. A class, like `CdcRetentionRunner`, because an
 * attempt, a drop and a pending hand-off never outlive the instance that started
 * them, and module state would let one shard's drop cover another's job.
 */
class ScheduleOutboxRunner {
    private readonly host: ScheduleOutboxHost;

    /**
     * The hand-offs awaiting the scheduler, per outbox id. `retryOutboxEntry` makes them `stale`
     * (their failure must not overwrite the reset). Whether one was dropped is read from
     * {@link ScheduleOutboxRunner.scheduleOutboxDroppedThrough} by its token, not inferred from the row, because a
     * row can also vanish for an innocent reason. In memory is enough: an attempt never outlives the
     * instance that started it.
     */
    private readonly scheduleOutboxAttempts = new Map<string, Set<ScheduleOutboxAttempt>>();

    /**
     * Outbox entries an operator is dropping right now. The drop first asks the
     * scheduler to cancel the job (it may already hold it), and the retry loop must
     * not hand the entry over again while that is awaiting.
     */
    private readonly scheduleOutboxDrops = new Map<string, Set<Promise<void>>>();

    /**
     * Per id, the newest recording an operator dropped: a drop covers every call recorded up to the
     * row it acted on (including calls of one mutation that a later same-id record replaced), and
     * no call recorded after it. A missing row alone cannot say "dropped": two calls of one mutation
     * that share an explicit id share one row, and the first hand-off releases it. Pruned by
     * {@link ScheduleOutboxRunner.pruneScheduleOutboxDropMarker} once no call or attempt it could affect is left.
     */
    private readonly scheduleOutboxDroppedThrough = new Map<string, number>();

    /**
     * Calls recorded for an id whose hand-off has not finished (or whose window has not rolled back).
     * A drop marker is needed exactly that long, so it is pruned when this reaches zero instead of by
     * count: evicting a marker early would let a queued call of a dropped job run.
     */
    private readonly scheduleOutboxPendingHandOffs = new Map<string, number>();

    /** The `created_at` last handed to `recordScheduleOutbox`; see {@link ScheduleOutboxRunner.scheduleOutbox}. */
    private lastScheduleOutboxRecordAt = 0;

    public constructor(host: ScheduleOutboxHost) {
        this.host = host;
    }

    /**
     * Durable custody for this shard's deferred `ctx.scheduler` calls — the
     * `ScheduleOutbox` the generated `buildCtx` hands to
     * `withDeferredSchedules`.
     *
     * The two halves land on opposite sides of the COMMIT on purpose:
     *
     * - `record` runs while the handler is still inside its transaction, so the
     * entry is durable exactly when the writes are and rolls back with them.
     * It deliberately does NOT swallow: a failure here is still inside the span,
     * so letting it throw rolls the mutation back — the one moment at which
     * failing is free. Swallowing would put us back where we started, committing
     * writes whose job nothing is holding.
     * - `forget` runs after the dispatch, so it must never fail the response. A
     * delete that does not land leaves an entry the retry loop re-offers, which
     * the scheduler refuses as a duplicate and which is then dropped — the error
     * self-heals into one wasted RPC.
     *
     * What survives a settle is therefore exactly the set of jobs that were
     * promised and not enqueued, which is what {@link ScheduleOutboxRunner.pollScheduleOutbox}
     * drains.
     */
    public scheduleOutbox(): ScheduleOutbox {
        return {
            forget: (id: string): void => {
                // A window that rolled back: its call will never be handed off.
                this.finishScheduleOutboxHandOff(id);

                try {
                    forgetScheduleOutbox(this.host.sql(), id);
                } catch {
                    // Post-commit: a missing table (pre-migration shard / test stub)
                    // or a stub handle must not fail a mutation that succeeded. The
                    // stale entry is re-offered and refused as a duplicate.
                }
            },
            handOff: async (id, run, token): Promise<void> => {
                await this.runScheduleOutboxHandOff(id, run, token === undefined ? undefined : Number(token));
            },
            record: (id, envelope): string => {
                // Strictly increasing, so two records never share a `created_at`: it is the token this
                // call's hand-off carries, a drop covers tokens up to the row it acted on and none after,
                // and a row's (created_at, envelope) pair identifies it.
                this.lastScheduleOutboxRecordAt = Math.max(Date.now(), this.lastScheduleOutboxRecordAt + 0.001);
                recordScheduleOutbox(this.host.sql(), id, JSON.stringify(envelope), this.lastScheduleOutboxRecordAt);
                this.scheduleOutboxPendingHandOffs.set(id, (this.scheduleOutboxPendingHandOffs.get(id) ?? 0) + 1);

                return String(this.lastScheduleOutboxRecordAt);
            },
            wake: (): void => {
                // Fire-and-forget: this is called from a settle that is about to
                // throw, and arming the alarm is not allowed to change what it
                // throws. `scheduleGlobalPoll` already no-ops when an earlier wake
                // is pending and absorbs a host that cannot arm.
                this.host.scheduleGlobalPoll(Date.now() + SCHEDULE_OUTBOX_FIRST_RETRY_MS).catch(() => {
                    /* the host could not arm; the next cold start probes again */
                });
            },
            admit: (target: string): number | undefined => this.host.admitScheduleRate(target),
        };
    }

    /**
     * Re-offer the deferred schedules that were promised to a caller and never
     * reached the scheduler — the retry half of {@link ScheduleOutboxRunner.scheduleOutbox}.
     * Shares the poll alarm with the source-ingest and TTL tiers, and reports the
     * earliest next-due time the same way, so a shard with an empty outbox (the
     * steady state — an entry lives only between a COMMIT and its dispatch) arms
     * nothing.
     *
     * Each attempt reuses the id the caller was already handed, so an entry whose
     * original dispatch DID land — the failure was the `forget`, or the isolate
     * died between the two — is refused as a duplicate rather than scheduled
     * twice. A refusal and an acceptance are therefore both "the scheduler has
     * it", and both end custody.
     *
     * The default bound is {@link SCHEDULE_OUTBOX_MAX_ATTEMPTS}: a job the
     * scheduler will never accept stops costing alarms and becomes a reported
     * fact instead — parked, logged at `error` with its id and target, and kept
     * for {@link SCHEDULE_OUTBOX_RETENTION_MS} so an operator can see what was
     * promised and never enqueued. A call made with `retry.forever` opts out of
     * that ceiling: it stays live, paced by the ladder's last rung, until the
     * scheduler accepts it or refuses it as invalid. The retention sweep only
     * ever drops parked rows. The sweep rides whatever tick reaches this tier, so a shard
     * holding ONLY parked entries keeps them until something else wakes it —
     * which is the right trade: they are one row per genuinely lost job, not a
     * loop that grows on its own.
     */
    public async pollScheduleOutbox(trace?: TraceRef): Promise<number | undefined> {
        const sql = this.host.sql();
        const now = Date.now();
        let probe: { dueAt: number | undefined; populated: boolean };

        try {
            probe = probeScheduleOutbox(sql);
        } catch {
            // No table (a shard whose store predates it, a harness with a stub
            // handle) means no custody, which is a dormant tier and not a tier
            // failure — re-arming the alarm over it would wake an idle DO forever.
            return undefined;
        }

        if (!probe.populated) {
            return undefined;
        }

        if (probe.dueAt !== undefined && probe.dueAt <= now) {
            const scheduler = this.host.scheduler();

            for (const entry of readDueScheduleOutbox(sql, now, SCHEDULE_OUTBOX_BATCH)) {
                // eslint-disable-next-line no-await-in-loop -- each attempt is an outbound RPC to one DO; firing the batch at once is what the per-tick bound exists to prevent
                await this.retryScheduleOutboxEntry(sql, scheduler, entry, trace);
            }
        }

        trimScheduleOutbox(sql, now - SCHEDULE_OUTBOX_RETENTION_MS);

        return probeScheduleOutbox(sql).dueAt;
    }

    /**
     * Arm the poll alarm once per warm instance if this shard is holding deferred
     * schedules nobody has enqueued.
     *
     * The settle asks for a wake when its own dispatch fails, but the window that
     * loses a job most quietly is the one where no settle ran at all: the DO is
     * evicted between the COMMIT and the dispatch, and the entry sits with nothing
     * pointing at it. Every entry point into this object goes through shard init,
     * so hooking it here means the next time anything wakes this shard the retry
     * loop starts — for the cost of one indexed read per cold start.
     *
     * Swallows: a shard whose store predates the table (or a harness with a stub
     * handle) simply has no custody to resume, and init must not fail for it.
     */
    public armScheduleOutboxRetry(): void {
        try {
            if (probeScheduleOutbox(this.host.sql()).dueAt !== undefined) {
                this.host.scheduleGlobalPoll(Date.now() + SCHEDULE_OUTBOX_FIRST_RETRY_MS).catch(() => {
                    /* the host could not arm; the next cold start probes again */
                });
            }
        } catch {
            // No table, no custody to resume.
        }
    }

    /**
     * Serve `dropOutboxEntry` — cancel a deferred schedule the scheduler never
     * confirmed, live or parked. `ctx.scheduler.cancel` only reaches jobs the
     * SchedulerDO holds, so this is the only way to stop a `retry.forever` entry
     * that is still waiting.
     *
     * The shard cannot always tell that the scheduler never got the job: the accept
     * may have been lost on the way back, or an attempt may be awaiting it right now.
     * So the drop cancels the id at the scheduler FIRST and deletes the row only once
     * that settled. A cancel that fails (the scheduler is often the very thing that is down)
     * parks the entry so it can never be handed over, and the error goes to the operator;
     * dropping again completes it. And an attempt that was already in the air takes the job back out
     * when it lands, see {@link ScheduleOutboxRunner.retryScheduleOutboxEntry}. Admin-gated by the caller.
     */
    public async drop(args: Record<string, unknown>, id: string): Promise<{ dropped: boolean }> {
        const sql = this.host.sql();

        const before = readScheduleOutboxState(sql, id);

        if (before === undefined) {
            return { dropped: false };
        }

        // Registered before the first await, so the retry loop and every hand-off up to this row see
        // it. The coverage ends at the row being dropped: a job recorded anew under the same id after
        // this point carries a newer token and is not part of this drop.
        const settled = Promise.withResolvers<undefined>();
        const drops = this.scheduleOutboxDrops.get(id) ?? new Set<Promise<void>>();

        drops.add(settled.promise);
        this.scheduleOutboxDrops.set(id, drops);
        this.markScheduleOutboxDropped(id, before.createdAt);

        try {
            let cancelError: Error | undefined;
            let held = true;

            try {
                held = await cancelScheduleOutboxJob(this.host.scheduler(), id);
            } catch (error) {
                cancelError = error instanceof Error ? error : new Error(String(error));
            }

            const after = readScheduleOutboxState(sql, id);

            if (after?.version !== before.version) {
                // The entry this drop was cancelling is gone, replaced by a new schedule under the same
                // id (or released by its own hand-off). Whatever is there now is not this drop's to
                // delete, mark or park. But a refused cancel still means the old job may be running.
                if (cancelError !== undefined) {
                    this.host.recordAudit(args, "dropOutboxEntry", { id, detail: { outcome: "failed" } });

                    throw scheduleOutboxDropFailure(id, cancelError.message, cancelError);
                }

                this.host.recordAudit(args, "dropOutboxEntry", { id, detail: { outcome: "applied" } });

                return { dropped: true };
            }

            // An attempt still awaiting the scheduler may yet land the job: it sees the drop by its
            // token and cancels the job itself, and the row has to outlive it. Parking keeps the row
            // from being handed over meanwhile; the attempt removes it once its cancel is confirmed.
            const awaiting = this.scheduleOutboxAttempts.get(id);

            // A job that landed during the drop and could not be cancelled by its attempt left the
            // row parked, which it was not when the drop began: the job may still run.
            if (cancelError === undefined && after.parked && !before.parked) {
                cancelError = new Error("a hand-off that landed during the drop could not be cancelled, so the job may still run");
            }

            if (this.removeUnconfirmableScheduleOutboxDrop(args, sql, id, cancelError, before.parked && after.parked, awaiting)) {
                return { dropped: true };
            }

            if (cancelError !== undefined) {
                // The scheduler may be the very thing that is down. The operator asked for this job
                // to stop, so the shard must not hand it over in the meantime: park it and report
                // the failure. Dropping again, once the scheduler answers, completes the cancel.
                this.parkLiveScheduleOutboxEntry(sql, id);
                this.host.logs().push({
                    functionPath: "scheduler:outbox",
                    level: "error",
                    message: `deferred schedule ${id} was dropped by an operator but the scheduler could not confirm the cancel (${cancelError.message}). It is parked and will not be handed over; drop it again once the scheduler answers.`,
                    timestamp: Date.now(),
                });
                this.host.recordAudit(args, "dropOutboxEntry", { id, detail: { outcome: "parked" } });

                throw scheduleOutboxDropFailure(id, cancelError.message, cancelError);
            }

            if (awaiting === undefined || awaiting.size === 0) {
                dropScheduleOutbox(sql, id);
            } else {
                this.parkLiveScheduleOutboxEntry(sql, id);
            }

            this.auditAppliedScheduleOutboxDrop(args, id, held);

            return { dropped: true };
        } finally {
            drops.delete(settled.promise);

            if (drops.size === 0) {
                this.scheduleOutboxDrops.delete(id);
            }

            settled.resolve(undefined);
            this.pruneScheduleOutboxDropMarker(id);
        }
    }

    /**
     * Put an entry back on the retry ladder, due now: the way back for a parked
     * entry, and a way to skip a long backoff once the scheduler is healthy. The
     * caller arms the poll alarm, because nothing else is due to wake a shard
     * whose entries were all parked.
     * @returns whether the entry was requeued
     */
    public retry(id: string, now: number): boolean {
        // A drop owns the id until its cancel settles; requeueing now would report a retry the drop then undoes.
        const retried = !this.isScheduleOutboxBeingDropped(id) && requeueScheduleOutbox(this.host.sql(), id, now);

        if (retried) {
            // The operator wants the job after all: an attempt still carrying an earlier drop must
            // not cancel it or delete the requeued row when it lands.
            for (const attempt of this.scheduleOutboxAttempts.get(id) ?? []) {
                attempt.stale = true;
            }

            this.scheduleOutboxDroppedThrough.delete(id);
        }

        return retried;
    }

    /**
     * Audit a drop that applied. "Not found" is the usual answer for a job the scheduler never
     * accepted, and the same answer it gives once an accepted job has run: an earlier hand-off whose
     * accept was lost on the way back. The drop cannot tell the two apart, so the operator is told the
     * job may have run.
     */
    private auditAppliedScheduleOutboxDrop(call: Record<string, unknown>, id: string, held: boolean): void {
        if (!held) {
            this.host.logs().push({
                functionPath: "scheduler:outbox",
                level: "warn",
                message: `deferred schedule ${id} was dropped, but the scheduler held no job under that id. Usually it was never accepted; if an earlier hand-off was accepted and only its answer was lost, the job may already have run.`,
                timestamp: Date.now(),
            });
        }

        this.host.recordAudit(call, "dropOutboxEntry", { id, detail: held ? { outcome: "applied" } : { outcome: "applied", schedulerHeld: false } });
    }

    /**
     * With no scheduler to ask, waiting never confirms the cancel. The first drop parked the row (a
     * job may have been accepted under a binding that has since gone); dropping a row that was already
     * parked, with nothing in flight, is the operator accepting that, and removes it.
     * @returns whether the row was removed
     */
    private removeUnconfirmableScheduleOutboxDrop(
        call: Record<string, unknown>,
        sql: SqlExec,
        id: string,
        cancelError: Error | undefined,
        alreadyParked: boolean,
        awaiting: ReadonlySet<ScheduleOutboxAttempt> | undefined,
    ): boolean {
        if (!isSchedulerUnavailable(cancelError) || !alreadyParked || (awaiting !== undefined && awaiting.size > 0)) {
            return false;
        }

        dropScheduleOutbox(sql, id);
        this.host.logs().push({
            functionPath: "scheduler:outbox",
            level: "warn",
            message: `deferred schedule ${id} was removed by a repeated drop without a confirmed cancel: no scheduler is configured on this shard to ask. If it was accepted under a scheduler that has since been removed, it may still run there.`,
            timestamp: Date.now(),
        });
        this.host.recordAudit(call, "dropOutboxEntry", { id, detail: { outcome: "applied", schedulerHeld: "unknown" } });

        return true;
    }

    /**
     * One outbox attempt: replay the stored call, then either end custody or push
     * the entry out along {@link SCHEDULE_OUTBOX_BACKOFF_MS}. The default policy
     * parks once the ladder runs out; `retry.forever` keeps a valid call live.
     *
     * An envelope that will not parse is parked immediately rather than retried:
     * no number of attempts turns malformed JSON into a job, and the log line is
     * the only useful output left.
     */
    private async retryScheduleOutboxEntry(sql: SqlExec, scheduler: SchedulerLike | undefined, snapshot: ScheduleOutboxRow, trace?: TraceRef): Promise<void> {
        // The tick read its batch before awaiting the scheduler for the rows ahead of
        // this one, so the snapshot may predate an operator's drop, requeue or park.
        // The row is read again, synchronously with the claim below, and that read is
        // what gets replayed. A drop in progress owns the id until it settles.
        const entry = this.isScheduleOutboxBeingDropped(snapshot.id) ? undefined : readDueScheduleOutboxEntry(sql, snapshot.id, Date.now());
        const state = readScheduleOutboxState(sql, snapshot.id);

        if (entry === undefined) {
            return;
        }

        const attempts = nextScheduleOutboxAttempt(entry.attempts);
        const stored = parseScheduleOutboxEnvelope(entry.envelopeJson);

        if (!stored.ok) {
            this.parkScheduleOutboxEntry(sql, entry.id, attempts, stored.target, stored.reason, trace);

            return;
        }

        const { envelope } = stored;
        const forever = retriesForever(envelope);

        if (scheduler === undefined) {
            if (forever) {
                this.deferScheduleOutboxEntry(sql, entry.id, attempts, true, trace);
            } else {
                this.parkScheduleOutboxEntry(sql, entry.id, attempts, envelope.target, "no scheduler is configured on this shard", trace);
            }

            return;
        }

        const attempt: ScheduleOutboxAttempt = { stale: false, token: state?.createdAt, version: state?.version };
        const awaiting = this.scheduleOutboxAttempts.get(entry.id) ?? new Set<ScheduleOutboxAttempt>();

        awaiting.add(attempt);
        this.scheduleOutboxAttempts.set(entry.id, awaiting);

        try {
            // `runAt`, never `runAfter`: the envelope stores the absolute instant
            // the caller asked for, so an entry that spent an hour in custody still
            // fires when it was meant to rather than an hour late.
            await (scheduler.runAt as (timestampMs: number, target: never, args: never, options?: never) => Promise<string>)(
                envelope.when,
                envelope.target as never,
                stored.args as never,
                { ...envelope.options, ...replayDedupKey(envelope.options, entry.id, state?.createdAt), id: entry.id } as never,
            );

            await this.settleScheduleOutboxHandOff(sql, scheduler, entry.id, attempt.version, this.wasScheduleOutboxDropped(entry.id, attempt), true, trace);
        } catch (error) {
            await this.settleFailedScheduleOutboxAttempt(sql, scheduler, { attempt, attempts, envelope, error, forever, id: entry.id }, trace);
        } finally {
            awaiting.delete(attempt);

            if (awaiting.size === 0) {
                this.scheduleOutboxAttempts.delete(entry.id);
            }
        }
    }

    /**
     * The post-commit hand-off of a deferred schedule, run as a recorded attempt like every retry:
     * a drop that arrives while the call awaits the scheduler is seen here and the job is cancelled
     * when it lands (the row stays parked if that cancel fails). A failure leaves the row for the
     * retry loop, unless a drop already ended the entry, in which case the row goes.
     */
    private async runScheduleOutboxHandOff(id: string, run: () => Promise<unknown>, token: number | undefined): Promise<void> {
        try {
            // Covered by a drop already: it never goes out, and waits for nothing.
            if (!this.isScheduleOutboxTokenDropped(id, token)) {
                // A newer schedule must not meet an id-only cancel still in flight for the old one at
                // the scheduler, so it goes out only after every drop in progress has settled.
                for (let drops = this.scheduleOutboxDrops.get(id); drops !== undefined && drops.size > 0; drops = this.scheduleOutboxDrops.get(id)) {
                    // eslint-disable-next-line no-await-in-loop -- a drop that starts while waiting must be waited for too
                    await Promise.all(drops);
                }
            }

            await this.handOffRecordedScheduleOutboxCall(id, run, token);
        } finally {
            this.finishScheduleOutboxHandOff(id);
        }
    }

    private async handOffRecordedScheduleOutboxCall(id: string, run: () => Promise<unknown>, token: number | undefined): Promise<void> {
        const sql = this.host.sql();

        // An operator may have dropped the entry (or the retry loop parked it) while an earlier
        // hand-off in the same drain was still awaiting: the call must not start then. Checked
        // synchronously with the registration below, the same ordering a drop uses.
        const state = readScheduleOutboxState(sql, id);

        if (this.isScheduleOutboxTokenDropped(id, token)) {
            return;
        }

        // A parked row is one the retry loop gave up on or a failed drop stopped. An ABSENT row is
        // not a drop: a sibling call with the same explicit id may already have released it, and that
        // call must still reach the scheduler, which answers it as a duplicate.
        if (state?.parked === true) {
            return;
        }

        const attempt: ScheduleOutboxAttempt = { stale: false, token, version: state?.version };
        const awaiting = this.scheduleOutboxAttempts.get(id) ?? new Set<ScheduleOutboxAttempt>();

        awaiting.add(attempt);
        this.scheduleOutboxAttempts.set(id, awaiting);

        try {
            await run();
        } catch (error) {
            try {
                if (this.wasScheduleOutboxDropped(id, attempt)) {
                    await this.settleScheduleOutboxHandOff(sql, this.host.scheduler(), id, attempt.version, true, false);
                }
            } catch {
                // The original failure is the one to report; the row stays for the retry loop.
            } finally {
                this.releaseScheduleOutboxAttempt(id, awaiting, attempt);
            }

            throw error;
        }

        try {
            await this.settleScheduleOutboxHandOff(sql, this.host.scheduler(), id, attempt.version, this.wasScheduleOutboxDropped(id, attempt), true);
        } catch {
            // The scheduler accepted the job and the mutation committed. A bookkeeping failure here
            // (a storage hiccup, a stub handle) must not surface as a failed mutation: the row that
            // is left behind is re-offered by the retry loop and refused as a duplicate.
        } finally {
            this.releaseScheduleOutboxAttempt(id, awaiting, attempt);
        }
    }

    private markScheduleOutboxDropped(id: string, through: number): void {
        this.scheduleOutboxDroppedThrough.set(id, Math.max(through, this.scheduleOutboxDroppedThrough.get(id) ?? 0));
    }

    private isScheduleOutboxBeingDropped(id: string): boolean {
        return (this.scheduleOutboxDrops.get(id)?.size ?? 0) > 0;
    }

    /** One recorded call is done with: handed off, skipped, or rolled back with its window. */
    private finishScheduleOutboxHandOff(id: string): void {
        const left = (this.scheduleOutboxPendingHandOffs.get(id) ?? 0) - 1;

        if (left > 0) {
            this.scheduleOutboxPendingHandOffs.set(id, left);
        } else {
            this.scheduleOutboxPendingHandOffs.delete(id);
        }

        this.pruneScheduleOutboxDropMarker(id);
    }

    /**
     * Forget the drop marker of `id` once nothing it could still decide is left: no recorded call
     * waiting for its hand-off, no attempt awaiting the scheduler, no drop in flight. Pruned by that
     * condition rather than by count, because evicting a marker early would let a queued call of a
     * dropped job go out.
     */
    private pruneScheduleOutboxDropMarker(id: string): void {
        if (
            (this.scheduleOutboxPendingHandOffs.get(id) ?? 0) === 0 &&
            (this.scheduleOutboxAttempts.get(id)?.size ?? 0) === 0 &&
            !this.isScheduleOutboxBeingDropped(id)
        ) {
            this.scheduleOutboxDroppedThrough.delete(id);
        }
    }

    /** Whether a drop covers the recording `token` names: recorded no later than the row it acted on. */
    private isScheduleOutboxTokenDropped(id: string, token: number | undefined): boolean {
        const through = this.scheduleOutboxDroppedThrough.get(id);

        return token !== undefined && through !== undefined && token <= through;
    }

    /** Whether the entry this attempt was made for has been dropped, now or while it was in the air. */
    private wasScheduleOutboxDropped(id: string, attempt: ScheduleOutboxAttempt): boolean {
        return this.isScheduleOutboxTokenDropped(id, attempt.token);
    }

    private releaseScheduleOutboxAttempt(id: string, awaiting: Set<ScheduleOutboxAttempt>, attempt: ScheduleOutboxAttempt): void {
        awaiting.delete(attempt);

        if (awaiting.size === 0) {
            this.scheduleOutboxAttempts.delete(id);
            this.pruneScheduleOutboxDropMarker(id);
        }
    }

    /** A hand-off that threw: end custody if the scheduler turns out to hold the job, else defer or park the entry. */
    private async settleFailedScheduleOutboxAttempt(
        sql: SqlExec,
        scheduler: SchedulerLike,
        failed: {
            attempt: ScheduleOutboxAttempt;
            attempts: number;
            envelope: ScheduleOutboxEnvelope;
            error: unknown;
            forever: boolean;
            id: string;
        },
        trace?: TraceRef,
    ): Promise<void> {
        const { attempt, attempts, envelope, error, forever, id } = failed;

        // A duplicate id means the scheduler already has this job — the first
        // dispatch landed and only the bookkeeping was lost. Custody ends the
        // same way an acceptance ends it.
        if (isLunoraError(error) && error.code === "DUPLICATE_SCHEDULE_ID") {
            await this.settleScheduleOutboxHandOff(sql, scheduler, id, attempt.version, this.wasScheduleOutboxDropped(id, attempt), true, trace);

            return;
        }

        // The operator dropped the entry while this attempt was awaiting.
        // The accept may have been lost on the way back, so the job can still exist: cancel it, and
        // keep the row (parked) if that cannot be confirmed.
        if (this.wasScheduleOutboxDropped(id, attempt)) {
            await this.settleScheduleOutboxHandOff(sql, scheduler, id, attempt.version, true, false, trace);

            return;
        }

        // `retryOutboxEntry` reset the row while this attempt was awaiting the
        // scheduler; writing this attempt's count and backoff would undo that.
        if (attempt.stale) {
            return;
        }

        // The row was recorded anew under the same id while this attempt was awaiting: its backoff
        // or park state would land on a different schedule.
        if (readScheduleOutboxState(sql, id)?.version !== attempt.version) {
            return;
        }

        const parkReason = scheduleOutboxParkReason(error, forever, attempts);

        if (parkReason === undefined) {
            this.deferScheduleOutboxEntry(sql, id, attempts, forever, trace);
        } else {
            this.parkScheduleOutboxEntry(sql, id, attempts, envelope.target, parkReason, trace);
        }
    }

    /**
     * The scheduler holds the job: end custody. If the entry was dropped while the
     * hand-off was awaiting (or a drop is cancelling it right now), the operator asked
     * for the job NOT to run, so take it back out of the scheduler. `landed` says the scheduler
     * is known to hold (or to have held) the job, which is what makes a "not found" cancel a failure.
     */
    private async settleScheduleOutboxHandOff(
        sql: SqlExec,
        scheduler: SchedulerLike | undefined,
        id: string,
        version: string | undefined,
        dropped: boolean,
        landed: boolean,
        trace?: TraceRef,
    ): Promise<void> {
        if (!dropped) {
            forgetScheduleOutbox(sql, id);

            return;
        }

        // `version` is the row this attempt was made for. A row recorded since under the same id is a
        // newer request the drop does not cover, and the retry loop's only copy of that call: it is
        // neither deleted nor parked, and with an id-only cancel the job the scheduler holds may already
        // be its, so this hand-off does not cancel either. An absent row is not a replacement.
        const replaced = (): boolean => {
            const current = readScheduleOutboxState(sql, id)?.version;

            return current !== undefined && current !== version;
        };

        if (replaced()) {
            return;
        }

        // The row goes only once the cancel is confirmed. If it cannot be, the entry stays
        // (parked, so it is never handed over again) and a later drop can finish the cancel.
        try {
            const held = await cancelScheduleOutboxJob(scheduler, id);

            // A job that was just accepted and is now "not found" has already run or ended: the drop
            // did not stop it, and the operator has to hear that rather than see the entry vanish.
            // A call that was rejected may never have been accepted, where "not found" is the normal answer.
            if (landed && !held) {
                throw new Error("the scheduler no longer holds the job (it already ran or ended), so the drop could not stop it");
            }

            if (!replaced()) {
                forgetScheduleOutbox(sql, id);
            }
        } catch (error) {
            if (!replaced()) {
                this.parkLiveScheduleOutboxEntry(sql, id);
            }

            this.host.logs().push({
                functionPath: "scheduler:outbox",
                level: "error",
                message: `deferred schedule ${id} was dropped while its hand-off was in flight, and cancelling it at the scheduler failed: ${error instanceof Error ? error.message : String(error)}. The job may still run; drop the parked entry again once the scheduler answers.`,
                timestamp: Date.now(),
                traceId: trace?.traceId,
            });
        }
    }

    /** Park `id` if it is still live, keeping its attempt count; a parked or absent row is left as it is. */
    // eslint-disable-next-line class-methods-use-this -- sits beside the other outbox row transitions
    private parkLiveScheduleOutboxEntry(sql: SqlExec, id: string): void {
        const live = readDueScheduleOutboxEntry(sql, id, Number.MAX_SAFE_INTEGER);

        if (live !== undefined) {
            parkScheduleOutbox(sql, id, live.attempts, Date.now());
        }
    }

    /**
     * Push one entry out along the ladder. A `retry.forever` entry that reaches
     * the attempts a default entry would have parked at says so once, at `warn`:
     * past that point nothing else reports that the job is still not enqueued.
     */
    private deferScheduleOutboxEntry(sql: SqlExec, id: string, attempts: number, forever: boolean, trace?: TraceRef): void {
        deferScheduleOutbox(sql, id, attempts, Date.now() + scheduleOutboxBackoffFor(attempts));

        if (forever && attempts === SCHEDULE_OUTBOX_MAX_ATTEMPTS) {
            this.host.logs().push({
                functionPath: "scheduler:outbox",
                level: "warn",
                message: `deferred schedule ${id} is still waiting for the scheduler after ${String(attempts)} attempts. Its mutation committed; custody keeps retrying (retry.forever).`,
                timestamp: Date.now(),
                traceId: trace?.traceId,
            });
        }
    }

    /** Park one entry and say so at `error` — a job was promised to a caller and will not be enqueued. */
    private parkScheduleOutboxEntry(sql: SqlExec, id: string, attempts: number, target: unknown, why: string, trace?: TraceRef): void {
        parkScheduleOutbox(sql, id, attempts, Date.now());

        this.host.logs().push({
            functionPath: "scheduler:outbox",
            level: "error",
            message: `deferred schedule ${id} (target ${target === undefined ? "<unreadable>" : JSON.stringify(target)}) will not be enqueued: ${why}. Its mutation committed; the job did not.`,
            timestamp: Date.now(),
            traceId: trace?.traceId,
        });
    }
}

export default ScheduleOutboxRunner;
