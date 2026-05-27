import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CirrusClient } from "../src/CirrusClient.js";
import type { FunctionReference } from "../src/types.js";

// --- Test doubles -----------------------------------------------------------

interface MockSocket {
    url: string;
    readyState: number;
    sent: string[];
    onopen?: ((event?: unknown) => void) | null;
    onmessage?: ((event: { data: unknown }) => void) | null;
    onclose?: ((event?: unknown) => void) | null;
    onerror?: ((event?: unknown) => void) | null;
    open: () => void;
    receive: (payload: unknown) => void;
    triggerClose: () => void;
    close: () => void;
    send: (data: string) => void;
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

        public constructor(url: string) {
            this.url = url;
            sockets.push(this as unknown as MockSocket);
        }

        public open(): void {
            this.readyState = 1;
            this.onopen?.();
        }

        public receive(payload: unknown): void {
            const data = typeof payload === "string" ? payload : JSON.stringify(payload);

            this.onmessage?.({ data });
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.onclose?.();
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
    return new Response(JSON.stringify(body), {
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

describe("CirrusClient — queries & mutations", () => {
    test("query roundtrips through POST /_cirrus/rpc and unwraps the result", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ result: { hello: "world" } }));

        const client = new CirrusClient({
            url: "https://app.example",
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: createMockWebSocket(),
        });

        const value = await client.query(fn("posts:list"), { limit: 10 });

        expect(value).toEqual({ hello: "world" });
        expect(fetchMock).toHaveBeenCalledOnce();
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
                return new Response(JSON.stringify({ result: { ok: true } }), {
                    status: 200,
                    headers: {
                        "content-type": "application/json",
                        "x-d1-bookmark": "bm-123",
                    },
                });
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

    test("Authorization header is attached when token is set", async () => {
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

describe("CirrusClient — subscriptions", () => {
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

describe("CirrusClient — offline queue", () => {
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
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});

// --- Optimistic updates -----------------------------------------------------

describe("CirrusClient — optimistic updates", () => {
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
            client.mutation(fn("counter:get"), {}, {
                optimistic: (current) => (typeof current === "number" ? current + 1 : 1),
            }),
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
