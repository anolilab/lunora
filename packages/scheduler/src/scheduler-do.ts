import type { RetryPolicy, ScheduleRecord } from "./types.js";

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
    maxConcurrency: number;
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

    protected readonly state: SchedulerDOState;

    protected readonly env: SchedulerEnv;

    public constructor(state: SchedulerDOState, env: SchedulerEnv) {
        this.state = state;
        this.env = env;
    }

    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade();
        }

        if (url.pathname === "/schedule" && request.method === "POST") {
            return this.handleSchedule(request);
        }

        if (url.pathname === "/cancel" && request.method === "POST") {
            return this.handleCancel(request);
        }

        if (url.pathname === "/complete" && request.method === "POST") {
            return this.handleComplete(request);
        }

        if (url.pathname === "/get" && request.method === "GET") {
            return this.handleGet(url);
        }

        if (url.pathname === "/list" && request.method === "GET") {
            return this.handleList();
        }

        if (url.pathname === "/pool" && request.method === "GET") {
            return this.handlePoolStatus(url);
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
        // to live subscribers — this is the moment a dashboard wants to see.
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
            const pool = pools.get(record.pool);

            if (pool !== undefined) {
                pool.inFlight = Math.max(0, pool.inFlight - 1);
                await this.savePool(record.pool, pool);
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
        // alarm nor this same pass can oversubscribe the pool.
        pool.inFlight += 1;
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
     * any change (schedule / cancel / alarm-fire) so live dashboards reflect it
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
            // dead job visible in listRecords()/`/list` (and the dashboard) as a
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
            return { inFlight: Math.max(0, stored.inFlight), maxConcurrency: stored.maxConcurrency };
        }

        return { inFlight: 0, maxConcurrency: SchedulerDO.normalizeConcurrency(maxConcurrencyHint, 1) };
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

        if (poolName === undefined) {
            return SchedulerDO.error(400, "INVALID_INPUT", "pool is required");
        }

        const pool = await this.loadPool(poolName);

        pool.inFlight = Math.max(0, pool.inFlight - 1);
        await this.savePool(poolName, pool);

        // A freed slot means a queued job can now run; pull the alarm forward so
        // the drain happens promptly instead of waiting for the backpressure tick.
        await this.armAlarmIfEarlier(Date.now());

        return SchedulerDO.json({ inFlight: pool.inFlight });
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
export type { SchedulerDOState, SchedulerEnv };
