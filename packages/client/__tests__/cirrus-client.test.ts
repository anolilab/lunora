import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CirrusClient } from "../src/cirrus-client.js";
import { createInMemoryPersistence } from "../src/persistence.js";
import type { FunctionReference } from "../src/types.js";

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- Test doubles -----------------------------------------------------------

interface MockSocket {
    addEventListener: (type: string, listener: (event?: unknown) => void) => void;
    close: () => void;
    onclose?: ((event?: unknown) => void) | null;
    onerror?: ((event?: unknown) => void) | null;
    onmessage?: ((event: { data: unknown }) => void) | null;
    onopen?: ((event?: unknown) => void) | null;
    open: () => void;
    readyState: number;
    receive: (payload: unknown) => void;
    send: (data: string) => void;
    sent: string[];
    triggerClose: () => void;
    url: string;
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public sent: string[] = [];

        public onopen: ((event?: unknown) => void) | null = null;

        public onmessage: ((event: { data: unknown }) => void) | null = null;

        public onclose: ((event?: unknown) => void) | null = null;

        public onerror: ((event?: unknown) => void) | null = null;

        private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

        public constructor(url: string) {
            this.url = url;
            sockets.push(this as unknown as MockSocket);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }

        public open(): void {
            this.readyState = 1;
            this.onopen?.();
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            const data = typeof payload === "string" ? payload : JSON.stringify(payload);

            this.onmessage?.({ data });
            this.dispatch("message", { data });
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.onclose?.();
            this.dispatch("close");
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public close(): void {
            this.triggerClose();
        }
    }

    return WS as unknown as typeof WebSocket;
};

const latestSocket = (): MockSocket => {
    const last = sockets.at(-1);

    if (!last) {
        throw new Error("no socket has been created yet");
    }

    return last;
};

const fn = (ref: string): FunctionReference => ({ __cirrusRef: ref });

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
    return Response.json(body, {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
    });
};

beforeEach(() => {
    sockets.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

// --- RPC --------------------------------------------------------------------

describe("cirrusClient — queries & mutations", () => {
    test("query roundtrips through POST /_cirrus/rpc and unwraps the result", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ result: { hello: "world" } }));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        const value = await client.query(fn("posts:list"), { limit: 10 });

        expect(value).toEqual({ hello: "world" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(requestUrl).toBe("https://app.example/_cirrus/rpc");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({
            functionPath: "posts:list",
            args: { limit: 10 },
            shardKey: undefined,
        });
    });

    test("query surfaces server errors as thrown Error objects", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 }));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await expect(client.query(fn("posts:get"), { id: "abc" })).rejects.toMatchObject({
            message: "missing",
            code: "NOT_FOUND",
        });
    });

    test("mutation captures x-d1-bookmark and replays it on the next query", async () => {
        let call = 0;

        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            call += 1;

            if (call === 1) {
                return Response.json(
                    { result: { ok: true } },
                    {
                        status: 200,
                        headers: {
                            "content-type": "application/json",
                            "x-d1-bookmark": "bm-123",
                        },
                    },
                );
            }

            // capture headers on the second (query) call
            (fetchMock as unknown as { lastHeaders?: Record<string, string> }).lastHeaders = (init.headers ?? {}) as Record<string, string>;

            return jsonResponse({ result: { rows: [] } });
        });

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await client.mutation(fn("posts:create"), { title: "hi" });
        await client.query(fn("posts:list"), {});

        const headers = (fetchMock as unknown as { lastHeaders: Record<string, string> }).lastHeaders;

        expect(headers["x-d1-bookmark"]).toBe("bm-123");
    });

    test("authorization header is attached when token is set", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ result: null }));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        client.setAuthToken("tkn");
        await client.query(fn("any:thing"), {});

        const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
        const headers = init.headers as Record<string, string>;

        expect(headers.authorization).toBe("Bearer tkn");
        expect(client.getAuthToken()).toBe("tkn");
    });
});

// --- Subscriptions ----------------------------------------------------------

describe("cirrusClient — subscriptions", () => {
    test("subscribe sends a subscribe envelope and delivers delta payloads", async () => {
        const fetchMock = vi.fn();
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        const received: unknown[] = [];
        const unsubscribe = client.subscribe(fn("messages:list"), {}, (d) => received.push(d));

        const socket = latestSocket();

        socket.open();

        expect(socket.sent).toHaveLength(1);

        const sub = JSON.parse(socket.sent[0]!);

        expect(sub.type).toBe("subscribe");
        expect(sub.id).toMatch(/^sub_/);

        socket.receive({ type: "ack", id: sub.id });
        socket.receive({ type: "delta", id: sub.id, delta: { count: 1 } });
        socket.receive({ type: "data", id: sub.id, data: { count: 2 } });

        expect(received).toEqual([{ count: 1 }, { count: 2 }]);

        unsubscribe();

        const last = JSON.parse(socket.sent.at(-1)!);

        expect(last).toEqual({ type: "unsubscribe", id: sub.id });
    });

    test("on reconnect, all active subscriptions are re-sent", async () => {
        vi.useFakeTimers();
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: (async () => jsonResponse({ result: null })) as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
            reconnect: { initialDelayMs: 10, maxDelayMs: 10, jitter: false },
        });

        client.subscribe(fn("a:b"), { x: 1 }, () => undefined);
        const first = latestSocket();

        first.open();

        expect(first.sent).toHaveLength(1);

        first.triggerClose();

        expect(sockets).toHaveLength(1);

        vi.advanceTimersByTime(15);
        const second = latestSocket();

        expect(second).not.toBe(first);

        second.open();

        expect(second.sent).toHaveLength(1);

        const env = JSON.parse(second.sent[0]!);

        expect(env.type).toBe("subscribe");
        expect(env.query.args).toEqual({ x: 1 });
    });

    test("duplicate subscribe calls share a single server-side subscription", () => {
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: (async () => jsonResponse({ result: null })) as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        const aReceived: unknown[] = [];
        const bReceived: unknown[] = [];

        const unsubA = client.subscribe(fn("rooms:list"), { roomId: "r1" }, (d) => aReceived.push(d));
        const unsubB = client.subscribe(fn("rooms:list"), { roomId: "r1" }, (d) => bReceived.push(d));

        const socket = latestSocket();

        socket.open();

        // Only one subscribe envelope despite two consumers.
        const subs = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "subscribe");

        expect(subs).toHaveLength(1);

        socket.receive({ type: "delta", id: subs[0].id, delta: { v: 42 } });

        expect(aReceived).toEqual([{ v: 42 }]);
        expect(bReceived).toEqual([{ v: 42 }]);

        unsubA();

        // Still subscribed since B is listening.
        expect(socket.sent.filter((s) => JSON.parse(s).type === "unsubscribe")).toHaveLength(0);

        unsubB();

        // Now an unsubscribe should fire.
        expect(socket.sent.filter((s) => JSON.parse(s).type === "unsubscribe")).toHaveLength(1);
    });
});

// --- Offline queue ----------------------------------------------------------

describe("cirrusClient — offline queue", () => {
    test("mutation issued while the socket is offline is queued and replayed on reconnect", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () => jsonResponse({ result: { id: "1" } }));
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
            reconnect: { initialDelayMs: 10, maxDelayMs: 10, jitter: false },
        });

        // First, open a real socket so the client considers itself "online".
        client.subscribe(fn("posts:list"), {}, () => undefined);
        const first = latestSocket();

        first.open();

        // Drop the socket — we're now offline.
        first.triggerClose();

        // Mutation while offline should be queued, not sent.
        const pending = client.mutation(fn("posts:create"), { title: "queued" });

        expect(fetchMock).not.toHaveBeenCalled();

        // Advance the reconnect timer and open the next socket.
        vi.advanceTimersByTime(20);
        const second = latestSocket();

        second.open();

        await vi.runAllTimersAsync();

        const value = await pending;

        expect(value).toEqual({ id: "1" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

// --- Durable offline queue --------------------------------------------------

describe("cirrusClient — durable offline queue", () => {
    test("hydrates persisted mutations on construct and flushes them once the socket opens", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ result: { ok: true } }));
        const persistence = createInMemoryPersistence();

        // A write durably queued by a prior session (e.g. before a reload).
        await persistence.append({ functionPath: "posts:create", args: { title: "restored" }, id: "m1" });

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
            persistence,
        });

        // The constructor kicks off async hydration which opens a socket for the
        // restored write's shard. Let that settle, then bring the socket up.
        await flushMicrotasks();
        latestSocket().open();
        await flushMicrotasks();

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

        expect(body).toMatchObject({ functionPath: "posts:create", args: { title: "restored" } });

        // Removed from durable storage once the server confirmed it.
        await expect(persistence.load()).resolves.toEqual([]);

        client.close();
    });

    test("un-persists a replayed mutation even when the server rejects it", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "BOOM", message: "fail" } }, { status: 500 }));
        const persistence = createInMemoryPersistence();

        await persistence.append({ functionPath: "posts:create", args: {}, id: "m1" });

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
            persistence,
        });

        await flushMicrotasks();
        latestSocket().open();
        await flushMicrotasks();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        // A server verdict (even a rejection) settles the write — replaying it
        // again would only re-trigger the same failure, so it is dropped.
        await expect(persistence.load()).resolves.toEqual([]);

        client.close();
    });

    test("a live mutation queued while offline is persisted and removed after replay", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () => jsonResponse({ result: { id: "1" } }));
        const persistence = createInMemoryPersistence();
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
            persistence,
            reconnect: { initialDelayMs: 10, maxDelayMs: 10, jitter: false },
        });

        // Get online, then drop the socket so the next mutation is queued.
        client.subscribe(fn("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        const pending = client.mutation(fn("posts:create"), { title: "queued" });

        await vi.advanceTimersByTimeAsync(0);

        await expect(persistence.load()).resolves.toHaveLength(1);

        // Reconnect and let the flush + remove settle.
        vi.advanceTimersByTime(20);
        latestSocket().open();
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toEqual({ id: "1" });
        await expect(persistence.load()).resolves.toEqual([]);

        client.close();
    });
});

// --- Optimistic updates -----------------------------------------------------

describe("cirrusClient — optimistic updates", () => {
    test("applies optimistic value immediately and rolls back on error", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "BOOM", message: "fail" } }, { status: 500 }));
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        const received: unknown[] = [];

        client.subscribe(fn("counter:get"), {}, (d) => received.push(d));
        const socket = latestSocket();

        socket.open();

        // Seed the subscriber with a server value.
        const subId = JSON.parse(socket.sent[0]!).id as string;

        socket.receive({ type: "delta", id: subId, delta: 5 });

        expect(received).toEqual([5]);

        await expect(
            client.mutation(
                fn("counter:get"),
                {},
                {
                    optimistic: (current) => {
                        return typeof current === "number" ? current + 1 : 1;
                    },
                },
            ),
        ).rejects.toMatchObject({ message: "fail" });

        // Optimistic value applied, then rolled back.
        expect(received).toEqual([5, 6, 5]);
    });

    test("optimistic value is preserved on success", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ result: { ok: true } }));
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        const received: unknown[] = [];

        client.subscribe(fn("c:get"), {}, (d) => received.push(d));
        latestSocket().open();
        const subId = JSON.parse(latestSocket().sent[0]!).id as string;

        latestSocket().receive({ type: "delta", id: subId, delta: 0 });

        await client.mutation(fn("c:get"), {}, { optimistic: () => 9 });

        expect(received).toEqual([0, 9]);
    });
});

// --- Scheduler admin --------------------------------------------------------

describe("cirrusClient — scheduler admin", () => {
    test("listScheduledJobs GETs the admin endpoint with the bearer and unwraps records", async () => {
        const records = [{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "j1", scheduledFor: 2000 }];
        const fetchMock = vi.fn(async () => jsonResponse({ records }));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        client.setAuthToken("tkn");

        const result = await client.listScheduledJobs();

        expect(result).toEqual(records);

        const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(requestUrl).toBe("https://app.example/_cirrus/admin/scheduled");
        expect(init.method).toBe("GET");
        expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tkn");
    });

    test("listScheduledJobs defaults to an empty array when records are absent", async () => {
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await expect(client.listScheduledJobs()).resolves.toEqual([]);
    });

    test("cancelScheduledJob POSTs the id and normalises the result", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ cancelled: true }));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        const result = await client.cancelScheduledJob("j1");

        expect(result).toEqual({ cancelled: true });

        const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(requestUrl).toBe("https://app.example/_cirrus/admin/scheduled/cancel");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({ id: "j1" });
    });

    test("scheduler admin surfaces the worker error envelope as a coded Error", async () => {
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: (async () => jsonResponse({ error: { code: "ADMIN_FORBIDDEN", message: "nope" } }, { status: 403 })) as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await expect(client.listScheduledJobs()).rejects.toMatchObject({ code: "ADMIN_FORBIDDEN", message: "nope" });
    });
});

// --- Storage admin ----------------------------------------------------------

describe("cirrusClient — storage admin", () => {
    test("listStorageObjects GETs the admin endpoint and unwraps the page", async () => {
        const page = { cursor: "c1", objects: [{ etag: "e1", key: "a.png", size: 10 }] };
        const fetchMock = vi.fn(async () => jsonResponse(page));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        const result = await client.listStorageObjects();

        expect(result).toEqual(page);

        const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(requestUrl).toBe("https://app.example/_cirrus/admin/storage");
        expect(init.method).toBe("GET");
    });

    test("listStorageObjects encodes prefix / cursor / limit as query params", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ objects: [] }));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await client.listStorageObjects({ cursor: "z", limit: 25, prefix: "avatars/" });

        const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
        const parsed = new URL(requestUrl);

        expect(parsed.pathname).toBe("/_cirrus/admin/storage");
        expect(parsed.searchParams.get("prefix")).toBe("avatars/");
        expect(parsed.searchParams.get("cursor")).toBe("z");
        expect(parsed.searchParams.get("limit")).toBe("25");
    });

    test("listStorageObjects defaults objects to an empty array", async () => {
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await expect(client.listStorageObjects()).resolves.toEqual({ cursor: undefined, objects: [] });
    });
});

// --- Functions admin --------------------------------------------------------

describe("cirrusClient — functions admin", () => {
    test("listFunctions GETs the admin endpoint and unwraps the list", async () => {
        const functions = [
            { kind: "query", path: "messages:list" },
            { kind: "mutation", path: "messages:send" },
        ];
        const fetchMock = vi.fn(async () => jsonResponse({ functions }));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await expect(client.listFunctions()).resolves.toEqual(functions);

        const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(requestUrl).toBe("https://app.example/_cirrus/admin/functions");
        expect(init.method).toBe("GET");
    });

    test("listFunctions defaults to an empty array when functions are absent", async () => {
        const client = new CirrusClient({
            url: "https://app.example",
            fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await expect(client.listFunctions()).resolves.toEqual([]);
    });
});

// --- Global (D1) tables admin -----------------------------------------------

describe("cirrusClient — global tables admin", () => {
    test("listGlobalTables GETs the admin endpoint", async () => {
        const tables = [{ name: "organizations", rowCount: 2 }];
        const fetchMock = vi.fn(async () => jsonResponse(tables));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await expect(client.listGlobalTables()).resolves.toEqual(tables);

        const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(requestUrl).toBe("https://app.example/_cirrus/admin/global/tables");
        expect(init.method).toBe("GET");
    });

    test("readGlobalTablePage encodes table / limit / offset as query params", async () => {
        const page = { columns: ["_id"], rows: [{ _id: "o1" }], total: 1 };
        const fetchMock = vi.fn(async () => jsonResponse(page));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await expect(client.readGlobalTablePage({ limit: 10, offset: 5, table: "organizations" })).resolves.toEqual(page);

        const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
        const parsed = new URL(requestUrl);

        expect(parsed.pathname).toBe("/_cirrus/admin/global/table");
        expect(parsed.searchParams.get("table")).toBe("organizations");
        expect(parsed.searchParams.get("limit")).toBe("10");
        expect(parsed.searchParams.get("offset")).toBe("5");
    });
});

describe("cirrusClient — auth admin", () => {
    test("listAuthUsers GETs the users endpoint with paging", async () => {
        const page = { rows: [{ id: "u1" }], total: 1 };
        const fetchMock = vi.fn(async () => jsonResponse(page));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await expect(client.listAuthUsers({ limit: 10, offset: 5 })).resolves.toEqual(page);

        const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
        const parsed = new URL(requestUrl);

        expect(parsed.pathname).toBe("/_cirrus/admin/auth/users");
        expect(parsed.searchParams.get("limit")).toBe("10");
        expect(parsed.searchParams.get("offset")).toBe("5");
    });

    test("listAuthSessions encodes userId + paging", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ rows: [], total: 0 }));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        await client.listAuthSessions({ limit: 20, userId: "u1" });

        const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
        const parsed = new URL(requestUrl);

        expect(parsed.pathname).toBe("/_cirrus/admin/auth/sessions");
        expect(parsed.searchParams.get("userId")).toBe("u1");
        expect(parsed.searchParams.get("limit")).toBe("20");
    });
});
