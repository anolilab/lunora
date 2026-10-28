import type { SocketAttachment } from "@lunora/shard-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

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
        ["changed claims", { claims: { role: "admin" }, expiresAt: NOW + 2 * HOUR, userId: "user-1" }, 409, "IDENTITY_CHANGED"],
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

        await reauth(shard, { claims: { role: "admin" }, expiresAt: NOW + 2 * HOUR, userId: "user-1" });
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
