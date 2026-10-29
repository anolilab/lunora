import type { SocketAttachment } from "@lunora/shard-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

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

    // eslint-disable-next-line class-methods-use-this -- override stub: every subscription reads the same table
    protected override executeSubscription(): Promise<SubscriptionOutcome | null> {
        return Promise.resolve({ result: Date.now(), tables: new Set(["messages"]) });
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

    it("keeps a refreshed socket delivering past its original expiry", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: NOW });

        const { shard, ws } = open();

        await reauth(shard, { claims: { role: "member" }, expiresAt: NOW + 2 * HOUR, userId: "user-1" });
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
        ["an anonymous upgrade", {}, {}],
        // The studio and `subscribeScheduledJobs` answer to the admin token, which a rotation already revokes.
        ["an admin upgrade", { authorization: `Bearer ${ADMIN_FIXTURE}`, "x-lunora-userid": "user-1" }, { LUNORA_ADMIN_TOKEN: ADMIN_FIXTURE }],
    ])("holds %s to no window", async (_name, headers, env) => {
        expect.assertions(1);

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

        expect(server.attachment).not.toHaveProperty("revalidateAt");
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
