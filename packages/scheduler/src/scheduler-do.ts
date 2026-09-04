import { toBase64Url } from "../../../shared/base64";
import { jsonResponse } from "../../../shared/json-response";
import resolveScheduleId from "./resolve-schedule-id";
import type { RetryPolicy, ScheduleRecord } from "./types";

/**
 * Minimal projection of `DurableObjectState` for the SchedulerDO. Declared
 * structurally so unit tests can pass a fake state without booting the
 * workers runtime. The WebSocket methods are optional: they back the live
 * `/ws` subscription (push the job list on every change) and are absent in the
 * storage-only fakes, in which case the DO simply serves no live sockets.
 */
interface SchedulerDOState {
    /** Accept a hibernatable server WebSocket (workers `state.acceptWebSocket`). */
    acceptWebSocket?: (ws: WebSocket) => void;
    /** Every accepted server WebSocket (workers `state.getWebSockets`). */
    getWebSockets?: () => WebSocket[];

    /**
     * Register a constant ping/pong auto-response so the runtime answers a
     * known keepalive frame on a hibernated socket WITHOUT waking this DO (no
     * billable request, no dispatch). Optional: absent in the unit harness and
     * older runtimes, present on the real `DurableObjectState`. Mirrors
     * `@lunora/do`'s `ShardDOState.setWebSocketAutoResponse` — see
     * {@link SchedulerDO.armWebSocketKeepalive}.
     */
    setWebSocketAutoResponse?: (pair: WebSocketRequestResponsePair) => void;
    storage: {
        delete: (key: string | string[]) => Promise<number | boolean>;
        deleteAlarm: () => Promise<void> | void;
        get: <T = unknown>(key: string) => Promise<T | undefined>;
        getAlarm: () => Promise<number | null>;
        list: <T = unknown>(options?: { end?: string; limit?: number; prefix?: string; startAfter?: string }) => Promise<Map<string, T>>;
        put: <T = unknown>(entries: Record<string, T> | string, value?: T) => Promise<void>;
        setAlarm: (scheduledTime: number | Date) => Promise<void> | void;
    };
}

interface SchedulerEnv {
    [key: string]: unknown;

    /* eslint-disable no-secrets/no-secrets -- JSDoc names a stable env-var, not a secret */

    /**
     * Fallback bearer token attached to the dispatch when
     * {@link SchedulerEnv.LUNORA_SCHEDULER_SECRET} is not configured. Sent as
     * `authorization: Bearer <token>`.
     */
    /* eslint-enable no-secrets/no-secrets */
    LUNORA_ADMIN_TOKEN?: string;

    /**
     * Base URL where the Worker is mounted. SchedulerDO uses this at dispatch
     * time to call back into the Worker. Read at fire time (NOT taken from the
     * request body) to prevent SSRF via a forged `originUrl` field.
     */
    LUNORA_ORIGIN_URL?: string;

    /**
     * Shared secret used to HMAC-sign the dispatch body so the runtime receiver
     * can authenticate the call (header `x-lunora-scheduler-signature`). Without
     * it the dispatch is sent unsigned (optionally bearer-authenticated via
     * {@link SchedulerEnv.LUNORA_ADMIN_TOKEN}).
     */
    LUNORA_SCHEDULER_SECRET?: string;
}

/**
 * Client→server text frame the runtime answers with {@link WS_KEEPALIVE_PONG}
 * via the DO Hibernation API's auto-response — see
 * {@link SchedulerDO.armWebSocketKeepalive}. The exchange never wakes this
 * Durable Object, so an idle `/ws` subscription stays alive across
 * hibernation without a billable request. Deliberately the SAME literal pair
 * `@lunora/do`'s `ShardDO` uses (not imported — `@lunora/scheduler` doesn't
 * depend on `@lunora/do`, and both sides just need to agree on the wire
 * value the client already sends on its heartbeat).
 */
const WS_KEEPALIVE_PING = "lunora-ping";
/** Canned reply the runtime returns for {@link WS_KEEPALIVE_PING}; this class has no `webSocketMessage` handler at all, so before this auto-response existed the ping simply went unanswered. */
const WS_KEEPALIVE_PONG = "lunora-pong";

const HEADER_PREFIX = "id:";
const RETRY_PREFIX = "retry:";
const DEAD_PREFIX = "dead:";
const POOL_PREFIX = "pool:";
// Default page size for the `/list` + WS `jobs` view (listPage()) and the
// page size used internally by the exact-count cursor loop (forEachPage()).
// Mirrors the alarm path's existing `limit: 100` bound so the whole file has
// one bounded-page convention: every storage.list() here carries a limit.
const DEFAULT_LIST_LIMIT = 100;

/**
 * Retries allowed after the original attempt before {@link SchedulerDO.recordRetry}
 * parks a record in the dead-letter (`dead:`) prefix. Overridable per job via
 * {@link RetryPolicy.maxAttempts}. Exported so test doubles of the scheduler
 * (`@lunora/testing`'s fake scheduler) model the same budget instead of
 * duplicating the number.
 */
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Backoff before the first retry, in milliseconds; doubles on each subsequent
 * retry under the default `"exponential"` backoff (`baseMs * 2 ** (attempts - 1)`).
 * Overridable per job via {@link RetryPolicy.baseMs}. Exported alongside
 * {@link MAX_RETRY_ATTEMPTS} for the same reason.
 */
const RETRY_BASE_DELAY_MS = 30_000;
// When a pooled job can't run because its pool is at `maxConcurrency`, it is
// re-armed this far in the future so a later alarm drains it as slots free.
// Small enough to feel responsive, large enough to avoid a busy alarm loop.
const POOL_BACKPRESSURE_DELAY_MS = 1000;
// Largest accepted `scheduledFor`, in epoch milliseconds: the biggest value
// that still fits in TIME_PAD digits (999_999_999_999_999 = 1e15 - 1). Capping
// here — rather than at the 8.64e15 ECMAScript `Date` max — guarantees EVERY
// accepted value zero-pads to a uniform TIME_PAD width, so the time index's
// lexical order always matches numeric order. A larger (16-digit) cap would let
// a value like 1.5e15 sort BEFORE 2e14 and fire jobs wildly out of order;
// anything >= 1e21 would additionally switch `String()` to exponential notation
// and corrupt the index outright. ~year 33658, so no practical range is lost.
const MAX_SCHEDULED_FOR_MS = 999_999_999_999_999;
// Zero-padded to 15 digits so lexical order matches numeric order — see
// indexKey(). MAX_SCHEDULED_FOR_MS is capped to the largest 15-digit value so
// every accepted timestamp pads to exactly this width (never wider).
const TIME_PAD = 15;
const padTime = (n: number): string => String(n).padStart(TIME_PAD, "0");

/**
 * Can `value` be written into the `t:` time index at all? A positive integer no
 * greater than {@link MAX_SCHEDULED_FOR_MS} is exactly the range `padTime()`
 * renders as TIME_PAD digits, which is what makes the index's lexical order
 * match numeric order.
 *
 * Shared by BOTH writers of the index — {@link SchedulerDO.handleSchedule},
 * which rejects an out-of-range request, and {@link SchedulerDO.recordRetry},
 * which dead-letters an out-of-range retry. A retry ladder is every bit as
 * capable of producing an unindexable time as an untrusted caller is
 * (`{ retry: { maxAttempts: 60 } }` runs the default 30s base past the cap after
 * ~36 doublings), and a value that lands outside this range does not merely
 * mis-sort: a 16-digit key sorts above every `end` bound `alarm()` computes, so
 * the job is never listed, dispatched or dead-lettered again, and a value at or
 * above 1e21 renders as `'8.6e+21'`, which `Number.parseInt()` in
 * {@link SchedulerDO.rescheduleAlarm} reads back as `8` — arming the alarm at a
 * permanently past instant that the runtime then re-delivers in a tight loop.
 */
const isIndexableTime = (value: number): boolean => Number.isInteger(value) && value > 0 && value <= MAX_SCHEDULED_FOR_MS;

interface ScheduleRequestBody {
    args: Record<string, unknown>;

    /**
     * The `ns:fn` path of the function to dispatch on fire. Absent when the job
     * targets a durable workflow/agent instead — see
     * {@link ScheduleRequestBody.workflow}. Exactly one of the two is set.
     */
    functionPath?: string;

    /**
     * Job id chosen by the caller instead of minted here. Set by
     * `@lunora/server`'s deferred-schedule facade, which has to hand a mutation
     * handler the id synchronously while holding the call back until the
     * transaction commits. Ignored unless it is a safe key segment (see `resolveScheduleId`)
     * — the id becomes part of two storage keys, so a value carrying a `:` would
     * corrupt the time index.
     */
    id?: string;

    /**
     * The scheduler/workpool instance name the enqueuing client routed to
     * (`createWorkpool({ instanceName })`). Echoed in the dispatch payload so the
     * runtime can call back the SAME DO instance's `/complete` to release a
     * pooled job's slot. Defaults to `"default"`.
     */
    instanceName?: string;

    /**
     * Workpool concurrency cap, sent alongside `pool` by `Workpool.enqueue`.
     * Persisted on the pool's `pool:<name>` storage row so the alarm-time
     * concurrency gate has a value even if the in-memory client is gone.
     */
    maxConcurrency?: number;

    /**
     * Legacy field accepted but ignored: dispatch always uses
     * `env.LUNORA_ORIGIN_URL`. Kept on the wire so older `@lunora/scheduler`
     * clients can still talk to this DO.
     */
    originUrl?: string;
    /** Logical workpool name; gates dispatch behind {@link ScheduleRequestBody.maxConcurrency}. */
    pool?: string;
    /** Per-job retry policy; overrides the DO's built-in defaults when present. */
    retry?: RetryPolicy;
    scheduledFor: number;
    shardKey?: string;

    /**
     * The `WORKFLOW_*`/`AGENT_*` binding name to start a fresh durable instance
     * of on fire (the {@link ScheduleRequestBody.args} become its `params`). Set
     * instead of {@link ScheduleRequestBody.functionPath} when the job targets a
     * workflow/agent. Passed straight through to the dispatch payload so the
     * runtime — which owns the binding — can `create()` the instance.
     */
    workflow?: string;
}

/** Durable per-pool state stored under `pool:<name>`. */
interface PoolState {
    /** Jobs currently dispatched-but-not-yet-completed. The concurrency semaphore. */
    inFlight: number;

    /**
     * Ids of the jobs that currently hold a slot (dispatched, awaiting
     * `/complete`). Used to make slot release idempotent per job: a duplicate
     * `/complete` (the dispatch/completion callback is at-least-once) for an id
     * that no longer holds a slot is a no-op, so it can never over-release and
     * oversubscribe the pool past `maxConcurrency`. `inFlight` is kept equal to
     * `inFlightIds.length`; older rows without the field degrade gracefully
     * (release falls back to the clamped counter decrement).
     */
    inFlightIds?: string[];
    maxConcurrency: number;
}

/**
 * One pool's live backlog, as surfaced by `GET /status`. `inFlight`/
 * `maxConcurrency` mirror the durable {@link PoolState} semaphore; `queued`
 * is the number of pending (not-yet-dispatched) jobs routed to this pool.
 */
interface SchedulerPoolStatus {
    /** Jobs currently dispatched-but-not-yet-completed (the held slots). */
    inFlight: number;
    /** The pool's concurrency cap. */
    maxConcurrency: number;
    /** The logical workpool name (the `pool:<name>` suffix). */
    name: string;
    /** Pending jobs routed to this pool but not yet dispatched. */
    queued: number;
}

/**
 * App-level scheduler backlog, as returned by `GET /status`. `pools` carries
 * the per-pool breakdown; `backlog` and `inFlight` are the app-wide sums of
 * `queued` and `inFlight` across every pool — the SLO view's headline numbers.
 */
interface SchedulerStatus {
    /** Sum of every pool's `queued` count — the total pending backlog. */
    backlog: number;
    /** Sum of every pool's `inFlight` count — the total held concurrency slots. */
    inFlight: number;
    /** Per-pool backlog breakdown, one entry per `pool:<name>` record. */
    pools: SchedulerPoolStatus[];
}

interface CancelRequestBody {
    id: string;
}

/**
 * Durable Object that stores pending scheduled invocations sorted by their
 * `scheduledFor` time and fires them via HTTP on alarm. Storage layout:
 * `id:<id>` maps to {@link ScheduleRecord}; `t:<paddedTime>:<id>` maps to the
 * id (used as a sorted index).
 *
 * On every mutation the DO recomputes the earliest pending task and updates
 * the alarm via `state.storage.setAlarm(time)`.
 */
class SchedulerDO {
    private static indexKey(scheduledFor: number, id: string): string {
        // Zero-pad so the lexical order matches numerical order. Use the shared
        // padTime()/TIME_PAD so the pad width has a single source of truth and
        // can't drift from the rest of the module (alarm()/rescheduleAlarm()).
        return `t:${padTime(scheduledFor)}:${id}`;
    }

    private static json(body: unknown, status: number = 200): Response {
        return jsonResponse(body, status);
    }

    private static error(status: number, code: string, message: string): Response {
        return SchedulerDO.json({ error: { code, message } }, status);
    }

    /**
     * Resolve the effective retry parameters for a record: its per-job
     * {@link RetryPolicy} merged over the DO's built-in defaults. Callers that
     * never set `record.retry` get today's behaviour verbatim
     * (`maxAttempts: 5`, exponential, `baseMs: 30_000`, no ceiling).
     */
    private static resolveRetry(record: ScheduleRecord): { backoff: "exponential" | "linear"; baseMs: number; maxAttempts: number; maxMs?: number } {
        const policy = record.retry;
        const maxAttempts =
            typeof policy?.maxAttempts === "number" && Number.isInteger(policy.maxAttempts) && policy.maxAttempts > 0 ? policy.maxAttempts : MAX_RETRY_ATTEMPTS;
        const baseMs = typeof policy?.baseMs === "number" && Number.isFinite(policy.baseMs) && policy.baseMs >= 0 ? policy.baseMs : RETRY_BASE_DELAY_MS;
        const backoff = policy?.backoff === "linear" ? "linear" : "exponential";
        const maxMs = typeof policy?.maxMs === "number" && Number.isFinite(policy.maxMs) && policy.maxMs >= 0 ? policy.maxMs : undefined;

        return { backoff, baseMs, maxAttempts, maxMs };
    }

    /** Clamp an untrusted `maxConcurrency` to a positive integer, else fall back. */
    private static normalizeConcurrency(value: unknown, fallback: number): number {
        return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
    }

    /**
     * Sanitize an untrusted retry policy from the wire into a `RetryPolicy` (or
     * `undefined` when nothing valid was provided). Keeps obviously-bad values
     * out of storage so {@link SchedulerDO.resolveRetry} never has to re-guard.
     * @returns The normalized policy, or `undefined` if no valid policy was found.
     */
    private static normalizeRetry(value: unknown): RetryPolicy | undefined {
        if (typeof value !== "object" || value === null) {
            return undefined;
        }

        const raw = value as Record<string, unknown>;
        const policy: RetryPolicy = {};

        if (typeof raw.maxAttempts === "number" && Number.isInteger(raw.maxAttempts) && raw.maxAttempts > 0) {
            policy.maxAttempts = raw.maxAttempts;
        }

        if (typeof raw.baseMs === "number" && Number.isFinite(raw.baseMs) && raw.baseMs >= 0) {
            policy.baseMs = raw.baseMs;
        }

        if (raw.backoff === "exponential" || raw.backoff === "linear") {
            policy.backoff = raw.backoff;
        }

        if (typeof raw.maxMs === "number" && Number.isFinite(raw.maxMs) && raw.maxMs >= 0) {
            policy.maxMs = raw.maxMs;
        }

        return Object.keys(policy).length === 0 ? undefined : policy;
    }

    /**
     * Idempotently release the slot held by `jobId`, returning the updated
     * {@link PoolState} (pure — the caller persists it). A duplicate release for
     * an id that no longer holds a slot is a no-op, so an at-least-once
     * `/complete` (or a complete racing a failed-kick release) can never push
     * `inFlight` below the true number of running jobs and oversubscribe the
     * pool. Pools persisted before `inFlightIds` existed fall back to a clamped
     * counter decrement.
     */
    private static releaseSlot(pool: PoolState, jobId: string): PoolState {
        if (pool.inFlightIds === undefined) {
            // Legacy row (no id set): best-effort clamped decrement.
            return { ...pool, inFlight: Math.max(0, pool.inFlight - 1) };
        }

        const next = pool.inFlightIds.filter((id) => id !== jobId);

        return { ...pool, inFlight: next.length, inFlightIds: next };
    }

    /**
     * Best-effort release with no job id (legacy `/complete` payloads). Drops one
     * tracked id if the set exists, else clamps the counter. Less precise than
     * {@link SchedulerDO.releaseSlot} — a duplicate id-less complete CAN
     * over-release — but every current client sends the id, so this is the
     * compatibility shim, not the hot path.
     */
    private static releaseFirstSlot(pool: PoolState): PoolState {
        if (pool.inFlightIds === undefined) {
            return { ...pool, inFlight: Math.max(0, pool.inFlight - 1) };
        }

        const next = pool.inFlightIds.slice(0, Math.max(0, pool.inFlightIds.length - 1));

        return { ...pool, inFlight: next.length, inFlightIds: next };
    }

    /**
     * Normalize the mutually-exclusive dispatch target off an untrusted body: a
     * one-shot function path (`functionPath`) or a durable workflow/agent
     * instance (`workflow`, a `WORKFLOW_*`/`AGENT_*` binding). Returns `undefined`
     * when neither is present so the caller can reject the schedule.
     */
    private static resolveScheduleTarget(body: ScheduleRequestBody | undefined): { functionPath?: string; workflow?: string } | undefined {
        const functionPath = typeof body?.functionPath === "string" && body.functionPath.length > 0 ? body.functionPath : undefined;
        const workflow = typeof body?.workflow === "string" && body.workflow.length > 0 ? body.workflow : undefined;

        if (functionPath === undefined && workflow === undefined) {
            return undefined;
        }

        return { functionPath, workflow };
    }

    protected readonly state: SchedulerDOState;

    protected readonly env: SchedulerEnv;

    /**
     * Whether {@link SchedulerDO.reindexOrphanedRecords} has already run in THIS
     * instance. Once is enough: an orphan can only be minted by an eviction, and
     * an eviction ends the instance that minted it.
     */
    private reindexed = false;

    public constructor(state: SchedulerDOState, env: SchedulerEnv) {
        this.state = state;
        this.env = env;

        this.armWebSocketKeepalive();
    }

    public async fetch(request: Request): Promise<Response> {
        // An orphan is minted by a death DURING dispatch — after the claim
        // deleted the `t:` entry and before `rescheduleAlarm()` re-armed — so
        // the instance that comes back has no alarm left to recover from, and
        // recovering from `alarm()` alone would never run. Every route needs the
        // recovery anyway: `/list` and `/status` under-report an orphan, and
        // `armAlarmIfEarlier` on a fresh `/schedule` compares against a clock
        // derived from `t:` alone. Guarded by `reindexed`, so this is one boolean
        // read per request after the first.
        await this.reindexOrphanedRecords();

        const url = new URL(request.url);

        // `/ws` gates on the Upgrade header rather than the HTTP method, so it
        // stays a dedicated check; the rest dispatch on `${method} ${pathname}`.
        if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade();
        }

        switch (`${request.method} ${url.pathname}`) {
            case "GET /dead": {
                return this.handleDeadList(url);
            }
            case "GET /get": {
                return this.handleGet(url);
            }
            case "GET /list": {
                return this.handleList(url);
            }
            case "GET /pool": {
                return this.handlePoolStatus(url);
            }
            case "GET /status": {
                return this.handleStatus();
            }
            case "POST /cancel": {
                return this.handleCancel(request);
            }
            case "POST /complete": {
                return this.handleComplete(request);
            }
            case "POST /dead/cancel": {
                return this.handleDeadCancel(request);
            }
            case "POST /dead/retry": {
                return this.handleDeadRetry(request);
            }
            case "POST /schedule": {
                return this.handleSchedule(request);
            }
            default: {
                break;
            }
        }

        return jsonResponse({ error: { code: "NOT_FOUND" } }, 404);
    }

    /** Called by the Workers runtime when the alarm previously set by `_rescheduleAlarm()` fires. */
    public async alarm(): Promise<void> {
        // BEFORE the due slice is read, so a job recovered here fires in this
        // very pass rather than waiting for the next one.
        await this.reindexOrphanedRecords();

        const now = Date.now();
        const due: ScheduleRecord[] = [];

        // Pull only the prefix slice that's due. `~` sorts after all digits
        // in ASCII so it bounds the time-padded id portion. If the runtime
        // doesn't support `end`, the `limit` keeps the page bounded.
        const indexEntries = await this.state.storage.list<string>({
            end: `t:${padTime(now)}:~`,
            limit: 100,
            prefix: "t:",
        });

        /* eslint-disable no-await-in-loop -- sequential by design: a Durable Object's storage is single-threaded local state, and the claim-before-dispatch protocol below requires each job's index write to complete in order so an alarm re-fire can't double-dispatch. */
        for (const [indexKey, recordId] of indexEntries.entries()) {
            const dueAt = Number.parseInt(indexKey.slice(2, indexKey.indexOf(":", 2)), 10);

            if (Number.isFinite(dueAt) && dueAt <= now) {
                const record = await this.state.storage.get<ScheduleRecord>(`${HEADER_PREFIX}${recordId}`);

                if (record) {
                    due.push(record);
                } else {
                    // Dangling index entry: this `t:` row points at an `id:`
                    // header that no longer exists (e.g. a partial-failure path
                    // left the index at a stale time while the header moved on,
                    // then the job later dispatched and cleared its header).
                    // Delete the orphan now — otherwise rescheduleAlarm() keeps
                    // arming the alarm to this past time, which fires, finds no
                    // record, re-arms to the same past time, and busy-loops
                    // forever, burning DO duty cycles.
                    await this.state.storage.delete(indexKey);
                }
            }
        }

        // Per-pool concurrency is gated by the durable `pool:<name>` row, which
        // reservePoolSlot() reads FRESH from storage for every record. We
        // deliberately do NOT cache pool state across the drain: dispatch()
        // awaits an outbound fetch, during which the DO input gate is open and a
        // concurrent /complete can decrement the pool row. A stale cached copy
        // written back afterwards would resurrect the completed job's slot and
        // leak pool capacity forever (there is no lease timeout to reclaim it).
        try {
            for (const record of due) {
                // Per-record isolation: a storage throw for one record must NOT
                // abort the whole pass (it would skip the other due records AND
                // the rescheduleAlarm() in the finally, losing the clock).
                await this.drainRecordGuarded(record);
            }
        } finally {
            // Always re-arm the clock, even if a record threw above — otherwise a
            // single failing record could leave the DO with no future alarm and
            // strand every still-pending job.
            await this.rescheduleAlarm();
        }
        /* eslint-enable no-await-in-loop */

        // Jobs fired (and were removed or moved to retry), so push the new list
        // to live subscribers — this is the moment a studio wants to see.
        if (due.length > 0) {
            await this.broadcastChange();
        }
    }

    /**
     * Internal dispatch hook; overridden in unit tests to capture the outgoing
     * request. Returns `true` ONLY on an explicit 2xx response (`response.ok`).
     * Anything else — a network failure, a 5xx, OR a non-2xx such as 404
     * (receiver route not mounted) / 401 / 403 / 4xx — returns `false` and
     * enters the retry pipeline via {@link recordRetry}. Treating 4xx as
     * success used to permanently delete the job; since the receiver may simply
     * be missing (404) or transiently failing, we retry rather than silently
     * drop. After {@link MAX_RETRY_ATTEMPTS} the record is parked under a
     * `dead:` key for inspection — never silently deleted.
     *
     * The dispatch target is taken from `env.LUNORA_ORIGIN_URL` (NOT from the
     * stored record) to prevent SSRF via a forged `originUrl` on the schedule
     * request. If that env var is missing at fire time (a deploy/binding
     * regression — schedule time already enforced its presence) we return
     * `false` so the record is retried rather than silently dropped.
     */
    protected async dispatch(record: ScheduleRecord): Promise<boolean> {
        const originUrl = typeof this.env.LUNORA_ORIGIN_URL === "string" && this.env.LUNORA_ORIGIN_URL.length > 0 ? this.env.LUNORA_ORIGIN_URL : undefined;

        if (!originUrl) {
            // The origin was configured at schedule time (handleSchedule()
            // refuses to enqueue without it) but is now missing — a deploy or
            // binding regression. Treat it as a transient failure (return
            // false) so alarm() routes the record through recordRetry() and
            // preserves it for a later fire, rather than deleting an unfired
            // job as if it had succeeded.
            return false;
        }

        const body = JSON.stringify({
            args: record.args,
            functionPath: record.functionPath,
            id: record.id,
            // Echoed so the receiver can call back the SAME DO instance.
            instanceName: record.instanceName,
            // When the job belongs to a workpool, the receiver must report
            // completion back to the SchedulerDO (`POST /complete { pool, id }`)
            // so the pool's concurrency slot is released — see handleComplete().
            pool: record.pool,
            scheduledFor: record.scheduledFor,
            shardKey: record.shardKey,
            // Present instead of `functionPath` for a workflow/agent target; the
            // runtime starts a fresh instance of this binding. `undefined` when
            // absent, so JSON.stringify drops it and the payload is unchanged for
            // ordinary function dispatches.
            workflow: record.workflow,
        });

        try {
            const headers: Record<string, string> = { "content-type": "application/json" };

            // Authenticate the dispatch so the receiver route can reject anonymous
            // callers (an unauthenticated receiver would execute arbitrary
            // functions for anyone who can reach the origin). We HMAC-sign the
            // exact JSON body with a shared secret and send it as a header; the
            // runtime-side receiver re-derives the HMAC and compares.
            //
            // Env vars (read at fire time, never from the request body):
            //   LUNORA_SCHEDULER_SECRET — shared HMAC secret. Preferred.
            //   LUNORA_ADMIN_TOKEN      — fallback bearer if no HMAC secret is set.
            // With neither configured the body is sent unsigned (current behaviour);
            // the receiver should then refuse to run in that posture.
            //
            // Computed inside the try so a crypto.subtle failure routes to retry
            // (return false) instead of throwing out of dispatch() — a throw would
            // escape drainRecord()/alarm() and orphan the job (its time-index entry
            // is already claimed/deleted by alarm() before dispatch runs, so an
            // un-retried throw leaves a header with no index that can never re-fire).
            const signature = await this.signDispatch(body);

            if (signature !== undefined) {
                headers["x-lunora-scheduler-signature"] = signature;
            } else if (typeof this.env.LUNORA_ADMIN_TOKEN === "string" && this.env.LUNORA_ADMIN_TOKEN.length > 0) {
                headers.authorization = `Bearer ${this.env.LUNORA_ADMIN_TOKEN}`;
            }

            const response = await fetch(`${originUrl}/_lunora/scheduler/dispatch`, {
                body,
                headers,
                method: "POST",
            });

            // Success is an explicit 2xx only. A 404 (receiver route missing),
            // any other 4xx, or a 5xx is NOT treated as done — the caller
            // (alarm()) keeps the record and routes it through recordRetry()
            // rather than deleting it. Idempotent dispatch keyed by record id
            // makes a re-fire safe: the receiver spends `id` as the shard's
            // replay-dedup `mutationId` for a function target and as the
            // WORKFLOW INSTANCE id for a `workflow` target, so neither runs
            // twice.
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Register the hibernation-safe ping/pong keepalive. The runtime answers a
     * {@link WS_KEEPALIVE_PING} text frame with {@link WS_KEEPALIVE_PONG}
     * WITHOUT waking this Durable Object, keeping an idle `/ws` subscription
     * alive across hibernation with no billable wakeup and no dispatch. Without
     * this, a client's heartbeat ping goes unanswered and its watchdog force-
     * closes the socket every ~90s, defeating hibernation (each unanswered ping
     * wakes the DO to reconnect) — mirrors `@lunora/do`'s
     * `ShardDO.armWebSocketKeepalive`. The auto-response is per-instance, so
     * this re-runs on every construction (including a post-hibernation wake).
     * Guarded: the API and the `WebSocketRequestResponsePair` global are absent
     * in the unit harness and on older runtimes, where it degrades to a no-op.
     */
    private armWebSocketKeepalive(): void {
        const setter = this.state.setWebSocketAutoResponse;

        if (typeof setter !== "function" || typeof WebSocketRequestResponsePair === "undefined") {
            return;
        }

        setter.call(this.state, new WebSocketRequestResponsePair(WS_KEEPALIVE_PING, WS_KEEPALIVE_PONG));
    }

    /**
     * Claim + drain one due record with per-record fault isolation, so a storage
     * throw can never abort the whole alarm pass (which would skip the remaining
     * due records and the `rescheduleAlarm()` that re-arms the clock).
     *
     * Claims the job by deleting its time-index entry BEFORE dispatch (an alarm
     * re-fire then won't pick it up again), runs {@link drainRecord}, and on a
     * thrown storage op re-asserts the claim so the job stays re-fireable.
     *
     * A throw reaching here always means the job was NOT dispatched:
     * {@link drainRecord} swallows its own post-dispatch cleanup errors and
     * returns instead of throwing once a kick succeeds, so every escaping throw
     * comes from the pre-dispatch or failed-dispatch paths. We therefore re-assert
     * the time-index claim so a later alarm re-attempts it (at-least-once): the
     * claim delete may have removed it and recordRetry()/requeuePooled() may not
     * have re-armed it before throwing, and re-inserting the same key is
     * idempotent, so a surviving claim is simply rewritten to its prior value.
     *
     * With one exception, checked first: a record that already has a durable
     * `dead:` row is TERMINAL, and re-claiming it would re-dispatch a job the
     * dead-letter says is finished. See the comment on that branch.
     */
    private async drainRecordGuarded(record: ScheduleRecord): Promise<void> {
        try {
            await this.state.storage.delete(SchedulerDO.indexKey(record.scheduledFor, record.id));
            await this.drainRecord(record);
        } catch {
            try {
                // `parkDead` writes `dead:<id>` and THEN clears the pending rows.
                // If that clear is what threw, the park is already durable and
                // re-asserting the claim would dispatch a job that has a terminal
                // dead-letter record — a duplicate run of a workflow or any other
                // non-idempotent job, which at-least-once does not license. Finish
                // the park's cleanup instead; the delete is idempotent, so a later
                // pass retries it if this one throws too.
                if ((await this.state.storage.get(`${DEAD_PREFIX}${record.id}`)) !== undefined) {
                    await this.state.storage.delete([`${RETRY_PREFIX}${record.id}`, `${HEADER_PREFIX}${record.id}`]);

                    return;
                }

                await this.state.storage.put(SchedulerDO.indexKey(record.scheduledFor, record.id), record.id);
            } catch {
                // The infra is failing hard enough that even the re-claim put
                // throws. Swallow so the remaining due records still drain and
                // rescheduleAlarm() still runs; the surviving `id:`/`retry:`
                // rows keep the job recoverable on a later pass.
            }
        }
    }

    /**
     * Process one due (already index-claimed) record within an alarm drain:
     * apply the workpool concurrency gate, dispatch, and settle the result.
     * A saturated pool re-arms the job (backpressure, no attempt charged); a
     * free slot is reserved durably before dispatch and released immediately if
     * the kick fails (success holds it until the runtime reports completion).
     * Success clears the `id:`/`retry:` rows; failure routes to
     * {@link recordRetry}. Pool state is read FRESH from storage per record (see
     * {@link reservePoolSlot}) and never held across the dispatch() await, so a
     * concurrent /complete landing mid-dispatch can't be clobbered.
     * Once a kick succeeds, post-dispatch cleanup (clearing the `id:`/`retry:`
     * rows) is swallowed rather than allowed to throw, so a successful dispatch
     * NEVER propagates an error to {@link drainRecordGuarded}: every throw that
     * escapes comes from the pre-dispatch or failed-dispatch paths, where the job
     * is still re-fireable and the guard safely re-claims the time index.
     * @returns `true` only when the record was successfully dispatched (a 2xx
     * kick); `false` on pool backpressure or a failed dispatch (the job is still
     * re-fireable — already re-armed here). The value is informational (the guard
     * branches on throw/no-throw, not on this boolean).
     */
    private async drainRecord(record: ScheduleRecord): Promise<boolean> {
        const reserved = await this.reservePoolSlot(record);

        if (!reserved) {
            // Pool at capacity — re-armed by reservePoolSlot(); skip dispatch.
            return false;
        }

        const ok = await this.dispatch(record);

        if (!ok && record.pool !== undefined) {
            // The kick itself failed: no completion callback is coming, so free
            // the reserved slot immediately. recordRetry() then re-arms the job.
            // Re-load the pool row FRESH from storage rather than reusing a copy
            // held from before the dispatch() fetch await: a concurrent
            // /complete may have decremented the row during that await, and
            // releasing against a stale copy would clobber that decrement and
            // oversubscribe the pool. Release by id so a later (spurious)
            // /complete for the same job can't double-free either.
            const pool = await this.loadPool(record.pool);
            const released = SchedulerDO.releaseSlot(pool, record.id);

            await this.savePool(record.pool, released);
        }

        if (ok) {
            // The job was kicked (2xx). It must never re-fire, so the time-index
            // claim stays deleted regardless of what happens next. Clear the
            // header + retry rows in one batched delete; if THAT throws (a
            // transient storage blip), the only fallout is a lingering `id:` row
            // — harmless and idempotent to re-clear on a later pass. Swallow it
            // so the caller never re-claims the index and double-dispatches an
            // already-run job.
            try {
                await this.state.storage.delete([`${HEADER_PREFIX}${record.id}`, `${RETRY_PREFIX}${record.id}`]);
            } catch {
                /* lingering header only — never re-fire a dispatched job */
            }

            return true;
        }

        // Dispatch failed (or the pool kick was released): re-arm for retry. A
        // throw here propagates to the caller, which re-claims the time index so
        // the job stays re-fireable (at-least-once).
        await this.recordRetry(record);

        return false;
    }

    /**
     * Concurrency gate for a pooled record. Returns `false` (and re-arms the
     * job via {@link requeuePooled}) when the pool is at `maxConcurrency`;
     * otherwise reserves a slot durably and returns `true`. Non-pooled records
     * always return `true` without touching any pool state.
     *
     * The pool row is read FRESH from storage on every call — never cached
     * across the drain. Each reservation durably `savePool()`s before the next
     * record runs, so a same-pass reservation is still visible to the next
     * record's fresh read (the budget carries forward); and because dispatch()
     * awaits an outbound fetch between records, a concurrent /complete that
     * decrements the row mid-drain IS reflected here instead of being clobbered
     * by a stale in-memory copy (which would leak a slot permanently).
     */
    private async reservePoolSlot(record: ScheduleRecord): Promise<boolean> {
        if (record.pool === undefined) {
            return true;
        }

        const pool = await this.loadPool(record.pool);

        if (pool.inFlight >= pool.maxConcurrency) {
            await this.requeuePooled(record);

            return false;
        }

        // Reserve a slot durably BEFORE dispatching so neither a concurrent
        // alarm nor this same pass can oversubscribe the pool. Track the holding
        // job id so the eventual release (success → /complete, failed kick →
        // drainRecord) is idempotent per job and can't over-release.
        const ids: string[] = pool.inFlightIds ?? [];

        if (!ids.includes(record.id)) {
            ids.push(record.id);
        }

        pool.inFlightIds = ids;
        pool.inFlight = ids.length;
        await this.savePool(record.pool, pool);

        return true;
    }

    /**
     * Accept a hibernatable live subscription to the job list. The scheduler has
     * exactly one subscription shape (the whole list), so there's no per-socket
     * registry or dependency tracking — every accepted socket gets the full list
     * on connect and on every change. The worker is responsible for gating the
     * upgrade behind the admin token before it reaches here.
     */
    private async handleWebSocketUpgrade(): Promise<Response> {
        if (this.state.acceptWebSocket === undefined) {
            return SchedulerDO.error(501, "WS_UNSUPPORTED", "WebSocket subscriptions are not supported in this runtime");
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        this.state.acceptWebSocket(server);
        // Seed the new subscriber with the current (bounded) list so its first
        // value arrives over the same channel as later changes, in the same
        // `{ records, truncated }` shape `broadcastChange()` and `/list` use.
        const seed = await this.listPage(HEADER_PREFIX, DEFAULT_LIST_LIMIT);

        server.send(JSON.stringify({ records: seed.records, truncated: seed.truncated, type: "jobs" }));

        // eslint-disable-next-line unicorn/no-null -- a 101 WebSocket-upgrade Response must have a null body
        return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * Re-list the jobs (bounded — see {@link listPage}) and push them to
     * every connected subscriber. Called after any change (schedule / cancel /
     * alarm-fire) so live studios reflect it immediately. A no-op when the
     * runtime doesn't support hibernated sockets.
     */
    private async broadcastChange(): Promise<void> {
        const sockets = this.state.getWebSockets?.();

        if (sockets === undefined || sockets.length === 0) {
            return;
        }

        const { records, truncated } = await this.listPage(HEADER_PREFIX, DEFAULT_LIST_LIMIT);
        const message = JSON.stringify({ records, truncated, type: "jobs" });

        for (const socket of sockets) {
            try {
                socket.send(message);
            } catch {
                /* a closing socket — the runtime will clean it up on close */
            }
        }
    }

    /**
     * One bounded page of the rows under `prefix`, in key order, plus the
     * `cursor` a caller resumes from (the last key of the page) when `truncated`.
     * Lists `limit + 1` and slices back down so both facts are known without a
     * second round-trip.
     *
     * Shared by `/list` (pending headers) and `/dead` (dead-letter records) so
     * NEITHER can materialize an unbounded set into one JSON response: nothing
     * prunes `dead:`, so a workpool with a broken origin parks thousands of rows
     * and the studio's only view of them — and only way to requeue them — would
     * fail exactly when it is needed.
     */
    private async listPage(prefix: string, limit: number, startAfter?: string): Promise<{ cursor?: string; records: ScheduleRecord[]; truncated: boolean }> {
        const entries = await this.state.storage.list<ScheduleRecord>({
            limit: limit + 1,
            prefix,
            ...(startAfter === undefined ? {} : { startAfter }),
        });
        const keys = [...entries.keys()];
        const records = [...entries.values()];
        const truncated = records.length > limit;

        if (!truncated) {
            return { records, truncated };
        }

        return { cursor: keys[limit - 1], records: records.slice(0, limit), truncated };
    }

    /**
     * Page through every row under `prefix` exactly once with bounded per-page
     * memory (a `limit`+`startAfter` cursor loop), invoking `visit` for each.
     * Unlike {@link listPage}, which intentionally truncates for the studio's
     * live view, `/status` and `/pool` need EXACT counts — this walks the full
     * set, but never materializes more than one page at a time.
     */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T types the stored rows for the caller and is forwarded to `storage.list`; without it every visitor casts.
    private async forEachPage<T>(prefix: string, visit: (value: T, key: string) => void, pageSize: number = DEFAULT_LIST_LIMIT): Promise<void> {
        let startAfter: string | undefined;

        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- each page's cursor (startAfter) depends on the previous page's last key, so the pages are inherently sequential
            const page = await this.state.storage.list<T>(startAfter === undefined ? { limit: pageSize, prefix } : { limit: pageSize, prefix, startAfter });

            if (page.size === 0) {
                break;
            }

            for (const [key, value] of page.entries()) {
                visit(value, key);
            }

            const keys = [...page.keys()];

            startAfter = keys.at(-1);

            if (page.size < pageSize) {
                break;
            }
        }
    }

    /**
     * HMAC-SHA-256 sign the dispatch body with `env.LUNORA_SCHEDULER_SECRET`,
     * returning a base64url signature, or `undefined` when no secret is
     * configured. Mirrors `@lunora/storage`'s signed-URL HMAC pattern (WebCrypto
     * `crypto.subtle`, available in workerd).
     */
    private async signDispatch(body: string): Promise<string | undefined> {
        const secret = typeof this.env.LUNORA_SCHEDULER_SECRET === "string" ? this.env.LUNORA_SCHEDULER_SECRET : undefined;

        if (!secret || secret.length === 0) {
            return undefined;
        }

        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
        const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));

        return toBase64Url(new Uint8Array(signature));
    }

    /**
     * Move a failed record into the retry pipeline with configurable backoff.
     * The retry budget/backoff comes from the record's {@link RetryPolicy}
     * (falling back to the DO defaults); on exhaustion the record is parked
     * under a `dead:` key for manual inspection.
     */
    private async recordRetry(record: ScheduleRecord): Promise<void> {
        const attempts = (record.attempts ?? 0) + 1;
        const { backoff, baseMs, maxAttempts, maxMs } = SchedulerDO.resolveRetry(record);
        const rawDelay = backoff === "linear" ? baseMs * attempts : baseMs * 2 ** (attempts - 1);
        const delayMs = maxMs === undefined ? rawDelay : Math.min(rawDelay, maxMs);
        // Round: `baseMs`/`maxMs` are only validated as finite and non-negative,
        // so a fractional one (0.5) yields a fractional instant whose `String()`
        // carries a '.' and therefore does NOT pad to TIME_PAD digits — the key
        // then sorts outside alarm()'s end bound and the job is stranded from the
        // very first retry.
        const nextScheduledFor = Math.round(Date.now() + delayMs);

        if (attempts > maxAttempts) {
            await this.parkDead(record, attempts, `after ${String(attempts)} attempts`);

            return;
        }

        if (!isIndexableTime(nextScheduledFor)) {
            // The backoff ladder ran past the largest instant the `t:` index can
            // represent (see isIndexableTime). Writing the key anyway is strictly
            // worse than parking: the job would be invisible to every later alarm
            // AND could pin the alarm in the past. A retry that cannot be
            // scheduled is a job that will never run, and the dead-letter is
            // exactly the surface for that — `/dead/retry` re-arms it for now,
            // which is the only sane recovery anyway.
            await this.parkDead(record, attempts, `at attempt ${String(attempts)}: the retry backoff exceeded the largest schedulable time`);

            return;
        }

        const retryRecord: ScheduleRecord = {
            ...record,
            attempts,
            scheduledFor: nextScheduledFor,
        };

        await this.state.storage.put(`${RETRY_PREFIX}${record.id}`, retryRecord);
        // Re-arm via the standard time index so the alarm fires at the right moment.
        await this.state.storage.put(`${HEADER_PREFIX}${record.id}`, retryRecord);
        await this.state.storage.put(SchedulerDO.indexKey(nextScheduledFor, record.id), record.id);
    }

    /**
     * Terminal park into the dead-letter (`dead:`) prefix, with `reason` naming
     * why in the emitted warning. Shared by the two ways a retry ends for good:
     * an exhausted attempt budget, and a backoff that ran past the largest
     * schedulable time (see {@link isIndexableTime}).
     */
    private async parkDead(record: ScheduleRecord, attempts: number, reason: string): Promise<void> {
        await this.state.storage.put(`${DEAD_PREFIX}${record.id}`, { ...record, attempts });
        // Park is terminal; clear the pending retry row AND the live header row
        // in one batched delete. Leaving `id:<id>` behind would keep the dead job
        // visible in `/list` (and the studio) as a scheduled job
        // that can never fire — only the `dead:` record should survive.
        await this.state.storage.delete([`${RETRY_PREFIX}${record.id}`, `${HEADER_PREFIX}${record.id}`]);

        // eslint-disable-next-line no-console -- no logger is injected into SchedulerDO; emit via console so the host captures dead-letter parks
        console.warn(`@lunora/scheduler: job "${record.id}" (${record.functionPath ?? record.workflow ?? "unknown"}) parked in dead-letter ${reason}`);
    }

    /** Read the durable `pool:<name>` row, defaulting to a fresh `inFlight: 0` pool. */
    private async loadPool(name: string, maxConcurrencyHint?: number): Promise<PoolState> {
        const stored = await this.state.storage.get<PoolState>(`${POOL_PREFIX}${name}`);

        if (stored !== undefined) {
            // When the id set is present it is authoritative for the in-flight
            // count; otherwise (legacy row) fall back to the clamped counter.
            if (Array.isArray(stored.inFlightIds)) {
                return { inFlight: stored.inFlightIds.length, inFlightIds: [...stored.inFlightIds], maxConcurrency: stored.maxConcurrency };
            }

            return { inFlight: Math.max(0, stored.inFlight), maxConcurrency: stored.maxConcurrency };
        }

        return { inFlight: 0, inFlightIds: [], maxConcurrency: SchedulerDO.normalizeConcurrency(maxConcurrencyHint, 1) };
    }

    private async savePool(name: string, pool: PoolState): Promise<void> {
        await this.state.storage.put(`${POOL_PREFIX}${name}`, pool);
    }

    /**
     * Re-arm a pooled job that couldn't run because its pool was at capacity.
     * No attempt is charged (this is backpressure, not a failure): the job is
     * pushed `POOL_BACKPRESSURE_DELAY_MS` into the future so a later alarm
     * drains it once a slot frees, keeping its `id:` header and retry policy.
     */
    private async requeuePooled(record: ScheduleRecord): Promise<void> {
        const nextScheduledFor = Date.now() + POOL_BACKPRESSURE_DELAY_MS;
        const requeued: ScheduleRecord = { ...record, scheduledFor: nextScheduledFor };

        await this.state.storage.put(`${HEADER_PREFIX}${record.id}`, requeued);
        await this.state.storage.put(SchedulerDO.indexKey(nextScheduledFor, record.id), record.id);
    }

    /**
     * Release a pool slot when the runtime reports an action finished. This is
     * the durable-semaphore decrement: dispatch() only KICKS the action and
     * holds the slot; the runtime calls back here (`POST /complete { id }`) once
     * the action settles, freeing the slot for the next queued job. Idempotent
     * and safe if the job/pool is already gone.
     */
    private async handleComplete(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => undefined)) as { id?: string; pool?: string } | undefined;
        const poolName = typeof body?.pool === "string" && body.pool.length > 0 ? body.pool : undefined;
        const jobId = typeof body?.id === "string" && body.id.length > 0 ? body.id : undefined;

        if (poolName === undefined) {
            return SchedulerDO.error(400, "INVALID_INPUT", "pool is required");
        }

        const pool = await this.loadPool(poolName);

        // Release by job id so an at-least-once /complete (the runtime may
        // re-deliver the completion callback) is idempotent and can't free a
        // slot belonging to a different in-flight job. Without an id we fall
        // back to a best-effort decrement (legacy clients / runtimes).
        const next = jobId === undefined ? SchedulerDO.releaseFirstSlot(pool) : SchedulerDO.releaseSlot(pool, jobId);

        await this.savePool(poolName, next);

        // A freed slot means a queued job can now run; pull the alarm forward so
        // the drain happens promptly instead of waiting for the backpressure tick.
        await this.armAlarmIfEarlier(Date.now());

        return SchedulerDO.json({ inFlight: next.inFlight });
    }

    /** `GET /pool?name=` — inspect a pool's slot usage + queued count. */
    private async handlePoolStatus(url: URL): Promise<Response> {
        const name = url.searchParams.get("name");

        if (name === null || name.length === 0) {
            return SchedulerDO.error(400, "INVALID_INPUT", "name is required");
        }

        const pool = await this.loadPool(name);
        let queued = 0;

        // Exact count via a bounded cursor loop — never materializes the whole
        // header set at once (see forEachPage()).
        await this.forEachPage<ScheduleRecord>(HEADER_PREFIX, (record) => {
            if (record.pool === name) {
                queued += 1;
            }
        });

        return SchedulerDO.json({ inFlight: pool.inFlight, maxConcurrency: pool.maxConcurrency, queued });
    }

    /**
     * `GET /status` — the app-level backlog signal that powers the studio's
     * SLO view. Enumerates every durable `pool:<name>` row for its `inFlight`/
     * `maxConcurrency` semaphore, counts the pending (not-yet-dispatched) jobs
     * routed to each pool with the same single-pass scan {@link handlePoolStatus}
     * uses, and rolls those up into app-wide `backlog` (sum of `queued`) and
     * `inFlight` (sum of held slots) totals.
     *
     * Pools that have rows but no queued jobs still appear (with `queued: 0`) so
     * a saturated-but-idle pool stays visible; a pool that only ever existed as
     * queued jobs without a persisted row is unreachable here (the schedule path
     * always writes a `pool:<name>` row before the job's header), so a single
     * scan over `pool:` plus a cursor loop over `id:` is sufficient.
     */
    private async handleStatus(): Promise<Response> {
        // Count pending jobs per pool name in a single pass over the headers,
        // exactly as handlePoolStatus() counts for one pool.
        const queuedByPool = new Map<string, number>();

        await this.forEachPage<ScheduleRecord>(HEADER_PREFIX, (record) => {
            if (record.pool !== undefined) {
                queuedByPool.set(record.pool, (queuedByPool.get(record.pool) ?? 0) + 1);
            }
        });

        const pools: SchedulerPoolStatus[] = [];
        let backlog = 0;
        let inFlight = 0;

        // Pool rows go through the SAME bounded cursor loop as the headers. One
        // row per pool name is small in every app anyone has written, but the
        // names come from user code and nothing caps how many there are, so this
        // file has exactly one convention and no unlimited list() left in it.
        await this.forEachPage<PoolState>(POOL_PREFIX, (pool, key) => {
            const name = key.slice(POOL_PREFIX.length);
            // Defend against a corrupted row (`inFlight` should never go negative)
            // exactly as loadPool() does on the alarm path.
            const slots = Math.max(0, pool.inFlight);
            const queued = queuedByPool.get(name) ?? 0;

            pools.push({ inFlight: slots, maxConcurrency: pool.maxConcurrency, name, queued });
            backlog += queued;
            inFlight += slots;
        });

        const status: SchedulerStatus = { backlog, inFlight, pools };

        return SchedulerDO.json(status);
    }

    /**
     * Persist (or refresh) a pool's concurrency cap, so the alarm-time gate has
     * a durable `maxConcurrency` even after the enqueuing client is gone.
     */
    private async persistPoolCap(pool: string, requestedMaxConcurrency: number | undefined): Promise<void> {
        const current = await this.loadPool(pool, requestedMaxConcurrency);

        await this.savePool(pool, {
            inFlight: current.inFlight,
            // Preserve the in-flight id set so refreshing the cap on a new
            // enqueue can't wipe the held-slot bookkeeping (which would let a
            // later /complete over-release).
            ...(current.inFlightIds === undefined ? {} : { inFlightIds: current.inFlightIds }),
            maxConcurrency: SchedulerDO.normalizeConcurrency(requestedMaxConcurrency, current.maxConcurrency),
        });
    }

    /**
     * The `409` a caller-supplied id earns when something durable already holds
     * it, or `undefined` when the id is free.
     *
     * A pending header is the obvious half: `put` on `id:<id>` overwrites, but
     * the `t:` index is keyed by TIME as well as id, so the OLD entry survives.
     * The drain then dispatches the NEW record at the OLD time and deletes the
     * entry it should have fired at — the job runs early and never runs again.
     * Refused rather than made a replace: `RunOptions.id` exists so a deferred
     * schedule can name its own job, and silently retiming someone else's is the
     * worse failure.
     *
     * The `dead:` row holds the id too, and for a worse reason. A dead record
     * keeps NO `id:` header, so a pending-only check leaves the id apparently
     * free — and a later `/dead/retry` writes the revived corpse straight over
     * the new job's header and adds a SECOND time index under the same id. The
     * new job is gone and the dead one fires in its place. Recovering a dead job
     * is an operator action taken minutes or days after the schedule, so nothing
     * at schedule time would ever have surfaced the collision.
     */
    private async idConflict(id: string): Promise<Response | undefined> {
        if ((await this.state.storage.get<ScheduleRecord>(`${HEADER_PREFIX}${id}`)) !== undefined) {
            return SchedulerDO.error(
                409,
                "DUPLICATE_SCHEDULE_ID",
                `a job with id "${id}" is already scheduled — cancel it first, or schedule under a different id`,
            );
        }

        if ((await this.state.storage.get<ScheduleRecord>(`${DEAD_PREFIX}${id}`)) !== undefined) {
            return SchedulerDO.error(
                409,
                "DUPLICATE_SCHEDULE_ID",
                `id "${id}" is held by a dead-letter record — retry or cancel it (POST /dead/retry, POST /dead/cancel) first, or schedule under a different id`,
            );
        }

        return undefined;
    }

    private async handleSchedule(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => undefined)) as ScheduleRequestBody | undefined;
        const target = SchedulerDO.resolveScheduleTarget(body);

        if (!body || target === undefined) {
            return SchedulerDO.error(400, "INVALID_INPUT", "functionPath or workflow is required");
        }

        const { functionPath, workflow } = target;

        // Reject NaN, +/-Infinity and non-positive timestamps. A finite
        // positive number is a precondition for the time-index padding to
        // sort correctly.
        //
        // Cap at MAX_SCHEDULED_FOR_MS (the largest value that still pads to
        // TIME_PAD digits) and require an integer: a value wider than the pad
        // would zero-pad to a longer key that mis-sorts against shorter ones,
        // and for values >= 1e21 `String()` switches to exponential notation
        // ('1e+21'), which additionally breaks the `Number.parseInt()` recovery
        // in alarm()/rescheduleAlarm() (it stops at the 'e').
        if (typeof body.scheduledFor !== "number" || !isIndexableTime(body.scheduledFor)) {
            return SchedulerDO.error(400, "INVALID_INPUT", "scheduledFor must be a positive integer epoch-millisecond number no greater than 999999999999999");
        }

        // Dispatch target lives only in env — never trust an `originUrl` from
        // the caller (would be an SSRF vector). Refuse schedules if the env
        // hasn't been configured: the job would be unfireable.
        if (typeof this.env.LUNORA_ORIGIN_URL !== "string" || this.env.LUNORA_ORIGIN_URL.length === 0) {
            return SchedulerDO.error(500, "ORIGIN_NOT_CONFIGURED", "LUNORA_ORIGIN_URL env binding must be set on the SchedulerDO");
        }

        const pool = typeof body.pool === "string" && body.pool.length > 0 ? body.pool : undefined;
        const instanceName = typeof body.instanceName === "string" && body.instanceName.length > 0 ? body.instanceName : undefined;
        const retry = SchedulerDO.normalizeRetry(body.retry);
        const id = resolveScheduleId(body.id);

        // Only an id the CALLER chose can collide — a minted one is 96 random
        // bits — so this costs two `get`s on the deferred path and nothing on
        // the ordinary one.
        const conflict = id === body.id ? await this.idConflict(id) : undefined;

        if (conflict) {
            return conflict;
        }

        const record: ScheduleRecord = {
            // body is parsed from an untrusted request; args may be absent at runtime
            // despite the type, so the ?? fallback is a real guard.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- parsed wire data can omit args
            args: body.args ?? {},
            enqueuedAt: Date.now(),
            id,
            ...(functionPath === undefined ? {} : { functionPath }),
            ...(instanceName === undefined ? {} : { instanceName }),
            ...(pool === undefined ? {} : { pool }),
            ...(retry === undefined ? {} : { retry }),
            scheduledFor: body.scheduledFor,
            shardKey: body.shardKey,
            ...(workflow === undefined ? {} : { workflow }),
        };

        if (pool !== undefined) {
            await this.persistPoolCap(pool, body.maxConcurrency);
        }

        await this.state.storage.put(`${HEADER_PREFIX}${id}`, record);
        await this.state.storage.put(SchedulerDO.indexKey(record.scheduledFor, id), id);
        // Fast path: the new job is the only thing that could have moved the
        // earliest-pending time *earlier*. If a current alarm is already at or
        // before the new job, no rescan is needed — just keep it. Only when the
        // new job is sooner (or no alarm is set) do we (re)arm. Avoids a `t:`
        // list on every schedule of a not-earliest job.
        await this.armAlarmIfEarlier(record.scheduledFor);
        await this.broadcastChange();

        return SchedulerDO.json({ id, scheduledFor: record.scheduledFor });
    }

    private async handleCancel(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => undefined)) as CancelRequestBody | undefined;

        if (!body?.id) {
            return SchedulerDO.error(400, "INVALID_INPUT", "id is required");
        }

        const record = await this.state.storage.get<ScheduleRecord>(`${HEADER_PREFIX}${body.id}`);

        if (!record) {
            return SchedulerDO.json({ cancelled: false });
        }

        await this.removeRecord(record);
        // NOTE: a pooled job that is still here (its `id:` header exists) is by
        // definition NOT in flight — drainRecord() deletes the header the moment
        // it dispatches and reserves a slot. So cancel never needs to release a
        // pool slot: a queued job holds none, and a dispatched one is no longer
        // reachable by id. (A dispatched-but-never-completed job's slot is freed
        // only by /complete; the lack of a lease timeout is a known limitation.)
        await this.rescheduleAlarm();
        await this.broadcastChange();

        return SchedulerDO.json({ cancelled: true });
    }

    /**
     * `GET /list[?cursor=]` — one bounded page of pending jobs. `truncated` says
     * whether more rows follow and `cursor` is what a caller passes back to get
     * them (`createScheduler.list()` walks every page; the studio shows one).
     */
    private async handleList(url: URL): Promise<Response> {
        const { cursor, records, truncated } = await this.listPage(HEADER_PREFIX, DEFAULT_LIST_LIMIT, url.searchParams.get("cursor") ?? undefined);

        return SchedulerDO.json({ cursor, records, truncated });
    }

    /**
     * `GET /dead` — list the dead-letter records: jobs that exhausted their
     * retry budget ({@link recordRetry}) and were parked under `dead:<id>`
     * instead of being silently dropped. These never appear in `/list` (their
     * `id:` header is deleted on park), so this is the ONLY way the studio can
     * surface — and recover — a permanently-failed job. Bounded and cursored
     * like `/list`: nothing prunes `dead:`, so this set grows without limit.
     */
    private async handleDeadList(url: URL): Promise<Response> {
        const { cursor, records, truncated } = await this.listPage(DEAD_PREFIX, DEFAULT_LIST_LIMIT, url.searchParams.get("cursor") ?? undefined);

        return SchedulerDO.json({ cursor, records, truncated });
    }

    /**
     * `POST /dead/retry { id }` — resurrect a dead-letter record: reset its
     * exhausted attempt count to 0 (a fresh retry budget), re-arm it for
     * immediate dispatch via the standard time index, and drop the `dead:` row.
     * The new `id:` header makes it visible to `/list` and the live `/ws`
     * subscription again. A miss is a no-op (`{ retried: false }`).
     */
    private async handleDeadRetry(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => undefined)) as { id?: string } | undefined;

        if (typeof body?.id !== "string" || body.id.length === 0) {
            return SchedulerDO.error(400, "INVALID_INPUT", "id is required");
        }

        const dead = await this.state.storage.get<ScheduleRecord>(`${DEAD_PREFIX}${body.id}`);

        if (dead === undefined) {
            return SchedulerDO.json({ retried: false });
        }

        const scheduledFor = Date.now();
        // Reset attempts so the resurrected job gets a full retry budget; re-arm
        // via the standard time index and drop the dead row in one move. Going
        // through the normal header+index path means a pooled job re-enters the
        // concurrency gate on the next drain exactly like a fresh enqueue.
        const revived: ScheduleRecord = { ...dead, attempts: 0, scheduledFor };

        await this.state.storage.put(`${HEADER_PREFIX}${dead.id}`, revived);
        await this.state.storage.put(SchedulerDO.indexKey(scheduledFor, dead.id), dead.id);
        await this.state.storage.delete(`${DEAD_PREFIX}${dead.id}`);
        await this.armAlarmIfEarlier(scheduledFor);
        await this.broadcastChange();

        return SchedulerDO.json({ id: dead.id, retried: true, scheduledFor });
    }

    /**
     * `POST /dead/cancel { id }` — permanently drop a dead-letter record the
     * operator has decided not to recover. Returns `{ removed }` (false when
     * nothing matched). Idempotent: a repeated purge is a harmless no-op.
     */
    private async handleDeadCancel(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => undefined)) as { id?: string } | undefined;

        if (typeof body?.id !== "string" || body.id.length === 0) {
            return SchedulerDO.error(400, "INVALID_INPUT", "id is required");
        }

        const removed = await this.state.storage.delete(`${DEAD_PREFIX}${body.id}`);

        return SchedulerDO.json({ removed: Boolean(removed) });
    }

    /**
     * Resolve a single pending job by id via a direct `id:<id>` storage read —
     * O(1), versus scanning the whole `/list` view. Responds `{ record }` on a
     * hit and `{}` on a miss (an absent `record` field — JSON has no `undefined`
     * — which the client reads back as `null`).
     */
    private async handleGet(url: URL): Promise<Response> {
        const id = url.searchParams.get("id");

        if (id === null || id.length === 0) {
            return SchedulerDO.error(400, "INVALID_INPUT", "id is required");
        }

        const record = await this.state.storage.get<ScheduleRecord>(`${HEADER_PREFIX}${id}`);

        return SchedulerDO.json(record === undefined ? {} : { record });
    }

    private async removeRecord(record: ScheduleRecord): Promise<void> {
        // Single batched delete: the header, time-index entry, and any pending
        // retry row in one storage round-trip instead of three.
        await this.state.storage.delete([`${HEADER_PREFIX}${record.id}`, SchedulerDO.indexKey(record.scheduledFor, record.id), `${RETRY_PREFIX}${record.id}`]);
    }

    /**
     * Arm the alarm for `scheduledFor` only if it is sooner than the currently
     * set alarm (or none is set). Used on the schedule path: inserting a job
     * can only ever pull the earliest-pending time *earlier*, never later, so a
     * full `t:` rescan is unnecessary unless the new job is the new earliest.
     */
    private async armAlarmIfEarlier(scheduledFor: number): Promise<void> {
        const current = await this.state.storage.getAlarm();

        if (current === null || scheduledFor < current) {
            await this.state.storage.setAlarm(scheduledFor);
        }
    }

    /**
     * Re-index every pending job whose time-index entry is gone.
     *
     * {@link SchedulerDO.drainRecordGuarded} claims a job by DELETING its `t:`
     * entry, awaited (so durable) BEFORE {@link SchedulerDO.dispatch}'s outbound
     * fetch. If the Durable Object is evicted or crashes during that fetch, the
     * `id:` header (and any `retry:` row) survives with no `t:` entry — and
     * nothing puts one back: {@link SchedulerDO.rescheduleAlarm} derives the
     * clock from `t:` alone, and `alarm()`'s inline reconciliation only handles
     * the INVERSE orphan (a `t:` entry whose header is gone). The job then sits
     * in `/list` and `/status.backlog` forever, never fires, never reaches
     * `/dead`. The at-least-once contract `drainRecordGuarded` documents covers
     * a thrown storage op, not a lost instance.
     *
     * Re-firing is safe: the dispatch carries the record id, which the receiver
     * spends as `x-lunora-mutation-id` for a function target and as the workflow
     * INSTANCE id for a `workflow` target, so a job that DID reach the origin
     * before the crash is not run twice either way.
     *
     * Two bounded walks (all `t:` values, then all `id:` headers) rather than a
     * per-header `get`, so the cost is one pass over each prefix.
     */
    private async reindexOrphanedRecords(): Promise<void> {
        if (this.reindexed) {
            return;
        }

        this.reindexed = true;

        const indexed = new Set<string>();

        await this.forEachPage<string>("t:", (recordId) => {
            indexed.add(recordId);
        });

        const orphans: ScheduleRecord[] = [];

        await this.forEachPage<ScheduleRecord>(HEADER_PREFIX, (record) => {
            // A record whose `scheduledFor` is not representable as an index key
            // is deliberately unindexed (see `isIndexableTime`) — leave it alone.
            if (!indexed.has(record.id) && isIndexableTime(record.scheduledFor)) {
                orphans.push(record);
            }
        });

        for (const record of orphans) {
            // eslint-disable-next-line no-await-in-loop -- Durable Object storage is single-threaded local state; the index write and the alarm arm must land in order per record
            await this.state.storage.put(SchedulerDO.indexKey(record.scheduledFor, record.id), record.id);
            // eslint-disable-next-line no-await-in-loop -- same
            await this.armAlarmIfEarlier(record.scheduledFor);
        }
    }

    private async rescheduleAlarm(): Promise<void> {
        const entries = await this.state.storage.list<string>({ limit: 1, prefix: "t:" });
        const first = entries.entries().next();

        if (first.done) {
            await this.state.storage.deleteAlarm();

            return;
        }

        const [indexKey] = first.value;
        const dueAt = Number.parseInt(indexKey.slice(2, indexKey.indexOf(":", 2)), 10);

        if (Number.isFinite(dueAt)) {
            await this.state.storage.setAlarm(dueAt);
        }
    }
}

export { MAX_RETRY_ATTEMPTS, RETRY_BASE_DELAY_MS, SchedulerDO };
export type { SchedulerDOState, SchedulerEnv, SchedulerPoolStatus, SchedulerStatus };
