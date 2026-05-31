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
}

const HEADER_PREFIX = "id:";
const RETRY_PREFIX = "retry:";
const DEAD_PREFIX = "dead:";
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 30_000;
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
    originUrl: string;
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
            const ok = await this.dispatch(record);

            // Always clear the original time-index slot (the alarm has already
            // fired for it). Whether we keep or replace the `id:` row depends
            // on the dispatch outcome.
            await this.state.storage.delete(this.indexKey(record.scheduledFor, record.id));

            await (ok ? this.state.storage.delete(`${HEADER_PREFIX}${record.id}`) : this.recordRetry(record));
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
     * request. Returns `true` when the dispatch is considered successful (any
     * HTTP response), `false` if the fetch threw or returned a 5xx — those
     * cases enter the retry pipeline via {@link recordRetry}.
     */
    protected async dispatch(record: ScheduleRecord): Promise<boolean> {
        const { originUrl } = record as ScheduleRecord & { originUrl?: string };

        if (!originUrl) {
            return true;
        }

        try {
            const response = await fetch(`${originUrl}/_cirrus/scheduler/dispatch`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    functionPath: record.functionPath,
                    args: record.args,
                    shardKey: record.shardKey,
                    scheduledFor: record.scheduledFor,
                    id: record.id,
                }),
            });

            // Treat 5xx as transient and retry; 4xx is the caller's problem
            // and won't be improved by a retry, so we consider it "done".
            return response.status < 500;
        } catch {
            return false;
        }
    }

    /**
     * Move a failed record into the retry pipeline with exponential backoff.
     * After {@link MAX_RETRY_ATTEMPTS} attempts the record is parked under a
     * `dead:` key for manual inspection.
     */
    private async recordRetry(record: ScheduleRecord & { attempts?: number; originUrl?: string }): Promise<void> {
        const attempts = (record.attempts ?? 0) + 1;

        if (attempts > MAX_RETRY_ATTEMPTS) {
            await this.state.storage.put(`${DEAD_PREFIX}${record.id}`, { ...record, attempts });

            return;
        }

        const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempts - 1);
        const nextScheduledFor = Date.now() + delayMs;
        const retryRecord: ScheduleRecord & { attempts: number; originUrl?: string } = {
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

        if (!body || typeof body.functionPath !== "string" || typeof body.scheduledFor !== "number") {
            return this.error(400, "INVALID_INPUT", "functionPath and scheduledFor are required");
        }

        const id = generateId();
        const record: ScheduleRecord & { originUrl: string } = {
            id,
            functionPath: body.functionPath,
            args: body.args ?? {},
            scheduledFor: body.scheduledFor,
            shardKey: body.shardKey,
            enqueuedAt: Date.now(),
            originUrl: body.originUrl,
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
