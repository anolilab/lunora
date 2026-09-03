import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adminSocketBinding, mintWsAdminToken } from "../../../shared/ws-admin-token";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const ADMIN_TOKEN = "s3cret-admin";

/**
 * Minimal WebSocket double mirroring the `serializeAttachment` /
 * `deserializeAttachment` instance methods workerd exposes, plus a `sent`
 * buffer so pushed envelopes can be asserted.
 */
interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
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

/** Parse every `{type:"data"}` envelope the socket received, newest last. */
const dataEnvelopes = (ws: FakeWebSocket): { data: unknown; id: string }[] =>
    ws.sent.map((raw) => JSON.parse(raw) as { data?: unknown; id: string; type: string }).filter((m) => m.type === "data") as { data: unknown; id: string }[];

/**
 * A real-SQLite ShardDO whose `handleRpc` optionally mutates the database and
 * records a changed table, so a user write drives `flushChangedTables` exactly
 * as production does — letting admin subscriptions be exercised end-to-end.
 */
class AdminSubShard extends ShardDO {
    /** Run before recording the changed table on the next `handleRpc`. */
    public mutate: (() => void) | undefined;

    /** Table the next `handleRpc` reports as written (drives the refresh). */
    public changedTable: string | undefined;

    public override async handleRpc(): Promise<unknown> {
        this.mutate?.();

        if (this.changedTable !== undefined) {
            this.recordChangedTable(this.changedTable);
        }

        return { ok: true };
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    /** Drive a write through the public `fetch` surface so the flush runs. */
    public writeRpc(): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:touch" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    }
}

describe("shardDO admin subscriptions", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let sockets: FakeWebSocket[];
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        database.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "text" TEXT)`);
        database.raw(`INSERT INTO "messages" VALUES ('m1', 'hello')`);

        sockets = [];
        state = {
            acceptWebSocket(ws) {
                sockets.push(ws as unknown as FakeWebSocket);
            },
            getWebSockets() {
                return sockets as unknown as WebSocket[];
            },
            id: { name: "shard-a" },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const adminSub = (id: string, functionPath: string, args: Record<string, unknown> = {}): SubscriptionEnvelope => {
        return {
            id,
            query: { args, functionPath },
            type: "subscribe",
        };
    };

    it("rejects an admin subscription on a non-admin socket without registering it", async () => {
        expect.assertions(3);

        const shard = new AdminSubShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: false, subs: {} });
        await shard.driveMessage(ws, adminSub("sub-1", ADMIN_FUNCTIONS.getMetrics));

        expect(JSON.parse(ws.sent[0]!)).toMatchObject({ id: "sub-1", type: "error" });
        expect(dataEnvelopes(ws)).toHaveLength(0);
        // The subscription must not have been recorded on the socket.
        expect(ws.attachment).toEqual({ admin: false, subs: {} });
    });

    it("seeds an admin subscription with the current value on an admin socket", async () => {
        expect.assertions(2);

        const shard = new AdminSubShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: true, adminBinding: await adminSocketBinding(ADMIN_TOKEN), subs: {} });
        await shard.driveMessage(ws, adminSub("sub-1", ADMIN_FUNCTIONS.getMetrics));

        expect(JSON.parse(ws.sent[0]!)).toEqual({ id: "sub-1", type: "ack" });
        expect(dataEnvelopes(ws).at(-1)?.data).toMatchObject({ requests: 0, shard: "shard-a" });
    });

    it("seeds getFanoutMetrics with per-topic subscriber counts folded from every socket", async () => {
        expect.assertions(4);

        const shard = new AdminSubShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const admin = createFakeWebSocket();
        const member1 = createFakeWebSocket();
        const member2 = createFakeWebSocket();

        // Two members share a shape and a whisper topic; the admin socket watches
        // neither, so it contributes to the connection count but no topic.
        shard.registerSocket(admin, { admin: true, adminBinding: await adminSocketBinding(ADMIN_TOKEN), subs: {} });
        shard.registerSocket(member1, { shapes: { s1: { name: "roomMessages" } }, subs: {}, whispers: ["cursor:room"] });
        shard.registerSocket(member2, { shapes: { s2: { name: "roomMessages" } }, subs: {}, whispers: ["cursor:room"] });

        await shard.driveMessage(admin, adminSub("sub-1", ADMIN_FUNCTIONS.getFanoutMetrics));

        const seeded = dataEnvelopes(admin).at(-1)?.data as {
            peakSubscribers: number;
            shapePoke: { passes: number };
            topics: { kind: string; subscribers: number; topic: string }[];
            totalConnections: number;
        };

        expect(seeded.totalConnections).toBe(3);
        expect(seeded.peakSubscribers).toBe(2);
        // Both topics have 2 subscribers; ties break by topic name (cursor:room < roomMessages).
        expect(seeded.topics).toEqual([
            { kind: "whisper", subscribers: 2, topic: "cursor:room" },
            { kind: "shape", subscribers: 2, topic: "roomMessages" },
        ]);
        // No poke/broadcast has run in this test, so the running counters are zero.
        expect(seeded.shapePoke.passes).toBe(0);
    });

    it("re-runs a readTablePage subscription only when its own table is written", async () => {
        expect.assertions(3);

        const shard = new AdminSubShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: true, adminBinding: await adminSocketBinding(ADMIN_TOKEN), subs: {} });
        await shard.driveMessage(ws, adminSub("sub-1", ADMIN_FUNCTIONS.readTablePage, { table: "messages" }));

        const seeded = dataEnvelopes(ws).at(-1)?.data as { total: number };

        expect(seeded.total).toBe(1);

        // A write to an unrelated table must NOT re-run the messages page.
        shard.changedTable = "documents";
        await shard.writeRpc();

        expect(dataEnvelopes(ws)).toHaveLength(1);

        // A write to messages re-runs it and pushes the grown page.
        shard.mutate = () => {
            database.raw(`INSERT INTO "messages" VALUES ('m2', 'world')`);
        };
        shard.changedTable = "messages";
        await shard.writeRpc();

        expect((dataEnvelopes(ws).at(-1)?.data as { total: number }).total).toBe(2);
    });

    it("stops pushing an admin subscription once LUNORA_ADMIN_TOKEN is rotated", async () => {
        expect.assertions(3);

        const env: { LUNORA_ADMIN_TOKEN: string } = { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN };
        const shard = new AdminSubShard(state, env);
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: true, adminBinding: await adminSocketBinding(ADMIN_TOKEN), subs: {} });
        await shard.driveMessage(ws, adminSub("sub-1", ADMIN_FUNCTIONS.getMetrics));

        expect(dataEnvelopes(ws)).toHaveLength(1);

        // The upgrade authorized ONCE; the socket then lives for hours. Rotating
        // the master token closes the HTTP admin plane on the next request — it
        // must close this one too, or the sub-token's 60s TTL only bounds how
        // long an attacker has to OPEN a socket that reads `runSql` forever.
        env.LUNORA_ADMIN_TOKEN = "rotated-admin-token";
        shard.changedTable = "documents";
        await shard.writeRpc();

        expect(dataEnvelopes(ws)).toHaveLength(1);
        // The stale subscription is torn down, not merely skipped.
        expect(ws.attachment?.subs).toStrictEqual({});
    });

    it("refuses a NEW admin subscription on a socket whose authorizing token was rotated", async () => {
        expect.assertions(2);

        const env: { LUNORA_ADMIN_TOKEN: string } = { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN };
        const shard = new AdminSubShard(state, env);
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: true, adminBinding: await adminSocketBinding(ADMIN_TOKEN), subs: {} });
        env.LUNORA_ADMIN_TOKEN = "rotated-admin-token";

        await shard.driveMessage(ws, adminSub("sub-1", ADMIN_FUNCTIONS.getMetrics));

        expect(JSON.parse(ws.sent[0]!)).toMatchObject({ id: "sub-1", type: "error" });
        expect(dataEnvelopes(ws)).toHaveLength(0);
    });

    it("re-runs a wildcard admin subscription (getMetrics) on any write-flush", async () => {
        expect.assertions(1);

        const shard = new AdminSubShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: true, adminBinding: await adminSocketBinding(ADMIN_TOKEN), subs: {} });
        await shard.driveMessage(ws, adminSub("sub-1", ADMIN_FUNCTIONS.getMetrics));

        // An unrelated-table write still bumps the request counter, so metrics
        // re-run and push despite no table dependency.
        shard.changedTable = "documents";
        await shard.writeRpc();

        expect((dataEnvelopes(ws).at(-1)?.data as { requests: number }).requests).toBe(1);
    });
});

/** A trivial concrete shard for the upgrade-gate tests; `handleRpc` is unused. */
class UpgradeShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; the upgrade-gate tests never dispatch an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(null);
    }
}

describe("shardDO admin-socket upgrade flagging", () => {
    // A single in-memory db is fine — these tests never write, only upgrade.
    const sql = createSqliteExec();

    const baseState = (): ShardDOState => {
        return {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: sql.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    };

    /** Capture the attachment the upgrade stamps onto the accepted socket. */
    const upgradeAndCaptureAttachment = async (
        env: Record<string, string>,
        url: string,
        headers?: Record<string, string>,
    ): Promise<SocketAttachment | undefined> => {
        let captured: SocketAttachment | undefined;
        const server = {
            serializeAttachment(value: unknown) {
                captured = value as SocketAttachment;
            },
        };

        const globalWithPair = globalThis as { WebSocketPair?: unknown };
        const original = globalWithPair.WebSocketPair;

        globalWithPair.WebSocketPair = function WebSocketPair() {
            return { 0: {}, 1: server } as unknown;
        };

        const shard = new UpgradeShard(baseState(), env);

        try {
            // The attachment is stamped before the `new Response(null, {status:
            // 101})` line, which Node rejects (101 is out of its allowed range).
            // That throw is expected here — `captured` is already set by then.
            await shard.fetch(new Request(url, { headers: new Headers({ Upgrade: "websocket", ...headers }) }));
        } catch (error) {
            if (!(error instanceof RangeError)) {
                throw error;
            }
        } finally {
            globalWithPair.WebSocketPair = original;
        }

        return captured;
    };

    it("stamps admin:false for the raw master token in ?token= (enforcement is the default)", async () => {
        expect.assertions(1);

        const attachment = await upgradeAndCaptureAttachment({ LUNORA_ADMIN_TOKEN: ADMIN_TOKEN }, `https://shard.internal/?token=${ADMIN_TOKEN}`);

        // The upgrade still mints a per-connection id for lifecycle dispatch; the
        // socket just isn't admin — only a minted sub-token (or the header) is.
        expect(attachment).toEqual({ admin: false, connectionId: expect.any(String), subs: {} });
    });

    it("stamps admin:false when no token is presented", async () => {
        expect.assertions(1);

        const attachment = await upgradeAndCaptureAttachment({ LUNORA_ADMIN_TOKEN: ADMIN_TOKEN }, "https://shard.internal/");

        expect(attachment).toEqual({ admin: false, connectionId: expect.any(String), subs: {} });
    });

    it("accepts the admin token as an alternate credential when LUNORA_WS_BEARER gates the socket", async () => {
        expect.assertions(1);

        const attachment = await upgradeAndCaptureAttachment({ LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_WS_BEARER: "user-bearer" }, "https://shard.internal/", {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
        });

        expect(attachment).toEqual({ admin: true, adminBinding: expect.any(String) as string, connectionId: expect.any(String), subs: {} });
    });

    it("stamps admin:true when the upgrade presents a minted ephemeral token via ?token", async () => {
        expect.assertions(1);

        const minted = await mintWsAdminToken(ADMIN_TOKEN);
        const attachment = await upgradeAndCaptureAttachment(
            { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN },
            `https://shard.internal/?token=${encodeURIComponent(minted.token)}`,
        );

        expect(attachment).toEqual({ admin: true, adminBinding: expect.any(String) as string, connectionId: expect.any(String), subs: {} });
    });

    it("accepts a minted ephemeral token as an alternate credential when LUNORA_WS_BEARER gates the socket", async () => {
        expect.assertions(1);

        const minted = await mintWsAdminToken(ADMIN_TOKEN);
        const attachment = await upgradeAndCaptureAttachment(
            { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_WS_BEARER: "user-bearer" },
            `https://shard.internal/?token=${encodeURIComponent(minted.token)}`,
        );

        expect(attachment).toEqual({ admin: true, adminBinding: expect.any(String) as string, connectionId: expect.any(String), subs: {} });
    });

    it("stamps admin:false when the minted ephemeral token has expired", async () => {
        expect.assertions(1);

        const minted = await mintWsAdminToken(ADMIN_TOKEN, { now: Date.now() - 120_000, ttlMs: 60_000 });
        const attachment = await upgradeAndCaptureAttachment(
            { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN },
            `https://shard.internal/?token=${encodeURIComponent(minted.token)}`,
        );

        expect(attachment).toEqual({ admin: false, connectionId: expect.any(String), subs: {} });
    });

    it("stamps admin:false when the minted ephemeral token was tampered with", async () => {
        expect.assertions(1);

        const minted = await mintWsAdminToken(ADMIN_TOKEN);
        const [version, exp, signature] = minted.token.split(".") as [string, string, string];
        const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
        const attachment = await upgradeAndCaptureAttachment(
            { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN },
            `https://shard.internal/?token=${encodeURIComponent(`${version}.${exp}.${flipped}`)}`,
        );

        expect(attachment).toEqual({ admin: false, connectionId: expect.any(String), subs: {} });
    });

    it("rejects the upgrade (403) when LUNORA_WS_BEARER is set and the ephemeral token is expired", async () => {
        expect.assertions(1);

        const minted = await mintWsAdminToken(ADMIN_TOKEN, { now: Date.now() - 120_000, ttlMs: 60_000 });

        // No attachment is ever stamped: the gate rejects before the pair is built.
        const attachment = await upgradeAndCaptureAttachment(
            { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_WS_BEARER: "user-bearer" },
            `https://shard.internal/?token=${encodeURIComponent(minted.token)}`,
        );

        expect(attachment).toBeUndefined();
    });

    describe("enforcement via LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN", () => {
        const ENFORCED = { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN: "1" };

        it("stamps admin:false for the raw master token in ?token=", async () => {
            expect.assertions(1);

            const attachment = await upgradeAndCaptureAttachment(ENFORCED, `https://shard.internal/?token=${ADMIN_TOKEN}`);

            expect(attachment).toEqual({ admin: false, connectionId: expect.any(String), subs: {} });
        });

        it("still stamps admin:true for a minted ephemeral token in ?token=", async () => {
            expect.assertions(1);

            const minted = await mintWsAdminToken(ADMIN_TOKEN);
            const attachment = await upgradeAndCaptureAttachment(ENFORCED, `https://shard.internal/?token=${encodeURIComponent(minted.token)}`);

            expect(attachment).toEqual({ admin: true, adminBinding: expect.any(String) as string, connectionId: expect.any(String), subs: {} });
        });

        it("still stamps admin:true for the master token in the Authorization HEADER (no URL leak)", async () => {
            expect.assertions(1);

            const attachment = await upgradeAndCaptureAttachment(ENFORCED, "https://shard.internal/", {
                Authorization: `Bearer ${ADMIN_TOKEN}`,
            });

            expect(attachment).toEqual({ admin: true, adminBinding: expect.any(String) as string, connectionId: expect.any(String), subs: {} });
        });

        it("leaves the master token in ?token= working when the env value reads as off", async () => {
            expect.assertions(1);

            const attachment = await upgradeAndCaptureAttachment(
                { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN: "off" },
                `https://shard.internal/?token=${ADMIN_TOKEN}`,
            );

            expect(attachment).toEqual({ admin: true, adminBinding: expect.any(String) as string, connectionId: expect.any(String), subs: {} });
        });
    });
});
