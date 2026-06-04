import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CirrusClient } from "../src/cirrus-client.js";
import { createInMemoryPersistence } from "../src/persistence.js";
import type { FunctionReference } from "../src/types.js";

const flushMicrotasks = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

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

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor(url: string) {
            this.url = url;
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
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

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
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

const fnRef = (ref: string): FunctionReference => {
    return { __cirrusRef: ref };
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    Response.json(body, {
        headers: { "content-type": "application/json" },
        status: 200,
        ...init,
    });

describe("cirrusClient", () => {
    beforeEach(() => {
        sockets.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // --- RPC --------------------------------------------------------------------

    describe("cirrusClient — queries & mutations", () => {
        it("query roundtrips through POST /_cirrus/rpc and unwraps the result", async () => {
            expect.assertions(5);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { hello: "world" } }));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const value = await client.query(fnRef("posts:list"), { limit: 10 });

            expect(value).toEqual({ hello: "world" });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_cirrus/rpc");
            expect(init.method).toBe("POST");
            expect(JSON.parse(init.body as string)).toEqual({
                args: { limit: 10 },
                functionPath: "posts:list",
                shardKey: undefined,
            });
        });

        it("query surfaces server errors as thrown Error objects", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 }));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.query(fnRef("posts:get"), { id: "abc" })).rejects.toMatchObject({
                code: "NOT_FOUND",
                message: "missing",
            });
        });

        it("mutation captures x-d1-bookmark and replays it on the next query", async () => {
            expect.assertions(1);

            let call = 0;

            const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (_url: string, init: RequestInit) => {
                call += 1;

                if (call === 1) {
                    return Response.json(
                        { result: { ok: true } },
                        {
                            headers: {
                                "content-type": "application/json",
                                "x-d1-bookmark": "bm-123",
                            },
                            status: 200,
                        },
                    );
                }

                // capture headers on the second (query) call
                (fetchMock as unknown as { lastHeaders?: Record<string, string> }).lastHeaders = (init.headers ?? {}) as Record<string, string>;

                return jsonResponse({ result: { rows: [] } });
            });

            const client = new CirrusClient({
                fetch: fetchMock as unknown as typeof fetch,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.mutation(fnRef("posts:create"), { title: "hi" });
            await client.query(fnRef("posts:list"), {});

            const headers = (fetchMock as unknown as { lastHeaders: Record<string, string> }).lastHeaders;

            expect(headers["x-d1-bookmark"]).toBe("bm-123");
        });

        it("authorization header is attached when token is set", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.setAuthToken("tkn");
            await client.query(fnRef("any:thing"), {});

            const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
            const headers = init.headers as Record<string, string>;

            expect(headers.authorization).toBe("Bearer tkn");
            expect(client.getAuthToken()).toBe("tkn");
        });
    });

    // --- Subscriptions ----------------------------------------------------------

    describe("cirrusClient — subscriptions", () => {
        it("subscribe sends a subscribe envelope and delivers delta payloads", async () => {
            expect.assertions(5);

            const fetchMock = vi.fn<typeof fetch>();
            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];
            const unsubscribe = client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            const socket = latestSocket();

            socket.open();

            expect(socket.sent).toHaveLength(1);

            const sub = JSON.parse(socket.sent[0]!);

            expect(sub.type).toBe("subscribe");
            expect(sub.id).toMatch(/^sub_/);

            socket.receive({ id: sub.id, type: "ack" });
            socket.receive({ delta: { count: 1 }, id: sub.id, type: "delta" });
            socket.receive({ data: { count: 2 }, id: sub.id, type: "data" });

            expect(received).toEqual([{ count: 1 }, { count: 2 }]);

            unsubscribe();

            const last = JSON.parse(socket.sent.at(-1)!);

            expect(last).toEqual({ id: sub.id, type: "unsubscribe" });
        });

        it("appends wsToken to the WebSocket URL so the upgrade can authorize it", () => {
            expect.assertions(2);

            const client = new CirrusClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "admin tok/en",
            });

            client.subscribe(fnRef("__cirrus_admin__:getMetrics"), {}, () => undefined);

            const { url } = latestSocket();

            expect(url).toContain("token=admin%20tok%2Fen");
            // The default WS path is still present alongside the token parameter.
            expect(url).toContain("/_cirrus/ws");
        });

        it("surfaces a server subscription error to the onError callback", () => {
            expect.assertions(2);

            const client = new CirrusClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const errors: { message: string }[] = [];
            const data: unknown[] = [];

            client.subscribe(fnRef("__cirrus_admin__:getMetrics"), {}, (d) => data.push(d), { onError: (error) => errors.push(error) });

            const socket = latestSocket();

            socket.open();
            socket.receive({ id: JSON.parse(socket.sent[0]!).id, message: "admin subscription requires admin authorization", type: "error" });

            expect(errors).toEqual([{ message: "admin subscription requires admin authorization" }]);
            expect(data).toHaveLength(0);
        });

        it("re-sends an admin subscription with its token on reconnect", () => {
            expect.assertions(3);

            vi.useFakeTimers();

            const client = new CirrusClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            client.subscribe(fnRef("__cirrus_admin__:getMetrics"), {}, () => undefined);

            const first = latestSocket();

            first.open();
            first.triggerClose();

            vi.advanceTimersByTime(15);

            const second = latestSocket();

            second.open();

            // The fresh socket carries the token again, so the server re-stamps the
            // admin flag and the re-sent subscribe clears the admin gate.
            expect(second).not.toBe(first);
            expect(second.url).toContain("token=adm1n");
            expect(JSON.parse(second.sent[0]!).query.functionPath).toBe("__cirrus_admin__:getMetrics");

            vi.useRealTimers();
        });

        it("on reconnect, all active subscriptions are re-sent", async () => {
            expect.assertions(6);

            vi.useFakeTimers();
            const client = new CirrusClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("a:b"), { x: 1 }, () => undefined);
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

        it("duplicate subscribe calls share a single server-side subscription", () => {
            expect.assertions(5);

            const client = new CirrusClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const aReceived: unknown[] = [];
            const bReceived: unknown[] = [];

            const unsubA = client.subscribe(fnRef("rooms:list"), { roomId: "r1" }, (d) => aReceived.push(d));
            const unsubB = client.subscribe(fnRef("rooms:list"), { roomId: "r1" }, (d) => bReceived.push(d));

            const socket = latestSocket();

            socket.open();

            // Only one subscribe envelope despite two consumers.
            const subs = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "subscribe");

            expect(subs).toHaveLength(1);

            socket.receive({ delta: { v: 42 }, id: subs[0].id, type: "delta" });

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
        it("mutation issued while the socket is offline is queued and replayed on reconnect", async () => {
            expect.assertions(3);

            vi.useFakeTimers();
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { id: "1" } }));
            const client = new CirrusClient({
                fetch: fetchMock,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // First, open a real socket so the client considers itself "online".
            client.subscribe(fnRef("posts:list"), {}, () => undefined);
            const first = latestSocket();

            first.open();

            // Drop the socket — we're now offline.
            first.triggerClose();

            // Mutation while offline should be queued, not sent.
            const pending = client.mutation(fnRef("posts:create"), { title: "queued" });

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
        it("hydrates persisted mutations on construct and flushes them once the socket opens", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const persistence = createInMemoryPersistence();

            // A write durably queued by a prior session (e.g. before a reload).
            await persistence.append({ args: { title: "restored" }, functionPath: "posts:create", id: "m1" });

            const client = new CirrusClient({
                fetch: fetchMock,
                persistence,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // The constructor kicks off async hydration which opens a socket for the
            // restored write's shard. Let that settle, then bring the socket up.
            await flushMicrotasks();
            latestSocket().open();
            await flushMicrotasks();

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

            expect(body).toMatchObject({ args: { title: "restored" }, functionPath: "posts:create" });

            // Removed from durable storage once the server confirmed it.
            await expect(persistence.load()).resolves.toEqual([]);

            client.close();
        });

        it("un-persists a replayed mutation even when the server rejects it", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "BOOM", message: "fail" } }, { status: 500 }));
            const persistence = createInMemoryPersistence();

            await persistence.append({ args: {}, functionPath: "posts:create", id: "m1" });

            const client = new CirrusClient({
                fetch: fetchMock,
                persistence,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
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

        it("a live mutation queued while offline is persisted and removed after replay", async () => {
            expect.assertions(3);

            vi.useFakeTimers();
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { id: "1" } }));
            const persistence = createInMemoryPersistence();
            const client = new CirrusClient({
                fetch: fetchMock,
                persistence,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // Get online, then drop the socket so the next mutation is queued.
            client.subscribe(fnRef("posts:list"), {}, () => undefined);
            latestSocket().open();
            latestSocket().triggerClose();

            const pending = client.mutation(fnRef("posts:create"), { title: "queued" });

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
        it("applies optimistic value immediately and rolls back on error", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "BOOM", message: "fail" } }, { status: 500 }));
            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();

            // Seed the subscriber with a server value.
            const subId = JSON.parse(socket.sent[0]!).id as string;

            socket.receive({ delta: 5, id: subId, type: "delta" });

            expect(received).toEqual([5]);

            await expect(
                client.mutation(
                    fnRef("counter:get"),
                    {},
                    {
                        optimistic: (current) => (typeof current === "number" ? current + 1 : 1),
                    },
                ),
            ).rejects.toMatchObject({ message: "fail" });

            // Optimistic value applied, then rolled back.
            expect(received).toEqual([5, 6, 5]);
        });

        it("optimistic value is preserved on success", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("c:get"), {}, (d) => received.push(d));
            latestSocket().open();
            const subId = JSON.parse(latestSocket().sent[0]!).id as string;

            latestSocket().receive({ delta: 0, id: subId, type: "delta" });

            await client.mutation(fnRef("c:get"), {}, { optimistic: () => 9 });

            expect(received).toEqual([0, 9]);
        });

        it("stacked optimistic mutations: older failing first does not clobber newer pending value", async () => {
            expect.assertions(2);

            // Two outstanding RPCs on the same (fn, args, shard) subscription. The
            // older one (A) rejects first; its rollback must NOT restore the value
            // from before B applied, because B's optimistic value is still pending.
            const deferreds: { reject: (error: unknown) => void; resolve: (value: Response) => void }[] = [];
            const fetchMock = vi.fn<typeof fetch>(
                async () =>
                    new Promise<Response>((resolve, reject) => {
                        deferreds.push({ reject, resolve });
                    }),
            );
            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();
            const subId = JSON.parse(socket.sent[0]!).id as string;

            socket.receive({ delta: 0, id: subId, type: "delta" });

            // A: 0 -> 1, then B: 1 -> 2 (both optimistic, both in-flight).
            const promiseA = client.mutation(fnRef("counter:get"), {}, { optimistic: (c) => (typeof c === "number" ? c + 1 : 1) });
            const promiseB = client.mutation(fnRef("counter:get"), {}, { optimistic: (c) => (typeof c === "number" ? c + 1 : 1) });

            expect(received).toEqual([0, 1, 2]);

            // A fails first. Its rollback must leave B's pending value (2) intact.
            deferreds[0]!.reject(new Error("A failed"));
            await promiseA.catch(() => undefined);

            // Settle B so the test doesn't leak a pending promise.
            deferreds[1]!.resolve(jsonResponse({ result: { ok: true } }));
            await promiseB;

            // The fixed rollback only restores when its own value is still live;
            // B's value (2) survived A's failure.
            expect(received).toEqual([0, 1, 2]);
        });
    });

    // --- Scheduler admin --------------------------------------------------------

    describe("cirrusClient — scheduler admin", () => {
        it("listScheduledJobs GETs the admin endpoint with the bearer and unwraps records", async () => {
            expect.assertions(4);

            const records = [{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "j1", scheduledFor: 2000 }];
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ records }));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
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

        it("listScheduledJobs defaults to an empty array when records are absent", async () => {
            expect.assertions(1);

            const client = new CirrusClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listScheduledJobs()).resolves.toEqual([]);
        });

        it("cancelScheduledJob POSTs the id and normalises the result", async () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ cancelled: true }));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.cancelScheduledJob("j1");

            expect(result).toEqual({ cancelled: true });

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_cirrus/admin/scheduled/cancel");
            expect(init.method).toBe("POST");
            expect(JSON.parse(init.body as string)).toEqual({ id: "j1" });
        });

        it("scheduler admin surfaces the worker error envelope as a coded Error", async () => {
            expect.assertions(1);

            const client = new CirrusClient({
                fetch: async () => jsonResponse({ error: { code: "ADMIN_FORBIDDEN", message: "nope" } }, { status: 403 }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listScheduledJobs()).rejects.toMatchObject({ code: "ADMIN_FORBIDDEN", message: "nope" });
        });
    });

    // --- Storage admin ----------------------------------------------------------

    describe("cirrusClient — storage admin", () => {
        it("listStorageObjects GETs the admin endpoint and unwraps the page", async () => {
            expect.assertions(3);

            const page = { cursor: "c1", objects: [{ etag: "e1", key: "a.png", size: 10 }] };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(page));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.listStorageObjects();

            expect(result).toEqual(page);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_cirrus/admin/storage");
            expect(init.method).toBe("GET");
        });

        it("listStorageObjects encodes prefix / cursor / limit as query params", async () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ objects: [] }));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
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

        it("listStorageObjects defaults objects to an empty array", async () => {
            expect.assertions(1);

            const client = new CirrusClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listStorageObjects()).resolves.toEqual({ cursor: undefined, objects: [] });
        });
    });

    // --- Functions admin --------------------------------------------------------

    describe("cirrusClient — functions admin", () => {
        it("listFunctions GETs the admin endpoint and unwraps the list", async () => {
            expect.assertions(3);

            const functions = [
                { kind: "query", path: "messages:list" },
                { kind: "mutation", path: "messages:send" },
            ];
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ functions }));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listFunctions()).resolves.toEqual(functions);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_cirrus/admin/functions");
            expect(init.method).toBe("GET");
        });

        it("listFunctions defaults to an empty array when functions are absent", async () => {
            expect.assertions(1);

            const client = new CirrusClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listFunctions()).resolves.toEqual([]);
        });
    });

    // --- Global (D1) tables admin -----------------------------------------------

    describe("cirrusClient — global tables admin", () => {
        it("listGlobalTables GETs the admin endpoint", async () => {
            expect.assertions(3);

            const tables = [{ name: "organizations", rowCount: 2 }];
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(tables));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listGlobalTables()).resolves.toEqual(tables);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_cirrus/admin/global/tables");
            expect(init.method).toBe("GET");
        });

        it("readGlobalTablePage encodes table / limit / offset as query params", async () => {
            expect.assertions(5);

            const page = { columns: ["_id"], rows: [{ _id: "o1" }], total: 1 };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(page));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
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
        it("listAuthUsers GETs the users endpoint with paging", async () => {
            expect.assertions(4);

            const page = { rows: [{ id: "u1" }], total: 1 };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(page));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listAuthUsers({ limit: 10, offset: 5 })).resolves.toEqual(page);

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
            const parsed = new URL(requestUrl);

            expect(parsed.pathname).toBe("/_cirrus/admin/auth/users");
            expect(parsed.searchParams.get("limit")).toBe("10");
            expect(parsed.searchParams.get("offset")).toBe("5");
        });

        it("listAuthSessions encodes userId + paging", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ rows: [], total: 0 }));

            const client = new CirrusClient({
                fetch: fetchMock,
                url: "https://app.example",
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

    describe("cirrusClient — connection status", () => {
        it("reports idle before any socket, then connecting/connected/offline across the socket lifecycle", () => {
            expect.assertions(6);

            const client = new CirrusClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const seen: string[] = [];
            const unsubscribe = client.onConnectionStatus((status) => seen.push(status));

            // Fires immediately with the current (idle) status.
            expect(seen).toEqual(["idle"]);
            expect(client.connectionStatus()).toBe("idle");

            // Opening a subscription creates a socket → connecting.
            client.subscribe(fnRef("a:b"), {}, () => undefined);

            expect(client.connectionStatus()).toBe("connecting");

            const socket = latestSocket();

            socket.open();

            expect(client.connectionStatus()).toBe("connected");

            // Drop drops to offline (between reconnect attempts).
            socket.triggerClose();

            expect(client.connectionStatus()).toBe("offline");

            expect(seen).toEqual(["idle", "connecting", "connected", "offline"]);

            unsubscribe();
        });

        it("stops notifying after unsubscribe", () => {
            expect.assertions(1);

            const client = new CirrusClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const seen: string[] = [];
            const unsubscribe = client.onConnectionStatus((status) => seen.push(status));

            unsubscribe();
            client.subscribe(fnRef("a:b"), {}, () => undefined);

            // Only the immediate idle callback landed before unsubscribe.
            expect(seen).toEqual(["idle"]);
        });
    });

    describe("cirrusClient — scheduled-jobs subscription", () => {
        it("opens the scheduler admin WS with the token and delivers pushed job lists", () => {
            expect.assertions(4);

            const client = new CirrusClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const seen: string[][] = [];
            const unsubscribe = client.subscribeScheduledJobs((jobs) => seen.push(jobs.map((job) => job.id)));

            const socket = latestSocket();

            // Connects to the scheduler WS path with the admin token in the query.
            expect(socket.url).toContain("/_cirrus/admin/scheduled/ws");
            expect(socket.url).toContain("token=adm1n");

            socket.open();
            socket.receive({ records: [{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "j1", scheduledFor: 2 }], type: "jobs" });

            expect(seen).toEqual([["j1"]]);

            // A frame of the wrong type is ignored.
            socket.receive({ type: "other" });

            expect(seen).toHaveLength(1);

            unsubscribe();
        });

        it("reconnects after the socket drops", () => {
            expect.assertions(2);

            vi.useFakeTimers();

            const client = new CirrusClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const unsubscribe = client.subscribeScheduledJobs(() => undefined);

            const first = latestSocket();

            first.open();
            first.triggerClose();

            vi.advanceTimersByTime(15);

            const second = latestSocket();

            expect(second).not.toBe(first);
            expect(second.url).toContain("/_cirrus/admin/scheduled/ws");

            unsubscribe();
            vi.useRealTimers();
        });
    });
});
