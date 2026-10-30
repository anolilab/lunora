import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryQueryCache } from "../src/query-cache";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

/** A React Native-style client (bearer on the upgrade) with one open, identified socket. */
const openClient = async (reauthStatus: number, reauthBody?: unknown, hang = false, shardKey?: string) => {
    const { sockets, WebSocket } = createSocketHarness();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        if (!(input as string).includes("/_lunora/ws/reauth")) {
            return jsonResponse({ result: { ok: true } });
        }

        if (hang) {
            // A worker or proxy that never answers: only the client's own deadline ends the wait.
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(new Error("aborted"));
                });
            });
        }

        return jsonResponse(reauthBody ?? { ok: reauthStatus === 200 }, { status: reauthStatus });
    });
    const client = new LunoraClient({
        authTokenOnUpgrade: true,
        fetch: fetchMock,
        heartbeatIntervalMs: 0,
        reconnect: { initialDelayMs: 0, jitter: false, maxDelayMs: 0 },
        url: "http://app.test",
        WebSocket,
    });

    client.setAuthToken("token-1", "user-1");
    client.subscribe(fnRef("todos.list"), {}, () => undefined, shardKey === undefined ? {} : { shardKey });
    await settle();
    sockets[0]?.open();
    sockets[0]?.receive({ connectionId: "conn-1", subject: "user-1", type: "identity" });
    await settle();

    const reauthCalls = () => fetchMock.mock.calls.filter(([input]) => (input as string).includes("/_lunora/ws/reauth"));

    return { client, reauthCalls, sockets };
};

describe("socket re-authentication on a token refresh", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("hands the refreshed bearer to the open socket instead of reconnecting it", async () => {
        expect.assertions(5);

        const { client, reauthCalls, sockets } = await openClient(200);

        client.setAuthToken("token-2", "user-1");
        await settle();

        const [url, init] = reauthCalls()[0] ?? [];

        expect(reauthCalls()).toHaveLength(1);
        expect(url).toBe("http://app.test/_lunora/ws/reauth");
        expect(init?.body).toBe(JSON.stringify({ connectionId: "conn-1" }));
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer token-2");
        // The socket and its subscriptions stay as they are.
        expect(sockets[0]?.readyState).toBe(1);

        client.close();
    });

    it("reconnects the socket, as before, when the server refuses the refresh", async () => {
        expect.assertions(4);

        const { client, reauthCalls, sockets } = await openClient(409);

        client.setAuthToken("token-2", "user-1");
        await settle();

        expect(reauthCalls()).toHaveLength(1);
        expect(sockets[0]?.readyState).toBe(3);

        // The browser's `close` event, then the replacement socket replays the subscription.
        sockets[0]?.triggerClose();
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        sockets[1]?.open();
        await settle();

        expect(sockets).toHaveLength(2);
        expect((sockets[1]?.frames() ?? []).some((frame) => frame.type === "subscribe")).toBe(true);

        client.close();
    });

    it("counts only the route's own ok body, not any 200, as a refreshed socket", async () => {
        expect.assertions(1);

        // A catch-all (an SPA fallback, a proxy) answering 200 with something else.
        const { client, sockets } = await openClient(200, { html: true });

        client.setAuthToken("token-2", "user-1");
        await settle();

        expect(sockets[0]?.readyState).toBe(3);

        client.close();
    });

    it("falls back to a reconnect when the refresh never answers", async () => {
        expect.assertions(2);

        const { client, sockets } = await openClient(200, undefined, true);

        client.setAuthToken("token-2", "user-1");
        await settle();

        expect(sockets[0]?.readyState).toBe(1);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(sockets[0]?.readyState).toBe(3);

        client.close();
    });

    it("names an explicit empty shard key, as the socket's own upgrade did", async () => {
        expect.assertions(1);

        const { client, reauthCalls } = await openClient(200, undefined, false, "");

        client.setAuthToken("token-2", "user-1");
        await settle();

        expect(reauthCalls()[0]?.[0]).toBe("http://app.test/_lunora/ws/reauth?shard=");

        client.close();
    });
});

/** A client with one open socket whose identity frame announces `revalidateMs`; `token` is `undefined` for a cookie session. */
const openRevalidatingClient = async ({ reauthOk = true, revalidateMs, token }: { reauthOk?: boolean; revalidateMs?: number; token?: string }) => {
    const { sockets, WebSocket } = createSocketHarness();
    const reauthResponse = reauthOk ? jsonResponse({ ok: true }) : jsonResponse({ error: { code: "IDENTITY_CHANGED" } }, { status: 409 });
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
        (input as string).includes("/_lunora/ws/reauth") ? reauthResponse.clone() : jsonResponse({ result: { ok: true } }),
    );
    const client = new LunoraClient({
        authTokenOnUpgrade: true,
        fetch: fetchMock,
        heartbeatIntervalMs: 0,
        reconnect: { initialDelayMs: 0, jitter: false, maxDelayMs: 0 },
        url: "http://app.test",
        WebSocket,
    });

    if (token !== undefined) {
        client.setAuthToken(token, "user-1");
    }

    client.subscribe(fnRef("todos.list"), {}, () => undefined);
    await settle();
    sockets[0]?.open();
    sockets[0]?.receive({ connectionId: "conn-1", ...(revalidateMs === undefined ? {} : { revalidateMs }), subject: "user-1", type: "identity" });
    await settle();

    const reauthCalls = () => fetchMock.mock.calls.filter(([input]) => (input as string).includes("/_lunora/ws/reauth"));

    return { client, reauthCalls, sockets };
};

describe("socket identity revalidation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("re-auths the socket in place within the window its identity frame announces, and again after each success", async () => {
        expect.assertions(4);

        const { client, reauthCalls, sockets } = await openRevalidatingClient({ revalidateMs: 60_000, token: "token-1" });

        await vi.advanceTimersByTimeAsync(29_999);

        expect(reauthCalls()).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1);

        expect((reauthCalls()[0]?.[1]?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer token-1");

        await vi.advanceTimersByTimeAsync(30_000);

        expect(reauthCalls()).toHaveLength(2);
        expect(sockets[0]?.readyState).toBe(1);

        client.close();
    });

    it("keeps the re-auth on schedule when the same socket's identity is re-sent", async () => {
        expect.assertions(1);

        const { client, reauthCalls, sockets } = await openRevalidatingClient({ revalidateMs: 60_000, token: "token-1" });

        // A context update re-sends `connect`, and the server answers each with the same socket's identity.
        await vi.advanceTimersByTimeAsync(20_000);
        sockets[0]?.receive({ connectionId: "conn-1", revalidateMs: 60_000, subject: "user-1", type: "identity" });
        await vi.advanceTimersByTimeAsync(10_000);

        expect(reauthCalls()).toHaveLength(1);

        client.close();
    });

    it("does not start a second re-auth when the identity is re-sent while one is still in flight", async () => {
        expect.assertions(2);

        const { sockets, WebSocket } = createSocketHarness();
        const fetchMock = vi.fn<typeof fetch>(async (input) =>
            (input as string).includes("/_lunora/ws/reauth")
                ? new Promise<Response>(() => {
                      // Never answers: the request stays in flight.
                  })
                : jsonResponse({ result: { ok: true } }),
        );
        const client = new LunoraClient({
            authTokenOnUpgrade: true,
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            url: "http://app.test",
            WebSocket,
        });

        client.setAuthToken("token-1", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        sockets[0]?.receive({ connectionId: "conn-1", revalidateMs: 60_000, subject: "user-1", type: "identity" });
        await vi.advanceTimersByTimeAsync(30_000);
        sockets[0]?.receive({ connectionId: "conn-1", revalidateMs: 60_000, subject: "user-1", type: "identity" });
        await vi.advanceTimersByTimeAsync(30_000);

        const calls = () => fetchMock.mock.calls.filter(([input]) => (input as string).includes("/_lunora/ws/reauth"));

        expect(calls()).toHaveLength(1);
        expect(sockets[0]?.readyState).toBe(1);

        client.close();
    });

    it("keeps the socket when an earlier re-auth is refused after a later one succeeded", async () => {
        expect.assertions(2);

        const { sockets, WebSocket } = createSocketHarness();
        const answers: ((response: Response) => void)[] = [];
        const fetchMock = vi.fn<typeof fetch>(async (input) =>
            (input as string).includes("/_lunora/ws/reauth")
                ? new Promise<Response>((resolve) => {
                      answers.push(resolve);
                  })
                : jsonResponse({ result: { ok: true } }),
        );
        const client = new LunoraClient({
            authTokenOnUpgrade: true,
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            url: "http://app.test",
            WebSocket,
        });

        client.setAuthToken("token-1", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        sockets[0]?.receive({ connectionId: "conn-1", revalidateMs: 60_000, subject: "user-1", type: "identity" });
        await settle();

        // Three requests for one socket, all under a token that is in force again by the time they answer.
        await vi.advanceTimersByTimeAsync(30_000);
        client.setAuthToken("token-2", "user-1");
        await settle();
        client.setAuthToken("token-1", "user-1");
        await settle();

        expect(answers).toHaveLength(3);

        // The newest succeeds first; the earliest is refused afterwards.
        answers[2]?.(jsonResponse({ ok: true }));
        await settle();
        answers[0]?.(jsonResponse({ error: { code: "STALE_CREDENTIAL" } }, { status: 409 }));
        await settle();

        expect(sockets[0]?.readyState).toBe(1);

        client.close();
    });

    it("keeps re-authing a cookie socket whose request was in flight when the client's bearer was refreshed", async () => {
        expect.assertions(2);

        const { sockets, WebSocket } = createSocketHarness();
        const answers: ((response: Response) => void)[] = [];
        const fetchMock = vi.fn<typeof fetch>(async (input) =>
            (input as string).includes("/_lunora/ws/reauth")
                ? new Promise<Response>((resolve) => {
                      answers.push(resolve);
                  })
                : jsonResponse({ result: { ok: true } }),
        );
        // No `authTokenOnUpgrade`: the socket's credential is the cookie, whatever bearer the client holds.
        const client = new LunoraClient({ fetch: fetchMock, heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        sockets[0]?.receive({ connectionId: "conn-1", revalidateMs: 60_000, subject: "user-1", type: "identity" });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(answers).toHaveLength(1);

        client.setAuthToken("token-later", "user-1");
        await settle();
        answers[0]?.(jsonResponse({ ok: true }));
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(answers).toHaveLength(2);

        client.close();
    });

    it("does not let the periodic timer fire over a refresh already in flight for the socket", async () => {
        expect.assertions(2);

        const { sockets, WebSocket } = createSocketHarness();
        const answers: ((response: Response) => void)[] = [];
        const fetchMock = vi.fn<typeof fetch>(async (input) =>
            (input as string).includes("/_lunora/ws/reauth")
                ? new Promise<Response>((resolve) => {
                      answers.push(resolve);
                  })
                : jsonResponse({ result: { ok: true } }),
        );
        const client = new LunoraClient({ authTokenOnUpgrade: true, fetch: fetchMock, heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });

        client.setAuthToken("token-1", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        sockets[0]?.receive({ connectionId: "conn-1", revalidateMs: 60_000, subject: "user-1", type: "identity" });
        await settle();

        // A refreshed bearer is handed to the socket just before the timer is due.
        await vi.advanceTimersByTimeAsync(29_000);
        client.setAuthToken("token-2", "user-1");
        await vi.advanceTimersByTimeAsync(2000);

        // The timer's request would present the handshake bearer, which the server refuses as older.
        expect(answers).toHaveLength(1);

        answers[0]?.(jsonResponse({ ok: true }));
        await settle();

        expect(sockets[0]?.readyState).toBe(1);

        client.close();
    });

    it("presents the cookie session alone when the socket has no bearer", async () => {
        expect.assertions(2);

        const { client, reauthCalls } = await openRevalidatingClient({ revalidateMs: 60_000 });

        await vi.advanceTimersByTimeAsync(30_000);

        expect(reauthCalls()).toHaveLength(1);
        expect(reauthCalls()[0]?.[1]?.headers).not.toHaveProperty("authorization");

        client.close();
    });

    it("keeps presenting the cookie a socket upgraded with after the client is handed a bearer for the same subject", async () => {
        expect.assertions(3);

        const { client, reauthCalls, sockets } = await openRevalidatingClient({ revalidateMs: 60_000 });

        client.setAuthToken("token-later", "user-1");
        await settle();

        // The socket stays open: nothing about its identity changed.
        expect(sockets).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(30_000);

        expect(reauthCalls()).toHaveLength(1);
        expect(reauthCalls()[0]?.[1]?.headers).not.toHaveProperty("authorization");

        client.close();
    });

    it("reconnects the socket when the server will not revalidate it", async () => {
        expect.assertions(1);

        const { client, sockets } = await openRevalidatingClient({ reauthOk: false, revalidateMs: 60_000, token: "token-1" });

        await vi.advanceTimersByTimeAsync(30_000);

        expect(sockets[0]?.readyState).toBe(3);

        client.close();
    });

    it("re-seeds cold when the server reports the socket's claims changed, so no old-tenant row is resumed from", async () => {
        expect.assertions(3);

        const { client, sockets } = await openRevalidatingClient({ reauthOk: false, revalidateMs: 60_000, token: "token-1" });

        const subscribe = (sockets[0]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { id: string } | undefined;

        sockets[0]?.receive({ cursor: 7, epoch: "e1", id: subscribe?.id, type: "data", data: ["org-a row"] });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(sockets[0]?.readyState).toBe(3);

        sockets[0]?.triggerClose();
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        sockets[1]?.open();
        await settle();

        const resubscribe = (sockets[1]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { query?: Record<string, unknown> } | undefined;

        expect(resubscribe?.query).toBeDefined();
        expect(resubscribe?.query).not.toHaveProperty("sinceSeq");

        client.close();
    });

    it("never re-auths a socket whose server announced no window", async () => {
        expect.assertions(1);

        const { client, reauthCalls } = await openRevalidatingClient({ token: "token-1" });

        await vi.advanceTimersByTimeAsync(300_000);

        expect(reauthCalls()).toHaveLength(0);

        client.close();
    });
});

/** A client with an open, identified socket per shard in `shardKeys`, whose re-auth answers `IDENTITY_CHANGED` once `release` is called. */
const openChangedClaimsClient = async (shardKeys: string[]) => {
    const { sockets, WebSocket } = createSocketHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
        if (!(input as string).includes("/_lunora/ws/reauth")) {
            return jsonResponse({ result: { ok: true } });
        }

        await gate;

        return jsonResponse({ error: { code: "IDENTITY_CHANGED" } }, { status: 409 });
    });
    const client = new LunoraClient({
        authTokenOnUpgrade: true,
        fetch: fetchMock,
        heartbeatIntervalMs: 0,
        reconnect: { initialDelayMs: 0, jitter: false, maxDelayMs: 0 },
        url: "http://app.test",
        WebSocket,
    });
    let changes = 0;

    client.onIdentityChange(() => {
        changes += 1;
    });
    client.setAuthToken("token-1", "user-1");

    for (const shardKey of shardKeys) {
        client.subscribe(fnRef("todos.list"), {}, () => undefined, { shardKey });
    }

    await settle();

    for (const [index] of shardKeys.entries()) {
        sockets[index]?.open();
        sockets[index]?.receive({ connectionId: `conn-${String(index)}`, revalidateMs: 60_000, subject: "user-1", type: "identity" });
    }

    await settle();

    return { changes: () => changes, client, release, sockets };
};

describe("socket claims change", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("re-seeds cold when the 4005 close arrives before the 409, which is then discarded", async () => {
        expect.assertions(3);

        const { changes, client, release, sockets } = await openChangedClaimsClient([""]);
        const subscribe = (sockets[0]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { id: string } | undefined;

        sockets[0]?.receive({ cursor: 7, epoch: "e1", id: subscribe?.id, type: "data", data: ["org-a row"] });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);

        // The shard closes the socket before it answers the request.
        sockets[0]?.triggerClose({ code: 4005, reason: "identity_changed" });
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        release();
        await settle();
        sockets[1]?.open();
        await settle();

        const resubscribe = (sockets[1]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { query?: Record<string, unknown> } | undefined;

        expect(resubscribe?.query).toBeDefined();
        expect(resubscribe?.query).not.toHaveProperty("sinceSeq");
        expect(changes()).toBe(1);

        client.close();
    });

    it("announces one identity change when two shards' sockets report the same claims change", async () => {
        expect.assertions(1);

        const { changes, client, release } = await openChangedClaimsClient(["a", "b"]);

        await vi.advanceTimersByTimeAsync(30_000);
        release();
        await settle();

        expect(changes()).toBe(1);

        client.close();
    });
});

describe("socket claims change and the read cache", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("drops the durable and pending read cache when the claims change, so nothing read under the old ones can seed a later session", async () => {
        expect.assertions(3);

        const { sockets, WebSocket } = createSocketHarness();
        const cache = createInMemoryQueryCache();
        const fetchMock = vi.fn<typeof fetch>(async (input) =>
            (input as string).includes("/_lunora/ws/reauth")
                ? jsonResponse({ error: { code: "IDENTITY_CHANGED" } }, { status: 409 })
                : jsonResponse({ result: { ok: true } }),
        );
        const client = new LunoraClient({
            authTokenOnUpgrade: true,
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            queryCache: cache,
            reconnect: { initialDelayMs: 0, jitter: false, maxDelayMs: 0 },
            url: "http://app.test",
            WebSocket,
        });

        client.setAuthToken("token-1", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        sockets[0]?.receive({ connectionId: "conn-1", revalidateMs: 60_000, subject: "user-1", type: "identity" });
        await settle();

        const subscribe = (sockets[0]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { id: string } | undefined;

        sockets[0]?.receive({ cursor: 7, epoch: "e1", id: subscribe?.id, type: "data", data: ["org-a row"] });
        // Flushed to the durable cache, then a second value still waiting in the write batch when the claims change.
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(29_000 - 100);
        sockets[0]?.receive({ cursor: 8, epoch: "e1", id: subscribe?.id, type: "data", data: ["org-a row", "org-a row 2"] });
        await vi.advanceTimersByTimeAsync(100);
        await settle();

        expect(sockets[0]?.readyState).toBe(3);
        await expect(cache.load()).resolves.toHaveLength(0);

        // Nothing is left to flush later either.
        await vi.advanceTimersByTimeAsync(1000);

        await expect(cache.load()).resolves.toHaveLength(0);

        client.close();
    });
});

describe("resume claims fingerprint", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const open = async (announce: boolean) => {
        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 0, jitter: false, maxDelayMs: 0 },
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        sockets[0]?.receive({ ...(announce ? { claims: "fp-A" } : {}), connectionId: "conn-1", subject: null, type: "identity" });
        await settle();

        const subscribe = (sockets[0]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { id: string } | undefined;

        sockets[0]?.receive({ cursor: 7, epoch: "e1", id: subscribe?.id, type: "data", data: ["row"] });
        await settle();

        const reconnect = async () => {
            sockets[0]?.triggerClose();
            await vi.advanceTimersByTimeAsync(0);
            await settle();
            sockets[1]?.open();
            await settle();

            return (sockets[1]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { query?: Record<string, unknown> } | undefined;
        };

        return { client, reconnect, sockets };
    };

    it("sends back the fingerprint the cursor was read under, not the one the new socket will announce", async () => {
        expect.assertions(2);

        const { client, reconnect } = await open(true);
        const resubscribe = await reconnect();

        expect(resubscribe?.query?.["sinceSeq"]).toBe(7);
        expect(resubscribe?.query?.["sinceClaims"]).toBe("fp-A");

        client.close();
    });

    it("sends no fingerprint when the server announced none, which the server takes as a cold seed", async () => {
        expect.assertions(1);

        const { client, reconnect } = await open(false);
        const resubscribe = await reconnect();

        expect(resubscribe?.query).not.toHaveProperty("sinceClaims");

        client.close();
    });

    it("keeps the fingerprint with a value restored from the durable cache", async () => {
        expect.assertions(1);

        const { sockets, WebSocket } = createSocketHarness();
        const cache = createInMemoryQueryCache();
        const make = () =>
            new LunoraClient({
                fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
                heartbeatIntervalMs: 0,
                hydrateOnStart: true,
                queryCache: cache,
                url: "http://app.test",
                WebSocket,
            });
        const first = make();

        first.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        sockets[0]?.receive({ claims: "fp-A", connectionId: "conn-1", subject: null, type: "identity" });
        await settle();

        const subscribe = (sockets[0]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { id: string } | undefined;

        sockets[0]?.receive({ cursor: 7, epoch: "e1", id: subscribe?.id, type: "data", data: ["row"] });
        await vi.advanceTimersByTimeAsync(1000);
        first.close();

        // A reload: a new client restores the cached value and cursor.
        const second = make();

        await settle();
        second.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets.at(-1)?.open();
        await settle();

        const resubscribe = (sockets.at(-1)?.frames() ?? []).find((frame) => frame.type === "subscribe") as { query?: Record<string, unknown> } | undefined;

        expect(resubscribe?.query).toMatchObject({ sinceClaims: "fp-A", sinceSeq: 7 });

        second.close();
    });
});

describe("claims change and the durable read cache", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** A cache adapter whose `load` and `clear` the test releases, recording the order of every operation. */
    const gatedCache = () => {
        const inner = createInMemoryQueryCache();
        const log: string[] = [];
        let releaseLoad: (entries: Awaited<ReturnType<typeof inner.load>>) => void = () => undefined;
        let releaseClear: () => void = () => undefined;
        const loadGate = new Promise<Awaited<ReturnType<typeof inner.load>>>((resolve) => {
            releaseLoad = resolve;
        });
        const clearGate = new Promise<void>((resolve) => {
            releaseClear = resolve;
        });
        const cache = {
            ...inner,
            clear: async () => {
                log.push("clear:start");
                await clearGate;
                await inner.clear();
                log.push("clear:end");
            },
            load: () => loadGate,
            put: async (key: string, entry: Parameters<typeof inner.put>[1]) => {
                log.push(`put:${key}`);
                await inner.put(key, entry);
            },
        };

        return { cache, inner, log, releaseClear, releaseLoad };
    };

    const openChanging = async (cache: ReturnType<typeof gatedCache>["cache"]) => {
        const { sockets, WebSocket } = createSocketHarness();
        const fetchMock = vi.fn<typeof fetch>(async (input) =>
            (input as string).includes("/_lunora/ws/reauth")
                ? jsonResponse({ error: { code: "IDENTITY_CHANGED" } }, { status: 409 })
                : jsonResponse({ result: { ok: true } }),
        );
        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            hydrateOnStart: true,
            queryCache: cache,
            reconnect: { initialDelayMs: 0, jitter: false, maxDelayMs: 0 },
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        sockets[0]?.receive({ claims: "fp-A", connectionId: "conn-1", revalidateMs: 60_000, subject: null, type: "identity" });
        await settle();

        return { client, sockets };
    };

    it("discards a cache load that finishes after the claims changed, so old-claims rows never seed a subscription", async () => {
        expect.assertions(1);

        const { cache, releaseLoad } = gatedCache();
        const { client, sockets } = await openChanging(cache);

        // The claims change while the load is still pending.
        await vi.advanceTimersByTimeAsync(30_000);
        sockets[0]?.triggerClose();
        await vi.advanceTimersByTimeAsync(0);
        releaseLoad([{ identity: null, key: "todos.list::{}::", serverCursor: 7, serverEpoch: "e1", ts: Date.now(), value: ["org-a row"] }]);
        await settle();
        sockets[1]?.open();
        await settle();

        const resubscribe = (sockets[1]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { query?: Record<string, unknown> } | undefined;

        // Seeded from the old entry it would resume from cursor 7.
        expect(resubscribe?.query).not.toHaveProperty("sinceSeq");

        client.close();
    });

    it("writes a new-claims value only after the clear has finished, so the clear cannot erase it", async () => {
        expect.assertions(3);

        const { cache, inner, log, releaseClear, releaseLoad } = gatedCache();
        const { client, sockets } = await openChanging(cache);

        releaseLoad([]);
        await vi.advanceTimersByTimeAsync(30_000);
        sockets[0]?.triggerClose();
        await vi.advanceTimersByTimeAsync(0);

        expect(log).toStrictEqual(["clear:start"]);

        // The reconnected socket delivers a value under the new claims while the clear is still running.
        sockets[1]?.open();
        sockets[1]?.receive({ claims: "fp-B", connectionId: "conn-2", subject: null, type: "identity" });
        await settle();

        const subscribe = (sockets[1]?.frames() ?? []).find((frame) => frame.type === "subscribe") as { id: string } | undefined;

        sockets[1]?.receive({ cursor: 9, epoch: "e1", id: subscribe?.id, type: "data", data: ["org-b row"] });
        await vi.advanceTimersByTimeAsync(1000);
        releaseClear();
        await vi.advanceTimersByTimeAsync(1000);

        expect(log.indexOf("clear:end")).toBeLessThan(log.findIndex((entry) => entry.startsWith("put:")));
        await expect(inner.load()).resolves.toHaveLength(1);

        client.close();
    });
});
