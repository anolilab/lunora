import { describe, expect, it, vi } from "vitest";

import { decodeIdentityHeader } from "../../../shared/identity-header";
import { getIdentityStore } from "../src/auth";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { FunctionReference } from "../src/types";

/**
 * Identity transitions under a cookie session.
 *
 * A cookie session holds no token, so nothing on the client changes when the
 * user signs out or someone else signs in. The client only knows who it is
 * talking to when the server says so: the `/get-session` probe, and the
 * `identity` frame a shard sends on every socket open. Each transition —
 * `A → nobody`, `nobody → B`, `A → B` — must retire the previous user's
 * session, and a first resolution after page load must not.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });
    }
};

interface MockSocket {
    closed: boolean;
    /** The server side drops the socket. */
    drop: () => void;
    open: () => void;
    receive: (payload: unknown) => void;
    sent: Record<string, unknown>[];
}

const createMockWebSocket = (sockets: MockSocket[]): typeof WebSocket => {
    class WS {
        public readyState = 0;

        private readonly sent: Record<string, unknown>[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        private readonly record: MockSocket;

        public constructor() {
            this.record = {
                closed: false,
                drop: () => {
                    this.close();
                },
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                receive: (payload: unknown) => {
                    this.emit("message", { data: JSON.stringify(payload) });
                },
                sent: this.sent,
            };
            sockets.push(this.record);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public close(): void {
            this.readyState = 3;
            this.record.closed = true;
            this.emit("close", { code: 1000 });
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        public send(raw: string): void {
            this.sent.push(JSON.parse(raw) as Record<string, unknown>);
        }

        private emit(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

interface Applied {
    asUser: null | string;
    functionPath: string;
}

/**
 * A server whose cookie jar the test flips. `/get-session` answers with the
 * current user; every RPC runs as that user — unless the request names the
 * subject it expects and the cookie resolves someone else, which is refused.
 */
const createCookieServer = (initialUser: null | string) => {
    const state = { user: initialUser };
    const applied: Applied[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes("get-session")) {
            return Response.json(state.user === null ? {} : { user: { id: state.user } });
        }

        const expected = new Headers(init?.headers).get("x-lunora-expect-subject");

        if (expected !== null) {
            const subject = decodeIdentityHeader(expected)?.subject;

            if (subject !== state.user) {
                return Response.json({ error: { code: "IDENTITY_MISMATCH", message: "session changed" } }, { status: 409 });
            }
        }

        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { calls?: { functionPath: string; id: number }[]; functionPath?: string };

        if (body.calls !== undefined) {
            for (const call of body.calls) {
                applied.push({ asUser: state.user, functionPath: call.functionPath });
            }

            return Response.json({
                results: body.calls.map((call) => {
                    return { body: { result: { ok: true } }, id: call.id, status: 200 };
                }),
            });
        }

        applied.push({ asUser: state.user, functionPath: body.functionPath ?? "" });

        return Response.json({ result: { ok: true } });
    });

    return { applied, fetchImpl, state };
};

const FAST_RECONNECT = { initialDelayMs: 1, jitter: false, maxDelayMs: 1 } as const;

/** A cookie-session client with one live query answered by the newest socket. */
const liveClient = async (initialUser: null | string) => {
    const sockets: MockSocket[] = [];
    const server = createCookieServer(initialUser);
    const client = new LunoraClient({
        fetch: server.fetchImpl,
        heartbeatIntervalMs: 0,
        reconnect: FAST_RECONNECT,
        url: "http://app.test",
        WebSocket: createMockWebSocket(sockets),
    });
    const values: unknown[] = [];
    let identityChanges = 0;

    client.onIdentityChange(() => {
        identityChanges += 1;
    });
    getIdentityStore(client).subscribe(() => undefined);
    client.subscribe(fnRef("notes:mine"), {}, (value) => values.push(value));
    await settle();

    const socket = sockets.at(-1);

    socket?.open();
    await settle();

    for (const frame of socket?.sent ?? []) {
        if (frame.type === "subscribe") {
            socket?.receive({ cursor: 1, data: [{ _id: "n1", owner: initialUser }], id: frame.id, type: "data" });
        }
    }

    await settle();

    return {
        client,
        identityChanges: () => identityChanges,
        server,
        sockets,
        values,
    };
};

describe("cookie session: the server's answer drives every transition", () => {
    it("a → nobody: sign-out blanks the live query, closes the socket and fires onIdentityChange", async () => {
        expect.assertions(5);

        const { client, identityChanges, server, sockets, values } = await liveClient("user-a");

        expect(client.currentIdentity()).toBe("subj:user-a");

        server.state.user = null;
        await client.getCurrentUser();
        await settle();

        expect(client.currentIdentity()).toBeNull();
        expect(identityChanges()).toBe(1);
        expect(values.at(-1)).toBeUndefined();
        expect(sockets[0]?.closed).toBe(true);

        client.close();
    });

    it("nobody → b: a sign-in after a resolved sign-out retires the anonymous session", async () => {
        expect.assertions(5);

        const { client, identityChanges, server, sockets, values } = await liveClient(null);

        expect(identityChanges()).toBe(0);

        server.state.user = "user-b";
        await client.getCurrentUser();
        await settle();

        expect(client.currentIdentity()).toBe("subj:user-b");
        expect(identityChanges()).toBe(1);
        expect(sockets[0]?.closed).toBe(true);
        expect(values.at(-1)).toBeUndefined();

        client.close();
    });

    it("a → nobody: a `401` from `/get-session` is a sign-out too", async () => {
        expect.assertions(2);

        const { client, identityChanges, server } = await liveClient("user-a");

        server.fetchImpl.mockImplementation(async (input: unknown) =>
            String(input).includes("get-session") ? Response.json({ message: "unauthorized" }, { status: 401 }) : Response.json({ result: { ok: true } }),
        );
        await client.getCurrentUser();
        await settle();

        expect(client.currentIdentity()).toBeNull();
        expect(identityChanges()).toBe(1);

        client.close();
    });

    it("a bearer token set after a resolved sign-out is the identity, not `nobody`", async () => {
        expect.assertions(2);

        const { client } = await liveClient(null);

        expect(client.currentIdentity()).toBeNull();

        client.setAuthToken("tok-b");

        expect(client.currentIdentity()).toMatch(/^[\da-z]+:[\da-z]+:[\da-z]+$/u);

        client.close();
    });

    it("unknown → a: the first resolution after page load keeps the rows it already shows", async () => {
        expect.assertions(4);

        const { client, identityChanges, sockets, values } = await liveClient("user-a");

        expect(client.currentIdentity()).toBe("subj:user-a");
        expect(identityChanges()).toBe(0);
        expect(values.at(-1)).toStrictEqual([{ _id: "n1", owner: "user-a" }]);
        expect(sockets[0]?.closed).toBe(false);

        client.close();
    });

    it("a reconnect whose `identity` frame names nobody retires the previous user's session", async () => {
        expect.assertions(4);

        const { client, identityChanges, server, sockets, values } = await liveClient("user-a");

        // A signs out; the socket drops and comes back on the cleared cookie.
        server.state.user = null;
        sockets[0]?.drop();
        await settle();

        const second = sockets.at(-1);

        second?.open();
        await settle();
        second?.receive({ subject: null, type: "identity" });
        await settle();

        expect(client.currentIdentity()).toBeNull();
        expect(identityChanges()).toBe(1);
        expect(values.at(-1)).toBeUndefined();
        expect(second?.closed).toBe(true);

        client.close();
    });

    it("an `identity` frame older than the answer in force replaces its socket but keeps the identity", async () => {
        expect.assertions(3);

        const { client, identityChanges, server, sockets } = await liveClient("user-a");

        // The socket was upgraded before the probe below asked; the probe's
        // answer is the newer one and stands.
        server.state.user = "user-a";
        await client.getCurrentUser();
        sockets[0]?.receive({ subject: "user-b", type: "identity" });
        await settle();

        expect(client.currentIdentity()).toBe("subj:user-a");
        expect(identityChanges()).toBe(1);
        expect(sockets[0]?.closed).toBe(true);

        client.close();
    });

    it("an `identity` frame on the first socket names the session without evicting it", async () => {
        expect.assertions(3);

        const sockets: MockSocket[] = [];
        // `/get-session` never answers, so only the frame can settle the identity.
        const fetchImpl = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
        const client = new LunoraClient({ fetch: fetchImpl, heartbeatIntervalMs: 0, url: "http://app.test", WebSocket: createMockWebSocket(sockets) });
        let identityChanges = 0;

        client.onIdentityChange(() => {
            identityChanges += 1;
        });
        client.expectIdentityResolution();
        client.subscribe(fnRef("notes:mine"), {}, () => {});
        await settle();
        sockets[0]?.open();
        await settle();
        sockets[0]?.receive({ subject: "user-a", type: "identity" });
        await settle();

        expect(client.currentIdentity()).toBe("subj:user-a");
        expect(identityChanges).toBe(0);
        expect(sockets[0]?.closed).toBe(false);

        client.close();
    });

    it("a → b over one socket that never reconnects: the frame from the next socket names b", async () => {
        expect.assertions(3);

        const { client, identityChanges, server, sockets } = await liveClient("user-a");

        // The socket drops and the reconnect lands on B's cookie.
        server.state.user = "user-b";
        sockets[0]?.drop();
        await settle();
        sockets.at(-1)?.open();
        await settle();
        sockets.at(-1)?.receive({ subject: "user-b", type: "identity" });
        await settle();

        expect(client.currentIdentity()).toBe("subj:user-b");
        expect(identityChanges()).toBe(1);
        expect(sockets.length).toBeGreaterThanOrEqual(3);

        client.close();
    });
});

describe("cookie session: the auth gate follows the server's answer", () => {
    const reconnectAs = async (sockets: MockSocket[], subject: null | string): Promise<void> => {
        sockets.at(-1)?.drop();
        await settle();
        sockets.at(-1)?.open();
        await settle();
        sockets.at(-1)?.receive({ subject, type: "identity" });
        await settle();
    };

    it("reports unauthenticated once a socket says nobody is signed in, without asking again", async () => {
        expect.assertions(3);

        const { client, server, sockets } = await liveClient("user-a");
        const store = getIdentityStore(client);
        const probes = server.fetchImpl.mock.calls.length;

        server.state.user = null;
        await reconnectAs(sockets, null);

        expect(store.getStatus()).toBe("unauthenticated");
        expect(store.getUser()).toBeNull();
        expect(server.fetchImpl.mock.calls.filter((call) => (call[0] as string).includes("get-session"))).toHaveLength(
            server.fetchImpl.mock.calls.slice(0, probes).filter((call) => (call[0] as string).includes("get-session")).length,
        );

        client.close();
    });

    it("fetches the new user's record when a socket names someone else", async () => {
        expect.assertions(2);

        const { client, server, sockets } = await liveClient("user-a");
        const store = getIdentityStore(client);

        server.state.user = "user-b";
        await reconnectAs(sockets, "user-b");

        expect(store.getStatus()).toBe("authenticated");
        expect(store.getUser()).toStrictEqual({ id: "user-b" });

        client.close();
    });

    it("asks again for a subject whose earlier probe got no answer", async () => {
        expect.assertions(2);

        const { client, server, sockets } = await liveClient("user-a");
        const store = getIdentityStore(client);
        const answer = server.fetchImpl.getMockImplementation();

        // B's first probe cannot reach the server.
        server.state.user = "user-b";
        server.fetchImpl.mockImplementationOnce(async () => {
            throw new TypeError("Failed to fetch");
        });
        await reconnectAs(sockets, "user-b");

        expect(store.getStatus()).toBe("unreachable");

        // B signs out and back in: the store asks again rather than skipping B.
        server.fetchImpl.mockImplementation(answer ?? (async () => Response.json({})));
        server.state.user = null;
        await reconnectAs(sockets, null);
        server.state.user = "user-b";
        await reconnectAs(sockets, "user-b");

        expect(store.getUser()).toStrictEqual({ id: "user-b" });

        client.close();
    });

    it("stops asking when `/get-session` and the socket keep disagreeing", async () => {
        expect.assertions(1);

        // `/get-session` knows nobody; the socket's resolver names a user.
        const { client, sockets, server } = await liveClient(null);
        const probesOf = (): number => server.fetchImpl.mock.calls.filter((call) => (call[0] as string).includes("get-session")).length;
        const before = probesOf();

        for (let round = 0; round < 4; round += 1) {
            // eslint-disable-next-line no-await-in-loop -- one reconnect at a time
            await reconnectAs(sockets, "device-1");
        }

        // One probe for the socket's answer, not one per reconnect.
        expect(probesOf() - before).toBe(1);

        client.close();
    });
});

describe("cookie session: a write queued by A never replays as B", () => {
    /** A cookie session for `user-a` that went offline and queued `count` writes. */
    const offlineWithQueuedWrites = async (count: number) => {
        const sockets: MockSocket[] = [];
        const server = createCookieServer("user-a");
        const persistence = createInMemoryPersistence();
        const client = new LunoraClient({
            fetch: server.fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            reconnect: FAST_RECONNECT,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });
        const settled: { code?: string; status: string }[] = [];

        client.onMutationSettled((event) => settled.push({ code: (event.error as { code?: string } | undefined)?.code, status: event.status }));
        getIdentityStore(client).subscribe(() => undefined);
        client.subscribe(fnRef("notes:mine"), {}, () => {});
        await settle();
        sockets[0]?.open();
        await settle();
        sockets[0]?.drop();
        await settle();

        const pending = Array.from({ length: count }, async (_, index) =>
            client.mutation(fnRef("notes:add"), { text: `from A #${String(index)}` }).catch((error: unknown) => error),
        );

        await settle();

        const replays = (): Applied[] => server.applied.filter((entry) => entry.functionPath === "notes:add");

        return { client, pending, persistence, replays, server, settled, sockets };
    };

    it("names the subject it was queued under, so the server refuses it for B's cookie", async () => {
        expect.assertions(5);

        const { client, pending, persistence, replays, server, settled, sockets } = await offlineWithQueuedWrites(1);

        // A signs out and B signs in on the same browser. Nothing tells this
        // client — no token changes, and no probe runs.
        server.state.user = "user-b";

        // The socket comes back; its `open` flushes the queue.
        sockets.at(-1)?.open();
        await settle();

        const expectHeaders = server.fetchImpl.mock.calls
            .filter((call) => (call[0] as string).endsWith("/_lunora/rpc"))
            .map((call) => decodeIdentityHeader(new Headers(call[1]?.headers).get("x-lunora-expect-subject")));

        expect(expectHeaders).toStrictEqual([{ subject: "user-a" }]);
        expect(replays()).toStrictEqual([]);
        expect(client.currentIdentity()).toBe("subj:user-b");
        expect(settled).toStrictEqual([{ code: "OFFLINE_IDENTITY_CHANGED", status: "rejected" }]);
        await expect(persistence.load()).resolves.toStrictEqual([]);

        await Promise.all(pending);
        client.close();
    });

    it("refuses a batched replay as a whole for B's cookie", async () => {
        expect.assertions(3);

        const { client, pending, persistence, replays, server, settled, sockets } = await offlineWithQueuedWrites(3);

        server.state.user = "user-b";
        sockets.at(-1)?.open();
        await settle();

        expect(replays()).toStrictEqual([]);
        expect(settled.map((event) => event.code)).toStrictEqual(["OFFLINE_IDENTITY_CHANGED", "OFFLINE_IDENTITY_CHANGED", "OFFLINE_IDENTITY_CHANGED"]);
        await expect(persistence.load()).resolves.toStrictEqual([]);

        await Promise.all(pending);
        client.close();
    });

    it("holds A's write through a sign-out and replays it as A when A signs back in", async () => {
        expect.assertions(4);

        const { client, pending, persistence, replays, server, settled, sockets } = await offlineWithQueuedWrites(1);

        // Signed out on reconnect: the write is A's, nobody else's, and waits.
        server.state.user = null;
        sockets.at(-1)?.open();
        await settle();

        expect(replays()).toStrictEqual([]);
        await expect(persistence.load()).resolves.toHaveLength(1);

        // A signs back in; the app asks who is signed in now. That retires the
        // anonymous socket, and its replacement replays the write.
        server.state.user = "user-a";
        await client.getCurrentUser();
        await settle();
        sockets.at(-1)?.open();
        await settle();

        expect(replays()).toStrictEqual([{ asUser: "user-a", functionPath: "notes:add" }]);
        expect(settled).toStrictEqual([{ code: undefined, status: "committed" }]);

        await Promise.all(pending);
        client.close();
    });

    it("sends no expectation for a bearer-token client, whose credential is explicit", async () => {
        expect.assertions(1);

        const sockets: MockSocket[] = [];
        const server = createCookieServer("user-a");
        const client = new LunoraClient({
            fetch: server.fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            reconnect: FAST_RECONNECT,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        client.setAuthToken("tok-a", "user-a");
        client.subscribe(fnRef("notes:mine"), {}, () => {});
        await settle();
        sockets[0]?.open();
        await settle();
        sockets[0]?.drop();
        await settle();

        const pending = client.mutation(fnRef("notes:add"), { text: "bearer" });

        await settle();
        sockets.at(-1)?.open();
        await pending;

        const sent = server.fetchImpl.mock.calls.filter((call) => (call[0] as string).endsWith("/_lunora/rpc"));

        expect(sent.map((call) => new Headers(call[1]?.headers).get("x-lunora-expect-subject"))).toStrictEqual([null]);

        client.close();
    });
});
