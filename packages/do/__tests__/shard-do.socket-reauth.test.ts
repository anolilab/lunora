import type { SocketAttachment } from "@lunora/shard-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claimsFingerprint } from "../../../shared/claims-fingerprint";
import { adminSocketBinding } from "../../../shared/ws-admin-token";
import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: (code?: number) => void;
    closes: (number | undefined)[];
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        close(code?: number) {
            this.closes.push(code);
        },
        closes: [],
        deserializeAttachment() {
            return this.attachment;
        },
        send(data: string) {
            this.sent.push(data);
        },
        sent: [],
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
    };
};

class ReauthShard extends ShardDO {
    /** Runs while a subscription query is in flight, standing in for time a slow query takes. */
    public duringQuery: (() => void) | undefined;

    public override async handleRpc(): Promise<unknown> {
        this.recordChangedTable("messages");

        return { ok: true };
    }

    public register(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    public write(): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "mutation:write" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    }

    protected override async executeSubscription(): Promise<SubscriptionOutcome | null> {
        await Promise.resolve();
        this.duringQuery?.();

        return { result: Date.now(), tables: new Set(["messages"]) };
    }
}

const NOW = 1_000_000;
const HOUR = 3_600_000;

const createState = (): ShardDOState => {
    const sockets: FakeWebSocket[] = [];

    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        id: { name: "shard-a" },
        storage: {
            sql: {
                exec() {
                    return { one: () => undefined, toArray: () => [], [Symbol.iterator]: Array.prototype[Symbol.iterator].bind([]) };
                },
            },
        },
    };
};

const open = (): { shard: ReauthShard; ws: FakeWebSocket } => {
    const shard = new ReauthShard(createState(), {});
    const ws = createFakeWebSocket();

    shard.register(ws, {
        connectionId: "conn-1",
        expiresAt: NOW + HOUR,
        identity: { exp: (NOW + HOUR) / 1000, role: "member" },
        subs: { "sub-1": { args: {}, functionPath: "messages:list" } },
        userId: "user-1",
    });

    return { shard, ws };
};

/** The request the worker forwards once it has verified the refreshed credential. */
const reauth = (
    shard: ReauthShard,
    { claims, connectionId = "conn-1", expiresAt, userId }: { claims?: Record<string, unknown>; connectionId?: string; expiresAt?: number; userId?: string },
): Promise<Response> =>
    shard.fetch(
        new Request("https://shard.internal/_lunora/ws/reauth", {
            body: JSON.stringify({ connectionId }),
            headers: {
                "content-type": "application/json",
                ...(userId === undefined ? {} : { "x-lunora-userid": userId }),
                ...(claims === undefined ? {} : { "x-lunora-identity": JSON.stringify(claims) }),
                ...(expiresAt === undefined ? {} : { "x-lunora-identity-exp": String(expiresAt) }),
            },
            method: "POST",
        }),
    );

describe("socket re-authentication", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("moves the expiry of a socket refreshed under the same subject and claims, and keeps its subscriptions", async () => {
        expect.assertions(4);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = open();
        const later = NOW + 2 * HOUR;
        const response = await reauth(shard, { claims: { exp: later / 1000, iat: NOW / 1000, role: "member" }, expiresAt: later, userId: "user-1" });

        expect(response.status).toBe(200);
        expect(ws.attachment?.expiresAt).toBe(later);
        expect(Object.keys(ws.attachment?.subs ?? {})).toStrictEqual(["sub-1"]);
        // Nothing is re-sent: the client keeps its values and cursors.
        expect(ws.sent).toStrictEqual([]);
    });

    it("moves a credential expiry that has already passed on a refresh from the same user, without dropping the socket", async () => {
        expect.assertions(4);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = open();

        // An idle socket whose token lapsed a moment ago; its revalidation window still holds.
        Object.assign(ws.attachment ?? {}, { expiresAt: NOW - 1000, revalidateAt: NOW + 60_000 });

        const response = await reauth(shard, { claims: { exp: (NOW + HOUR) / 1000, role: "member" }, expiresAt: NOW + HOUR, userId: "user-1" });

        expect(response.status).toBe(200);
        expect(ws.attachment?.expiresAt).toBe(NOW + HOUR);
        expect(ws.closes).toStrictEqual([]);
        expect(ws.sent.some((frame) => frame.includes("TOKEN_EXPIRED"))).toBe(false);
    });

    it("keeps a refreshed socket delivering past its original expiry", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = open();

        await reauth(shard, { claims: { role: "member" }, expiresAt: NOW + 2 * HOUR, userId: "user-1" });
        // Stands for the re-auths a live client keeps making every half window, so only the credential's expiry is under test.
        Object.assign(ws.attachment ?? {}, { revalidateAt: NOW + 2 * HOUR });
        vi.setSystemTime(NOW + HOUR + 1);
        await shard.write();

        expect(ws.closes).toStrictEqual([]);
        expect(ws.sent.some((frame) => frame.includes('"type":"data"'))).toBe(true);
    });

    it.each([
        ["an expired credential", { claims: { role: "member" }, expiresAt: NOW - 1, userId: "user-1" }, 401, "TOKEN_EXPIRED"],
        ["a replayed older credential", { claims: { role: "member" }, expiresAt: NOW + HOUR - 1, userId: "user-1" }, 409, "STALE_CREDENTIAL"],
        ["a credential without an expiry", { claims: { role: "member" }, userId: "user-1" }, 409, "STALE_CREDENTIAL"],
        ["another user's credential", { claims: { role: "member" }, expiresAt: NOW + 2 * HOUR, userId: "user-2" }, 404, "LIVE_CONNECTION_NOT_FOUND"],
        ["no verified identity", { expiresAt: NOW + 2 * HOUR }, 404, "LIVE_CONNECTION_NOT_FOUND"],
        [
            "an unknown connection",
            { claims: { role: "member" }, connectionId: "conn-2", expiresAt: NOW + 2 * HOUR, userId: "user-1" },
            404,
            "LIVE_CONNECTION_NOT_FOUND",
        ],
    ])("refuses %s and leaves the socket's expiry alone", async (_name, input, status, code) => {
        expect.assertions(3);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = open();
        const response = await reauth(shard, input);

        expect(response.status).toBe(status);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe(code);
        expect(ws.attachment?.expiresAt).toBe(NOW + HOUR);
    });

    it.each([
        ["an earlier expiry", NOW + HOUR - 1],
        ["no expiry (a cookie session)", undefined],
    ])("closes a socket whose claims changed even when the refresh carries %s", async (_name, expiresAt) => {
        expect.assertions(3);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = open();
        const response = await reauth(shard, { claims: { role: "admin" }, expiresAt, userId: "user-1" });
        const body: { error: { code: string } } = await response.json();

        // The changed claims decide, not the credential's age: a stale-looking refresh must not leave the old claims open.
        expect(body.error.code).toBe("IDENTITY_CHANGED");
        expect(response.status).toBe(409);
        expect(ws.closes[0]).toBe(4005);
    });

    it("answers a null body with 400", async () => {
        expect.assertions(1);

        const { shard } = open();
        const response = await shard.fetch(
            new Request("https://shard.internal/_lunora/ws/reauth", { body: "null", headers: { "content-type": "application/json" }, method: "POST" }),
        );

        expect(response.status).toBe(400);
    });

    it("refuses an anonymous socket, which has no credential to refresh", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ now: NOW });

        const shard = new ReauthShard(createState(), {});
        const ws = createFakeWebSocket();

        shard.register(ws, { connectionId: "conn-1", subs: {} });

        const response = await reauth(shard, { expiresAt: NOW + HOUR });

        expect(response.status).toBe(401);
    });

    it("still drops a socket whose refresh was refused with 4001 at its original expiry", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = open();

        await reauth(shard, { claims: { role: "member" }, expiresAt: NOW + HOUR - 1, userId: "user-1" });
        vi.setSystemTime(NOW + HOUR + 1);
        await shard.write();

        expect(ws.closes[0]).toBe(4001);
    });

    it("refuses a re-auth smuggled through the live control route", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = open();
        const response = await shard.fetch(
            new Request("https://shard.internal/_lunora/live/control", {
                body: JSON.stringify({ action: "reauth", connectionId: "conn-1", stream: "s", subscriptionId: "x", topic: "t" }),
                headers: { "content-type": "application/json", "x-lunora-identity-exp": String(NOW + 2 * HOUR), "x-lunora-userid": "user-1" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(400);
        expect(ws.attachment?.expiresAt).toBe(NOW + HOUR);
    });
});

const WINDOW = 60_000;
const ADMIN_FIXTURE = "revalidation-fixture-admin";

/** An authenticated subscription socket held to its revalidation window, as the upgrade stamps it. */
const openTenantSocket = (): { shard: ReauthShard; ws: FakeWebSocket } => {
    const shard = new ReauthShard(createState(), {});
    const ws = createFakeWebSocket();

    shard.register(ws, {
        connectionId: "conn-1",
        expiresAt: NOW + HOUR,
        identity: { orgId: "org-a", role: "member" },
        revalidateAt: NOW + WINDOW,
        subs: { "sub-1": { args: {}, functionPath: "messages:list" } },
        userId: "user-1",
    });

    return { shard, ws };
};

const dataFrames = (ws: FakeWebSocket): string[] => ws.sent.filter((frame) => frame.includes('"type":"data"'));

describe("socket identity revalidation", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("closes a socket whose identity was not re-resolved within its window, without a token-expired signal", async () => {
        expect.assertions(3);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = openTenantSocket();

        vi.setSystemTime(NOW + WINDOW);
        await shard.write();

        expect(ws.closes[0]).toBe(4005);
        expect(dataFrames(ws)).toStrictEqual([]);
        expect(ws.sent.some((frame) => frame.includes("TOKEN_EXPIRED"))).toBe(false);
    });

    it("delivers nothing when the window passes while the refresh query is still running", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = openTenantSocket();

        shard.duringQuery = () => {
            vi.setSystemTime(NOW + WINDOW);
        };
        await shard.write();

        expect(dataFrames(ws)).toStrictEqual([]);
        expect(ws.closes[0]).toBe(4005);
    });

    it("delivers nothing when the window passes while the socket's buffer drains", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = openTenantSocket();

        let buffered = 2_000_000;
        let drainStarted: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            drainStarted = resolve;
        });

        // The first read of the buffer is the pump reaching its drain wait: the milestone the window is moved at.
        Object.defineProperty(ws, "bufferedAmount", {
            get() {
                drainStarted();

                return buffered;
            },
        });

        const write = shard.write();

        await started;
        // The consumer is slow: the buffer clears only after the window has passed.
        vi.setSystemTime(NOW + WINDOW);
        buffered = 0;
        await vi.advanceTimersByTimeAsync(20);
        await write;

        expect(dataFrames(ws)).toStrictEqual([]);
        expect(ws.closes[0]).toBe(4005);
    });

    it("seeds nothing when the window passes while a new subscription's query is still running", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = openTenantSocket();

        shard.duringQuery = () => {
            vi.setSystemTime(NOW + WINDOW);
        };
        await shard.webSocketMessage(
            ws as unknown as WebSocket,
            JSON.stringify({ id: "sub-2", query: { args: {}, functionPath: "messages:list" }, type: "subscribe" }),
        );

        expect(dataFrames(ws)).toStrictEqual([]);
        expect(ws.closes[0]).toBe(4005);
    });

    it("stops a lapsed socket's live frames, as a relay delivering to a socket it holds does", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const shard = new ReauthShard(createState(), {});
        const ws = createFakeWebSocket();

        shard.register(ws, {
            connectionId: "r2.conn-1",
            expiresAt: NOW + HOUR,
            liveGrants: { "sub-live": "key-1" },
            revalidateAt: NOW + WINDOW,
            subs: {},
            userId: "user-1",
            whispers: ["feed"],
        });

        const deliver = (): number =>
            (shard as unknown as { deliverLiveLocal: (topic: string, key: string, frame: string) => number }).deliverLiveLocal("feed", "key-1", "{}");

        expect(deliver()).toBe(1);

        vi.setSystemTime(NOW + WINDOW);

        expect([deliver(), ws.closes[0]]).toStrictEqual([0, 4005]);
    });

    it("names a relay's connection ids after the relay, so a re-auth can go straight to it", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        const accepted: string[] = [];

        for (const name of ["shard-a::relay::2", "shard-a"]) {
            const server = createFakeWebSocket();
            const globalWithPair = globalThis as { WebSocketPair?: unknown };
            const original = globalWithPair.WebSocketPair;

            globalWithPair.WebSocketPair = function WebSocketPair() {
                return { 0: {}, 1: server } as unknown;
            };

            const shard = new ReauthShard({ ...createState(), id: { name } }, {});

            try {
                // eslint-disable-next-line no-await-in-loop -- the WebSocketPair stub is swapped per iteration, so the upgrades must not overlap
                await shard.fetch(new Request("https://shard.internal/_lunora/ws", { headers: { Upgrade: "websocket", "x-lunora-userid": "user-1" } }));
            } catch (error) {
                if (!(error instanceof RangeError)) {
                    throw error;
                }
            } finally {
                globalWithPair.WebSocketPair = original;
            }

            accepted.push(server.attachment?.connectionId ?? "");
        }

        expect(accepted[0]).toMatch(/^r2\.[\da-f-]{36}$/u);
        expect(accepted[1]).toMatch(/^[\da-f-]{36}$/u);
    });

    it("sends no resume when the window passes while the resuming subscription's query is still running", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = openTenantSocket();

        vi.spyOn(shard as unknown as { evaluateResume: () => unknown }, "evaluateResume").mockReturnValue({ cursor: 3, epoch: undefined, resumable: true });
        shard.duringQuery = () => {
            vi.setSystemTime(NOW + WINDOW);
        };
        await shard.webSocketMessage(
            ws as unknown as WebSocket,
            JSON.stringify({ id: "sub-2", query: { args: {}, functionPath: "messages:list", sinceSeq: 3 }, type: "subscribe" }),
        );

        expect(ws.sent.some((frame) => frame.includes('"type":"resume"'))).toBe(false);
        expect(ws.closes[0]).toBe(4005);
    });

    it("refuses a re-auth that arrives after the socket's window, closing the socket instead of reviving it", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = openTenantSocket();

        vi.setSystemTime(NOW + WINDOW + 1);

        const response = await reauth(shard, { claims: { orgId: "org-a", role: "member" }, expiresAt: NOW + HOUR, userId: "user-1" });

        expect(response.status).not.toBe(200);
        expect(ws.closes[0]).toBe(4005);
    });

    it("closes a pre-window socket whose new deadline cannot be stored, instead of granting it a window on every check", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const shard = new ReauthShard(createState(), {});
        const ws = createFakeWebSocket();

        shard.register(ws, { connectionId: "conn-1", expiresAt: NOW + HOUR, subs: { "sub-1": { args: {}, functionPath: "messages:list" } }, userId: "user-1" });

        const store = ws.serializeAttachment.bind(ws);

        ws.serializeAttachment = (value) => {
            if ((value as SocketAttachment).revalidateAt !== undefined) {
                throw new RangeError("attachment too large");
            }

            store(value);
        };
        await shard.write();

        expect(dataFrames(ws)).toStrictEqual([]);
        expect(ws.closes[0]).toBe(4005);
    });

    it("leaves a route socket that predates `socketFunction` out of the legacy deadline", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const shard = new ReauthShard(createState(), {});
        const ws = createFakeWebSocket();

        // A route socket marks itself with `socketPath`; it has no re-auth channel, so a window would only close it.
        shard.register(ws, { connectionId: "conn-1", socketPath: "/rooms/a", subs: {}, userId: "user-1" });
        await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "ping" }));

        expect(ws.attachment?.revalidateAt).toBeUndefined();
        expect(ws.closes).toStrictEqual([]);
    });

    it("gives a socket accepted before the window existed one window, then closes it", async () => {
        expect.assertions(4);

        vi.useFakeTimers({ now: NOW });

        const shard = new ReauthShard(createState(), {});
        const ws = createFakeWebSocket();

        // As a hibernated pre-deploy socket reads back: a user identity, no `revalidateAt`.
        shard.register(ws, { connectionId: "conn-1", expiresAt: NOW + HOUR, subs: { "sub-1": { args: {}, functionPath: "messages:list" } }, userId: "user-1" });
        await shard.write();

        expect(dataFrames(ws)).toHaveLength(1);
        expect(ws.attachment?.revalidateAt).toBe(NOW + WINDOW);

        vi.setSystemTime(NOW + WINDOW);
        await shard.write();

        expect(dataFrames(ws)).toHaveLength(1);
        expect(ws.closes[0]).toBe(4005);
    });

    it("restarts the window on a same-claims re-auth, so the socket keeps delivering past the first window", async () => {
        expect.assertions(4);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = openTenantSocket();

        vi.setSystemTime(NOW + WINDOW / 2);

        const response = await reauth(shard, { claims: { orgId: "org-a", role: "member" }, expiresAt: NOW + HOUR, userId: "user-1" });

        expect(response.status).toBe(200);
        expect(ws.attachment?.revalidateAt).toBe(NOW + WINDOW / 2 + WINDOW);

        vi.setSystemTime(NOW + WINDOW + 1);
        await shard.write();

        expect(ws.closes).toStrictEqual([]);
        expect(dataFrames(ws)).toHaveLength(1);
    });

    it("closes the socket at once when the re-resolved identity lost its orgId, so the old tenant's rows stop", async () => {
        expect.assertions(4);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = openTenantSocket();
        // The member was removed from org-a: the resolver still knows the user but no longer the tenant.
        const response = await reauth(shard, { claims: { role: "member" }, expiresAt: NOW + HOUR, userId: "user-1" });

        expect(response.status).toBe(409);
        expect(ws.closes[0]).toBe(4005);

        await shard.write();

        expect(dataFrames(ws)).toStrictEqual([]);
        expect(ws.sent.some((frame) => frame.includes("TOKEN_EXPIRED"))).toBe(false);
    });

    it("stamps the window on an authenticated upgrade and announces it in the identity frame", async () => {
        expect.assertions(3);

        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        const sockets: FakeWebSocket[] = [];
        const server = createFakeWebSocket();
        const globalWithPair = globalThis as { WebSocketPair?: unknown };
        const original = globalWithPair.WebSocketPair;

        globalWithPair.WebSocketPair = function WebSocketPair() {
            return { 0: {}, 1: server } as unknown;
        };

        const state = createState();
        const shard = new ReauthShard(
            { ...state, acceptWebSocket: (ws) => sockets.push(ws as unknown as FakeWebSocket), getWebSockets: () => sockets as unknown as WebSocket[] },
            {},
        );

        try {
            // `new Response(null, { status: 101 })` throws under Node once the socket is accepted.
            await shard.fetch(new Request("https://shard.internal/_lunora/ws", { headers: { Upgrade: "websocket", "x-lunora-userid": "user-1" } }));
        } catch (error) {
            if (!(error instanceof RangeError)) {
                throw error;
            }
        } finally {
            globalWithPair.WebSocketPair = original;
        }

        expect(server.attachment?.revalidateAt).toBe(NOW + WINDOW);

        await shard.webSocketMessage(server as unknown as WebSocket, JSON.stringify({ type: "connect" }));

        const identity = server.sent.map((frame) => JSON.parse(frame) as { revalidateMs?: number; type: string }).find((frame) => frame.type === "identity");

        expect(identity?.revalidateMs).toBe(WINDOW);
        expect(server.closes).toStrictEqual([]);
    });

    it.each([
        ["an anonymous upgrade", {}, {}, undefined],
        // A pure admin-token socket (the studio) has no user identity to go stale; the token rotation revokes it.
        ["an admin upgrade with no user", { authorization: `Bearer ${ADMIN_FIXTURE}` }, { LUNORA_ADMIN_TOKEN: ADMIN_FIXTURE }, undefined],
        // Admin authority does not vouch for the user identity riding beside it: a removed user would keep its
        // user subscriptions for as long as the admin token stayed valid.
        [
            "an admin upgrade that also carries a user",
            { authorization: `Bearer ${ADMIN_FIXTURE}`, "x-lunora-userid": "user-1" },
            { LUNORA_ADMIN_TOKEN: ADMIN_FIXTURE },
            NOW + WINDOW,
        ],
    ])("holds %s to the window only when it carries a user identity", async (_name, headers, env, revalidateAt) => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        const server = createFakeWebSocket();
        const globalWithPair = globalThis as { WebSocketPair?: unknown };
        const original = globalWithPair.WebSocketPair;

        globalWithPair.WebSocketPair = function WebSocketPair() {
            return { 0: {}, 1: server } as unknown;
        };

        const shard = new ReauthShard(createState(), env);

        try {
            await shard.fetch(new Request("https://shard.internal/_lunora/ws", { headers: { Upgrade: "websocket", ...headers } }));
        } catch (error) {
            if (!(error instanceof RangeError)) {
                throw error;
            }
        } finally {
            globalWithPair.WebSocketPair = original;
        }

        expect(server.attachment).toBeDefined();
        expect(server.attachment?.revalidateAt).toBe(revalidateAt);
    });
});

describe("socket re-authentication through a relay", () => {
    const databases: ReturnType<typeof createSqliteExec>[] = [];

    afterEach(() => {
        vi.useRealTimers();

        for (const database of databases.splice(0)) {
            database.close();
        }
    });

    /** An owner with one attached relay holding the socket; each DO has its own SQLite and reaches the other in-process. */
    const makeRig = async (): Promise<{ owner: ReauthShard; ws: FakeWebSocket }> => {
        const ownerDb = createSqliteExec();
        const relayDb = createSqliteExec();

        databases.push(ownerDb, relayDb);

        const ws = createFakeWebSocket();
        const state = (name: string, database: ReturnType<typeof createSqliteExec>, sockets: FakeWebSocket[]): ShardDOState =>
            ({
                acceptWebSocket() {},
                getWebSockets: () => sockets,
                id: { name },
                storage: { sql: database.sql },
            }) as unknown as ShardDOState;
        const peers: { owner?: ReauthShard; relay?: ReauthShard } = {};
        const reach = (target: () => ReauthShard | undefined) => {
            return {
                get: () => {
                    return { fetch: (url: string, init?: RequestInit): Promise<Response> => (target() as ReauthShard).fetch(new Request(url, init)) };
                },
                idFromName: (name: string) => name,
            };
        };

        peers.owner = new ReauthShard(state("shard-a", ownerDb, []), { SHARD: reach(() => peers.relay) });
        peers.relay = new ReauthShard(state("shard-a::relay::0", relayDb, [ws]), { SHARD: reach(() => peers.owner) });
        Object.assign(peers.owner, { shardBinding: "SHARD" });
        Object.assign(peers.relay, { shardBinding: "SHARD" });

        ws.serializeAttachment({
            connectionId: "conn-1",
            expiresAt: NOW + HOUR,
            identity: { role: "member" },
            subs: { "sub-1": { args: {}, functionPath: "messages:list" } },
            userId: "user-1",
        });

        await peers.owner.fetch(
            new Request("https://shard.internal/_lunora/relay", {
                body: JSON.stringify({ relayIndex: 0, type: "relay_attach" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        return { owner: peers.owner, ws };
    };

    it("reaches a relay-held socket through the owner and moves its expiry", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        const { owner, ws } = await makeRig();
        const response = await reauth(owner, { claims: { role: "member" }, expiresAt: NOW + 2 * HOUR, userId: "user-1" });

        expect(response.status).toBe(200);
        expect(ws.attachment?.expiresAt).toBe(NOW + 2 * HOUR);
    });

    it("carries the claims to the relay, which refuses a changed identity and closes its socket", async () => {
        expect.assertions(3);

        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        const { owner, ws } = await makeRig();
        const response = await reauth(owner, { claims: { role: "admin" }, expiresAt: NOW + 2 * HOUR, userId: "user-1" });

        expect(response.status).toBe(409);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("IDENTITY_CHANGED");
        expect(ws.closes[0]).toBe(4005);
    });
});

describe("resume under the claims the cursor was read under", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const CLAIMS = { orgId: "org-a", role: "member" };
    const fingerprint = claimsFingerprint("user-1", CLAIMS);

    const resubscribe = async (sinceClaims: string | undefined) => {
        vi.useFakeTimers({ now: NOW });

        const shard = new ReauthShard(createState(), {});
        const ws = createFakeWebSocket();

        shard.register(ws, { connectionId: "conn-1", expiresAt: NOW + HOUR, identity: CLAIMS, revalidateAt: NOW + WINDOW, subs: {}, userId: "user-1" });

        const evaluate = vi
            .spyOn(shard as unknown as { evaluateResume: () => unknown }, "evaluateResume")
            .mockReturnValue({ cursor: 3, epoch: undefined, resumable: true });

        await shard.webSocketMessage(
            ws as unknown as WebSocket,
            JSON.stringify({
                id: "sub-2",
                query: { args: {}, functionPath: "messages:list", sinceSeq: 3, ...(sinceClaims === undefined ? {} : { sinceClaims }) },
                type: "subscribe",
            }),
        );

        return { evaluate, ws };
    };

    it("announces the fingerprint of the socket's claims on its identity frame", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ now: NOW });

        const shard = new ReauthShard(createState(), {});
        const ws = createFakeWebSocket();

        shard.register(ws, { connectionId: "conn-1", expiresAt: NOW + HOUR, identity: CLAIMS, revalidateAt: NOW + WINDOW, subs: {}, userId: "user-1" });
        await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "connect" }));

        const identity = ws.sent.map((frame) => JSON.parse(frame) as { claims?: string; type: string }).find((frame) => frame.type === "identity");

        expect(identity?.claims).toBe(fingerprint);
    });

    it("resumes warm when the claims are the ones the cursor was read under", async () => {
        expect.assertions(2);

        const { evaluate, ws } = await resubscribe(fingerprint);

        expect(evaluate).toHaveBeenCalledWith(3, expect.anything(), undefined);
        expect(ws.sent.some((frame) => frame.includes('"type":"resume"'))).toBe(true);
    });

    it.each([
        ["claims that changed during the gap", claimsFingerprint("user-1", { orgId: "org-b", role: "member" })],
        ["no fingerprint (an older client)", undefined],
    ])("seeds cold, honouring no cursor, for %s", async (_name, sinceClaims) => {
        expect.assertions(3);

        const { evaluate, ws } = await resubscribe(sinceClaims);

        expect(evaluate).not.toHaveBeenCalled();
        expect(ws.sent.some((frame) => frame.includes('"type":"resume"'))).toBe(false);
        expect(dataFrames(ws)).toHaveLength(1);
    });
});

describe("admin socket re-authentication", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const CLAIMS = { orgId: "org-a", role: "member" };

    /** A Studio-style socket: admin-authorized at upgrade, carrying a cookie user held to the window. */
    const openAdminSocket = async (token = ADMIN_FIXTURE) => {
        const shard = new ReauthShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_FIXTURE });
        const ws = createFakeWebSocket();

        shard.register(ws, {
            admin: true,
            adminBinding: await adminSocketBinding(token),
            connectionId: "conn-1",
            expiresAt: NOW + HOUR,
            identity: CLAIMS,
            revalidateAt: NOW + WINDOW,
            subs: { "sub-1": { args: {}, functionPath: "messages:list" } },
            userId: "user-1",
        });

        return { shard, ws };
    };

    const adminReauth = (shard: ReauthShard, headers: Record<string, string>): Promise<Response> =>
        shard.fetch(
            new Request("https://shard.internal/_lunora/ws/reauth", {
                body: JSON.stringify({ connectionId: "conn-1" }),
                headers: { "content-type": "application/json", ...headers },
                method: "POST",
            }),
        );

    it("keeps an admin socket whose re-auth the worker verified as admin, restarting its window", async () => {
        expect.assertions(3);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = await openAdminSocket();

        vi.setSystemTime(NOW + WINDOW / 2);

        const response = await adminReauth(shard, {
            "x-lunora-admin-reauth": "1",
            "x-lunora-identity": JSON.stringify(CLAIMS),
            "x-lunora-identity-exp": String(NOW + HOUR),
            "x-lunora-userid": "user-1",
        });

        expect(response.status).toBe(200);
        expect(ws.attachment?.revalidateAt).toBe(NOW + WINDOW / 2 + WINDOW);
        expect(ws.closes).toStrictEqual([]);
    });

    it("does not let another user close an admin socket, or learn that it is one", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = await openAdminSocket();
        const response = await adminReauth(shard, {
            "x-lunora-identity": JSON.stringify(CLAIMS),
            "x-lunora-identity-exp": String(NOW + HOUR),
            "x-lunora-userid": "user-2",
        });

        // The same answer as for any socket the caller does not own, and the socket is untouched.
        expect(response.status).toBe(404);
        expect(ws.closes).toStrictEqual([]);
    });

    it("closes an admin socket whose re-auth carries no verified admin credential", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = await openAdminSocket();
        const response = await adminReauth(shard, {
            "x-lunora-identity": JSON.stringify(CLAIMS),
            "x-lunora-identity-exp": String(NOW + HOUR),
            "x-lunora-userid": "user-1",
        });

        expect(response.status).toBe(409);
        expect(ws.closes[0]).toBe(4005);
    });

    it("closes an admin socket authorized by a token that has since been rotated, whatever the re-auth presents", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = await openAdminSocket("the-previous-admin-token");
        const response = await adminReauth(shard, {
            "x-lunora-admin-reauth": "1",
            "x-lunora-identity": JSON.stringify(CLAIMS),
            "x-lunora-identity-exp": String(NOW + HOUR),
            "x-lunora-userid": "user-1",
        });

        expect(response.status).toBe(409);
        expect(ws.closes[0]).toBe(4005);
    });

    it("drops the user part of an admin socket whose user is gone, by closing it so only the admin grant is re-opened", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = await openAdminSocket();
        // The admin credential still holds; the cookie no longer resolves to the user.
        const response = await adminReauth(shard, { "x-lunora-admin-reauth": "1" });

        expect(response.status).toBe(409);
        expect(ws.closes[0]).toBe(4005);
    });
});

describe("table-only subscriptions on a socket that carries claims", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const frames = (ws: FakeWebSocket) => ws.sent.map((frame) => JSON.parse(frame) as { code?: string; id?: string; type: string });

    const subscribe = async (attachment: Partial<SocketAttachment>, query: Record<string, unknown>) => {
        vi.useFakeTimers({ now: NOW });

        const shard = new ReauthShard(createState(), {});
        const ws = createFakeWebSocket();

        shard.register(ws, { connectionId: "conn-1", subs: {}, ...attachment });
        await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ id: "sub-1", query, type: "subscribe" }));

        return ws;
    };

    it("refuses a subscribe with no function path, and sends no rows", async () => {
        expect.assertions(3);

        const ws = await subscribe({ expiresAt: NOW + HOUR, identity: { orgId: "org-a" }, userId: "user-1" }, { table: "messages" });

        expect(frames(ws).find((frame) => frame.type === "error")?.code).toBe("SUBSCRIPTION_FUNCTION_REQUIRED");
        expect(frames(ws).some((frame) => frame.type === "data" || frame.type === "ack")).toBe(false);
        expect(Object.keys(ws.attachment?.subs ?? {})).toStrictEqual([]);
    });

    it("still accepts the same subscribe on a socket with no claims", async () => {
        expect.assertions(2);

        const ws = await subscribe({}, { table: "messages" });

        expect(frames(ws).some((frame) => frame.type === "error")).toBe(false);
        expect(frames(ws).some((frame) => frame.type === "ack")).toBe(true);
    });

    it("leaves a subscribe with a function path alone on a socket with claims", async () => {
        expect.assertions(2);

        const ws = await subscribe(
            { expiresAt: NOW + HOUR, identity: { orgId: "org-a" }, userId: "user-1" },
            { functionPath: "messages:list", table: "messages:list" },
        );

        expect(frames(ws).some((frame) => frame.type === "error")).toBe(false);
        expect(frames(ws).some((frame) => frame.type === "data")).toBe(true);
    });
});
