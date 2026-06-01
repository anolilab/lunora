import type { ScheduleRecord } from "./types.js";

/**
 * Minimal projection of `DurableObjectState` for the SchedulerDO. Declared
 * structurally so unit tests can pass a fake state without booting the
 * workers runtime. The WebSocket methods are optional: they back the live
 * `/ws` subscription (push the job list on every change) and are absent in the
 * storage-only fakes, in which case the DO simply serves no live sockets.
 */
export interface SchedulerDOState {
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

export interface SchedulerEnv {
    [key: string]: unknown;
    /**
     * Fallback bearer token attached to the dispatch when
     * {@link SchedulerEnv.CIRRUS_SCHEDULER_SECRET} is not configured. Sent as
     * `authorization: Bearer <token>`.
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
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 30_000;
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
     * Legacy field accepted but ignored: dispatch always uses
     * `env.CIRRUS_ORIGIN_URL`. Kept on the wire so older `@cirrus/scheduler`
     * clients can still talk to this DO.
     */
    originUrl?: string;
    scheduledFor: number;
    shardKey?: string;
}

interface CancelRequestBody {
    id: string;
}

/**
 * Durable Object that stores pending scheduled invocations sorted by their
 * `scheduledFor` time and fires them via HTTP on alarm. Storage layout:
 *
 *   `id:<id>`               -> {@link ScheduleRecord}
 *   `t:<paddedTime>:<id>`   -> id (used as a sorted index)
 *
 * On every mutation the DO recomputes the earliest pending task and updates
 * the alarm via `state.storage.setAlarm(time)`.
 */
export class SchedulerDO {
    protected readonly state: SchedulerDOState;

    protected readonly env: SchedulerEnv;

    constructor(state: SchedulerDOState, env: SchedulerEnv) {
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

        if (url.pathname === "/list" && request.method === "GET") {
            return this.handleList();
        }

        return Response.json(
            { error: { code: "NOT_FOUND" } },
            {
                status: 404,
                headers: { "content-type": "application/json" },
            },
        );
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
            return this.error(501, "WS_UNSUPPORTED", "WebSocket subscriptions are not supported in this runtime");
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        this.state.acceptWebSocket(server);
        // Seed the new subscriber with the current list so its first value
        // arrives over the same channel as later changes.
        server.send(JSON.stringify({ records: await this.listRecords(), type: "jobs" }));

        return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
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

    /** Called by the Workers runtime when the alarm previously set by `_rescheduleAlarm()` fires. */
    public async alarm(): Promise<void> {
        const now = Date.now();
        const due: ScheduleRecord[] = [];

        // Pull only the prefix slice that's due. `~` sorts after all digits
        // in ASCII so it bounds the time-padded id portion. If the runtime
        // doesn't support `end`, the `limit` keeps the page bounded.
        const indexEntries = await this.state.storage.list<string>({
            prefix: "t:",
            end: `t:${padTime(now)}:~`,
            limit: 100,
        });

        for (const [indexKey, recordId] of indexEntries.entries()) {
            const dueAt = Number.parseInt(indexKey.slice(2, indexKey.indexOf(":", 2)), 10);

            if (Number.isFinite(dueAt) && dueAt <= now) {
                const record = await this.state.storage.get<ScheduleRecord>(`${HEADER_PREFIX}${recordId}`);

                if (record) {
                    due.push(record);
                }
            }
        }

        for (const record of due) {
            // Claim the job BEFORE dispatching: drop the time-index entry and
            // write a `dispatched:<id>` marker. If the alarm re-fires (or this
            // run is interrupted and retried) the index entry is gone, so the
            // job won't be picked up again. recordRetry() will recreate a
            // fresh index entry on failure.
            await this.state.storage.delete(this.indexKey(record.scheduledFor, record.id));
            await this.state.storage.put(`dispatched:${record.id}`, { dispatchedAt: Date.now() });

            const ok = await this.dispatch(record);

            if (ok) {
                await this.state.storage.delete(`${HEADER_PREFIX}${record.id}`);
                await this.state.storage.delete(`${RETRY_PREFIX}${record.id}`);
                await this.state.storage.delete(`dispatched:${record.id}`);
            } else {
                await this.state.storage.delete(`dispatched:${record.id}`);
                await this.recordRetry(record);
            }
        }

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
     * request.
     */
    protected async dispatch(record: ScheduleRecord): Promise<boolean> {
        const originUrl = typeof this.env.CIRRUS_ORIGIN_URL === "string" ? this.env.CIRRUS_ORIGIN_URL : undefined;

        if (!originUrl) {
            return true;
        }

        const body = JSON.stringify({
            functionPath: record.functionPath,
            args: record.args,
            shardKey: record.shardKey,
            scheduledFor: record.scheduledFor,
            id: record.id,
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
                method: "POST",
                headers,
                body,
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
        const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
        const bytes = new Uint8Array(signature);
        let binary = "";

        for (const byte of bytes) {
            binary += String.fromCodePoint(byte);
        }

        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    }

    /**
     * Move a failed record into the retry pipeline with exponential backoff.
     * After {@link MAX_RETRY_ATTEMPTS} attempts the record is parked under a
     * `dead:` key for manual inspection.
     */
    private async recordRetry(record: ScheduleRecord & { attempts?: number }): Promise<void> {
        const attempts = (record.attempts ?? 0) + 1;

        if (attempts > MAX_RETRY_ATTEMPTS) {
            await this.state.storage.put(`${DEAD_PREFIX}${record.id}`, { ...record, attempts });
            // Park is terminal; clear any pending retry row.
            await this.state.storage.delete(`${RETRY_PREFIX}${record.id}`);

            return;
        }

        const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempts - 1);
        const nextScheduledFor = Date.now() + delayMs;
        const retryRecord: ScheduleRecord & { attempts: number } = {
            ...record,
            attempts,
            scheduledFor: nextScheduledFor,
        };

        await this.state.storage.put(`${RETRY_PREFIX}${record.id}`, retryRecord);
        // Re-arm via the standard time index so the alarm fires at the right moment.
        await this.state.storage.put(`${HEADER_PREFIX}${record.id}`, retryRecord);
        await this.state.storage.put(this.indexKey(nextScheduledFor, record.id), record.id);
    }

    private async handleSchedule(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => null)) as ScheduleRequestBody | null;

        if (!body || typeof body.functionPath !== "string") {
            return this.error(400, "INVALID_INPUT", "functionPath is required");
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
            return this.error(400, "INVALID_INPUT", "scheduledFor must be a positive integer epoch-millisecond number no greater than 8640000000000000");
        }

        // Dispatch target lives only in env — never trust an `originUrl` from
        // the caller (would be an SSRF vector). Refuse schedules if the env
        // hasn't been configured: the job would be unfireable.
        if (typeof this.env.CIRRUS_ORIGIN_URL !== "string" || this.env.CIRRUS_ORIGIN_URL.length === 0) {
            return this.error(500, "ORIGIN_NOT_CONFIGURED", "CIRRUS_ORIGIN_URL env binding must be set on the SchedulerDO");
        }

        const id = generateId();
        const record: ScheduleRecord = {
            id,
            functionPath: body.functionPath,
            args: body.args ?? {},
            scheduledFor: body.scheduledFor,
            shardKey: body.shardKey,
            enqueuedAt: Date.now(),
        };

        await this.state.storage.put(`${HEADER_PREFIX}${id}`, record);
        await this.state.storage.put(this.indexKey(record.scheduledFor, id), id);
        await this.rescheduleAlarm();
        await this.broadcastChange();

        return this.json({ id, scheduledFor: record.scheduledFor });
    }

    private async handleCancel(request: Request): Promise<Response> {
        const body = (await request.json().catch(() => null)) as CancelRequestBody | null;

        if (!body?.id) {
            return this.error(400, "INVALID_INPUT", "id is required");
        }

        const record = await this.state.storage.get<ScheduleRecord>(`${HEADER_PREFIX}${body.id}`);

        if (!record) {
            return this.json({ cancelled: false });
        }

        await this.removeRecord(record);
        await this.rescheduleAlarm();
        await this.broadcastChange();

        return this.json({ cancelled: true });
    }

    private async handleList(): Promise<Response> {
        return this.json({ records: await this.listRecords() });
    }

    private async removeRecord(record: ScheduleRecord): Promise<void> {
        await this.state.storage.delete(`${HEADER_PREFIX}${record.id}`);
        await this.state.storage.delete(this.indexKey(record.scheduledFor, record.id));
        // Drop any pending retry row so cancelled jobs don't leak storage.
        await this.state.storage.delete(`${RETRY_PREFIX}${record.id}`);
    }

    private async rescheduleAlarm(): Promise<void> {
        const entries = await this.state.storage.list<string>({ prefix: "t:", limit: 1 });
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

    private indexKey(scheduledFor: number, id: string): string {
        // Zero-pad so the lexical order matches numerical order.
        return `t:${String(scheduledFor).padStart(15, "0")}:${id}`;
    }

    private json(body: unknown, status: number = 200): Response {
        return Response.json(body, { status, headers: { "content-type": "application/json" } });
    }

    private error(status: number, code: string, message: string): Response {
        return this.json({ error: { code, message } }, status);
    }
}
