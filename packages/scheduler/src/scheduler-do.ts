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
    storage: {
        delete: (key: string | string[]) => Promise<number | boolean>;
        deleteAlarm: () => Promise<void> | void;
        get: <T = unknown>(key: string) => Promise<T | undefined>;
        getAlarm: () => Promise<number | null>;
        list: <T = unknown>(options?: { end?: string; limit?: number; prefix?: string }) => Promise<Map<string, T>>;
        put: <T = unknown>(entries: Record<string, T> | string, value?: T) => Promise<void>;
        setAlarm: (scheduledTime: number | Date) => Promise<void> | void;
    };
}

interface SchedulerEnv {
    [key: string]: unknown;

    /**
     * Fallback bearer token attached to the dispatch when
     * {@link SchedulerEnv.CIRRUS_SCHEDULER_SECRET} is not configured. Sent as
     * `authorization: Bearer &lt;token>`.
     */
    CIRRUS_ADMIN_TOKEN?: string;

    /**
     * Base URL where the Worker is mounted. SchedulerDO uses this at dispatch
     * time to call back into the Worker. Read at fire time (NOT taken from the
     * request body) to prevent SSRF via a forged `originUrl` field.
     */
    CIRRUS_ORIGIN_URL?: string;

    /**
     * Shared secret used to HMAC-sign the dispatch body so the runtime receiver
     * can authenticate the call (header `x-cirrus-scheduler-signature`). Without
     * it the dispatch is sent unsigned (optionally bearer-authenticated via
     * {@link SchedulerEnv.CIRRUS_ADMIN_TOKEN}).
     */
    CIRRUS_SCHEDULER_SECRET?: string;
}

const HEADER_PREFIX = "id:";
const RETRY_PREFIX = "retry:";
const DEAD_PREFIX = "dead:";
const POOL_PREFIX = "pool:";
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 30_000;
// When a pooled job can't run because its pool is at `maxConcurrency`, it is
// re-armed this far in the future so a later alarm drains it as slots free.
// Small enough to feel responsive, large enough to avoid a busy alarm loop.
const POOL_BACKPRESSURE_DELAY_MS = 1000;
// Maximum valid `Date` in epoch milliseconds (per ECMAScript). Past this,
// `String(scheduledFor)` would switch to exponential notation and corrupt the
// zero-padded time index — see indexKey() and handleSchedule().
const MAX_SCHEDULED_FOR_MS = 8_640_000_000_000_000;
// Zero-padded to 15 digits so lexical order matches numeric order — see indexKey().
const TIME_PAD = 15;
const padTime = (n: number): string => String(n).padStart(TIME_PAD, "0");

const generateId = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

interface ScheduleRequestBody {
    args: Record<string, unknown>;
    functionPath: string;

    /**
     * The scheduler/workpool instance name the enqueuing client routed to
     * (`createWorkpool({ instanceName })`). Echoed in the dispatch payload so the
     * runtime can call back the SAME DO instance's `/complete` to release a
     * pooled job's slot. Defaults to `"default"`.
     */
    instanceName?: string;

    /**
     * Workpool concurrency cap, sent alongside `pool` by `Workpool.enqueue`.
     * Persisted on the pool's `pool:&lt;name>` storage row so the alarm-time
     * concurrency gate has a value even if the in-memory client is gone.
     */
    maxConcurrency?: number;

    /**
     * Legacy field accepted but ignored: dispatch always uses
     * `env.CIRRUS_ORIGIN_URL`. Kept on the wire so older `@cirrus/scheduler`
     * clients can still talk to this DO.
     */
    originUrl?: string;
    /** Logical workpool name; gates dispatch behind {@link ScheduleRequestBody.maxConcurrency}. */
    pool?: string;
    /** Per-job retry policy; overrides the DO's built-in defaults when present. */
    retry?: RetryPolicy;
    scheduledFor: number;
    shardKey?: string;
}

/** Durable per-pool state stored under `pool:&lt;name>`. */
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
    /** The logical workpool name (the `pool:&lt;name>` suffix). */
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
    /** Per-pool backlog breakdown, one entry per `pool:&lt;name>` record. */
    pools: SchedulerPoolStatus[];
}

interface CancelRequestBody {
    id: string;
}

/**
 * Durable Object that stores pending scheduled invocations sorted by their
 * `scheduledFor` time and fires them via HTTP on alarm. Storage layout:
 * `id:&lt;id>` maps to {@link ScheduleRecord}; `t:&lt;paddedTime>:&lt;id>` maps to the
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
        return Response.json(body, { headers: { "content-type": "application/json" }, status });
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

    protected readonly state: SchedulerDOState;

    protected readonly env: SchedulerEnv;

    public constructor(state: SchedulerDOState, env: SchedulerEnv) {
        this.state = state;
        this.env = env;
    }

    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // `/ws` gates on the Upgrade header rather than the HTTP method, so it
        // stays a dedicated check; the rest dispatch on `${method} ${pathname}`.
        if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade();
        }

        switch (`${request.method} ${url.pathname}`) {
            case "GET /get": {
                return this.handleGet(url);
            }
            case "GET /list": {
                return this.handleList();
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
            case "POST /schedule": {
                return this.handleSchedule(request);
            }
            default: {
                break;
            }
        }

        return Response.json(
            { error: { code: "NOT_FOUND" } },
            {
                headers: { "content-type": "application/json" },
                status: 404,
            },
        );
    }

    /** Called by the Workers runtime when the alarm previously set by `_rescheduleAlarm()` fires. */
    public async alarm(): Promise<void> {
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
                }
            }
        }

        // Per-pool budget for THIS drain pass. The durable `pool:<name>` row
        // tracks how many of the pool's jobs are already in flight; the budget
        // is the remaining slots. We dispatch up to that many pooled jobs and
        // re-arm the rest for a near-future alarm so they drain as slots free —
        // bounded concurrency without busy-looping. Cached in `pools` so the
        // budget is decremented across the loop without re-reading storage.
        const pools = new Map<string, PoolState>();

        for (const record of due) {
            // Claim the job BEFORE dispatching by dropping its time-index entry.
            // If the alarm re-fires (or this run is interrupted and retried) the
            // index entry is gone, so the job won't be picked up again, while
            // the `id:` header and any `retry:` row survive for cleanup/retry.
            // recordRetry() recreates a fresh index entry on failure.
            await this.state.storage.delete(SchedulerDO.indexKey(record.scheduledFor, record.id));
            await this.drainRecord(record, pools);
        }
        /* eslint-enable no-await-in-loop */

        await this.rescheduleAlarm();

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
     * The dispatch target is taken from `env.CIRRUS_ORIGIN_URL` (NOT from the
     * stored record) to prevent SSRF via a forged `originUrl` on the schedule
     * request. If that env var is missing at fire time (a deploy/binding
     * regression — schedule time already enforced its presence) we return
     * `false` so the record is retried rather than silently dropped.
     */
    protected async dispatch(record: ScheduleRecord): Promise<boolean> {
        const originUrl = typeof this.env.CIRRUS_ORIGIN_URL === "string" && this.env.CIRRUS_ORIGIN_URL.length > 0 ? this.env.CIRRUS_ORIGIN_URL : undefined;

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
        });

        const headers: Record<string, string> = { "content-type": "application/json" };

        // Authenticate the dispatch so the receiver route can reject anonymous
        // callers (an unauthenticated receiver would execute arbitrary
        // functions for anyone who can reach the origin). We HMAC-sign the
        // exact JSON body with a shared secret and send it as a header; the
        // runtime-side receiver re-derives the HMAC and compares.
        //
        // Env vars (read at fire time, never from the request body):
        //   CIRRUS_SCHEDULER_SECRET — shared HMAC secret. Preferred.
        //   CIRRUS_ADMIN_TOKEN      — fallback bearer if no HMAC secret is set.
        // With neither configured the body is sent unsigned (current behaviour);
        // the receiver should then refuse to run in that posture.
        const signature = await this.signDispatch(body);

        if (signature !== undefined) {
            headers["x-cirrus-scheduler-signature"] = signature;
        } else if (typeof this.env.CIRRUS_ADMIN_TOKEN === "string" && this.env.CIRRUS_ADMIN_TOKEN.length > 0) {
            headers.authorization = `Bearer ${this.env.CIRRUS_ADMIN_TOKEN}`;
        }

        try {
            const response = await fetch(`${originUrl}/_cirrus/scheduler/dispatch`, {
                body,
                headers,
                method: "POST",
            });

            // Success is an explicit 2xx only. A 404 (receiver route missing),
            // any other 4xx, or a 5xx is NOT treated as done — the caller
            // (alarm()) keeps the record and routes it through recordRetry()
            // rather than deleting it. Idempotent dispatch keyed by record id
            // makes a re-fire safe.
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Process one due (already index-claimed) record within an alarm drain:
     * apply the workpool concurrency gate, dispatch, and settle the result.
     * A saturated pool re-arms the job (backpressure, no attempt charged); a
     * free slot is reserved durably before dispatch and released immediately if
     * the kick fails (success holds it until the runtime reports completion).
     * Success clears the `id:`/`retry:` rows; failure routes to
     * {@link recordRetry}. `pools` caches each pool's {@link PoolState} for the
     * lifetime of the drain so the budget decrements without re-reading storage.
     */
    private async drainRecord(record: ScheduleRecord, pools: Map<string, PoolState>): Promise<void> {
        const reserved = await this.reservePoolSlot(record, pools);

        if (!reserved) {
            // Pool at capacity — re-armed by reservePoolSlot(); skip dispatch.
            return;
        }

        const ok = await this.dispatch(record);

        if (!ok && record.pool !== undefined) {
            // The kick itself failed: no completion callback is coming, so free
            // the reserved slot immediately. recordRetry() then re-arms the job.
            // Release by id so a later (spurious) /complete for the same job
            // can't double-free and oversubscribe the pool.
            const pool = pools.get(record.pool);

            if (pool !== undefined) {
                const released = SchedulerDO.releaseSlot(pool, record.id);

                pools.set(record.pool, released);
                await this.savePool(record.pool, released);
            }
        }

        // On success, a single batched delete (one storage round-trip instead
        // of two) clears the header + retry rows; on failure, re-arm for retry.
        await (ok ? this.state.storage.delete([`${HEADER_PREFIX}${record.id}`, `${RETRY_PREFIX}${record.id}`]) : this.recordRetry(record));
    }

    /**
     * Concurrency gate for a pooled record. Returns `false` (and re-arms the
     * job via {@link requeuePooled}) when the pool is at `maxConcurrency`;
     * otherwise reserves a slot durably and returns `true`. Non-pooled records
     * always return `true` without touching any pool state.
     */
    private async reservePoolSlot(record: ScheduleRecord, pools: Map<string, PoolState>): Promise<boolean> {
        if (record.pool === undefined) {
            return true;
        }

        const pool = pools.get(record.pool) ?? (await this.loadPool(record.pool));

        pools.set(record.pool, pool);

        if (pool.inFlight >= pool.maxConcurrency) {
            await this.requeuePooled(record);

            return false;
        }

        // Reserve a slot durably BEFORE dispatching so neither a concurrent
        // alarm nor this same pass can oversubscribe the pool. Track the holding
        // job id so the eventual release (success → /complete, failed kick →
        // drainRecord) is idempotent per job and can't over-release.
        const ids = pool.inFlightIds ?? [];

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
        // Seed the new subscriber with the current list so its first value
        // arrives over the same channel as later changes.
        server.send(JSON.stringify({ records: await this.listRecords(), type: "jobs" }));

        // eslint-disable-next-line unicorn/no-null -- a 101 WebSocket-upgrade Response must have a null body
        return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * Re-list the jobs and push them to every connected subscriber. Called after
     * any change (schedule / cancel / alarm-fire) so live studios reflect it
     * immediately. A no-op when the runtime doesn't support hibernated sockets.
     */
    private async broadcastChange(): Promise<void> {
        const sockets = this.state.getWebSockets?.();

        if (sockets === undefined || sockets.length === 0) {
            return;
        }

        const message = JSON.stringify({ records: await this.listRecords(), type: "jobs" });

        for (const socket of sockets) {
            try {
                socket.send(message);
            } catch {
                /* a closing socket — the runtime will clean it up on close */
            }
        }
    }

    /** The current pending job records (shared by `/list` and the live channel). */
    private async listRecords(): Promise<ScheduleRecord[]> {
        const entries = await this.state.storage.list<ScheduleRecord>({ prefix: HEADER_PREFIX });

        return [...entries.values()];
    }

    /**
     * HMAC-SHA-256 sign the dispatch body with `env.CIRRUS_SCHEDULER_SECRET`,
     * returning a base64url signature, or `undefined` when no secret is
     * configured. Mirrors `@cirrus/storage`'s signed-URL HMAC pattern (WebCrypto
     * `crypto.subtle`, available in workerd).
     */
    private async signDispatch(body: string): Promise<string | undefined> {
        const secret = typeof this.env.CIRRUS_SCHEDULER_SECRET === "string" ? this.env.CIRRUS_SCHEDULER_SECRET : undefined;

        if (!secret || secret.length === 0) {
            return undefined;
        }

        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
        const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
        const bytes = new Uint8Array(signature);
        let binary = "";

        for (const byte of bytes) {
            binary += String.fromCodePoint(byte);
        }

        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

        if (attempts > maxAttempts) {
            await this.state.storage.put(`${DEAD_PREFIX}${record.id}`, { ...record, attempts });
            // Park is terminal; clear the pending retry row AND the live header
            // row in one batched delete. Leaving `id:<id>` behind would keep the
            // dead job visible in listRecords()/`/list` (and the studio) as a
            // scheduled job that can never fire — only the `dead:` record should
            // survive.
            await this.state.storage.delete([`${RETRY_PREFIX}${record.id}`, `${HEADER_PREFIX}${record.id}`]);

            return;
        }

        const rawDelay = backoff === "linear" ? baseMs * attempts : baseMs * 2 ** (attempts - 1);
        const delayMs = maxMs === undefined ? rawDelay : Math.min(rawDelay, maxMs);
        const nextScheduledFor = Date.now() + delayMs;
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

    /** Read the durable `pool:&lt;name>` row, defaulting to a fresh `inFlight: 0` pool. */
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
        const headers = await this.state.storage.list<ScheduleRecord>({ prefix: HEADER_PREFIX });
        let queued = 0;

        for (const record of headers.values()) {
            if (record.pool === name) {
                queued += 1;
            }
        }

        return SchedulerDO.json({ inFlight: pool.inFlight, maxConcurrency: pool.maxConcurrency, queued });
    }

    /**
     * `GET /status` — the app-level backlog signal that powers the studio's
     * SLO view. Enumerates every durable `pool:&lt;name>` row for its `inFlight`/
     * `maxConcurrency` semaphore, counts the pending (not-yet-dispatched) jobs
     * routed to each pool with the same single-pass scan {@link handlePoolStatus}
     * uses, and rolls those up into app-wide `backlog` (sum of `queued`) and
     * `inFlight` (sum of held slots) totals.
     *
     * Pools that have rows but no queued jobs still appear (with `queued: 0`) so
     * a saturated-but-idle pool stays visible; a pool that only ever existed as
     * queued jobs without a persisted row is unreachable here (the schedule path
     * always writes a `pool:&lt;name>` row before the job's header), so a single
     * scan over `pool:`/`id:` is sufficient.
     */
    private async handleStatus(): Promise<Response> {
        // One scan for the durable pool rows (concurrency state) and one for the
        // pending headers (queued counts). Both are bounded prefix lists, mirroring
        // the existing `/pool` read path rather than re-deriving pool state.
        const poolRows = await this.state.storage.list<PoolState>({ prefix: POOL_PREFIX });
        const headers = await this.state.storage.list<ScheduleRecord>({ prefix: HEADER_PREFIX });

        // Count pending jobs per pool name in a single pass over the headers,
        // exactly as handlePoolStatus() counts for one pool.
        const queuedByPool = new Map<string, number>();

        for (const record of headers.values()) {
            if (record.pool !== undefined) {
                queuedByPool.set(record.pool, (queuedByPool.get(record.pool) ?? 0) + 1);
            }
        }

        const pools: SchedulerPoolStatus[] = [];
        let backlog = 0;
        let inFlight = 0;

        for (const [key, pool] of poolRows.entries()) {
            const name = key.slice(POOL_PREFIX.length);
            // Defend against a corrupted row (`inFlight` should never go negative)
            // exactly as loadPool() does on the alarm path.
            const slots = Math.max(0, pool.inFlight);
            const queued = queuedByPool.get(name) ?? 0;

            pools.push({ inFlight: slots, maxConcurrency: pool.maxConcurrency, name, queued });
            backlog += queued;
            inFlight += slots;
        }

        const status: SchedulerStatus = { backlog, inFlight, pools };

        return SchedulerDO.json(status);
    }

    private async handleSchedule(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => undefined)) as ScheduleRequestBody | undefined;

        if (!body || typeof body.functionPath !== "string") {
            return SchedulerDO.error(400, "INVALID_INPUT", "functionPath is required");
        }

        // Reject NaN, +/-Infinity and non-positive timestamps. A finite
        // positive number is a precondition for the time-index padding to
        // sort correctly.
        //
        // Cap at the maximum valid `Date` (8.64e15 ms) and require an integer:
        // for values >= 1e21 `String()` switches to exponential notation
        // ('1e+21'), which breaks `indexKey()`'s zero-padding and the
        // `Number.parseInt()` recovery in alarm()/rescheduleAlarm() (it stops
        // at the 'e'), corrupting the sort order so jobs fire immediately.
        if (
            typeof body.scheduledFor !== "number" ||
            !Number.isInteger(body.scheduledFor) ||
            body.scheduledFor <= 0 ||
            body.scheduledFor > MAX_SCHEDULED_FOR_MS
        ) {
            return SchedulerDO.error(400, "INVALID_INPUT", "scheduledFor must be a positive integer epoch-millisecond number no greater than 8640000000000000");
        }

        // Dispatch target lives only in env — never trust an `originUrl` from
        // the caller (would be an SSRF vector). Refuse schedules if the env
        // hasn't been configured: the job would be unfireable.
        if (typeof this.env.CIRRUS_ORIGIN_URL !== "string" || this.env.CIRRUS_ORIGIN_URL.length === 0) {
            return SchedulerDO.error(500, "ORIGIN_NOT_CONFIGURED", "CIRRUS_ORIGIN_URL env binding must be set on the SchedulerDO");
        }

        const pool = typeof body.pool === "string" && body.pool.length > 0 ? body.pool : undefined;
        const instanceName = typeof body.instanceName === "string" && body.instanceName.length > 0 ? body.instanceName : undefined;
        const retry = SchedulerDO.normalizeRetry(body.retry);
        const id = generateId();
        const record: ScheduleRecord = {
            // body is parsed from an untrusted request; args may be absent at runtime
            // despite the type, so the ?? fallback is a real guard.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- parsed wire data can omit args
            args: body.args ?? {},
            enqueuedAt: Date.now(),
            functionPath: body.functionPath,
            id,
            ...(instanceName === undefined ? {} : { instanceName }),
            ...(pool === undefined ? {} : { pool }),
            ...(retry === undefined ? {} : { retry }),
            scheduledFor: body.scheduledFor,
            shardKey: body.shardKey,
        };

        // Persist (or refresh) the pool's concurrency cap so the alarm-time gate
        // has a durable maxConcurrency even after the enqueuing client is gone.
        if (pool !== undefined) {
            const current = await this.loadPool(pool, body.maxConcurrency);

            await this.savePool(pool, {
                inFlight: current.inFlight,
                // Preserve the in-flight id set so refreshing the cap on a new
                // enqueue can't wipe the held-slot bookkeeping (which would let
                // a later /complete over-release).
                ...(current.inFlightIds === undefined ? {} : { inFlightIds: current.inFlightIds }),
                maxConcurrency: SchedulerDO.normalizeConcurrency(body.maxConcurrency, current.maxConcurrency),
            });
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

    private async handleList(): Promise<Response> {
        return SchedulerDO.json({ records: await this.listRecords() });
    }

    /**
     * Resolve a single pending job by id via a direct `id:&lt;id>` storage read —
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

export { SchedulerDO };
export type { SchedulerDOState, SchedulerEnv, SchedulerPoolStatus, SchedulerStatus };
