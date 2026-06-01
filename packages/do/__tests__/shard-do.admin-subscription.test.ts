import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/introspect.js";
import type { ShardDOState } from "../src/shard-do.js";
import { ShardDO } from "../src/shard-do.js";
import type { SocketAttachment, SubscriptionEnvelope } from "../src/types.js";
import createSqliteExec from "./_helpers/node-sqlite.js";

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

        const shard = new AdminSubShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
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

        const shard = new AdminSubShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: true, subs: {} });
        await shard.driveMessage(ws, adminSub("sub-1", ADMIN_FUNCTIONS.getMetrics));

        expect(JSON.parse(ws.sent[0]!)).toEqual({ id: "sub-1", type: "ack" });
        expect(dataEnvelopes(ws).at(-1)?.data).toMatchObject({ requests: 0, shard: "shard-a" });
    });

    it("re-runs a readTablePage subscription only when its own table is written", async () => {
        expect.assertions(3);

        const shard = new AdminSubShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: true, subs: {} });
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

    it("re-runs a wildcard admin subscription (getMetrics) on any write-flush", async () => {
        expect.assertions(1);

        const shard = new AdminSubShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: true, subs: {} });
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

    it("stamps admin:true when the upgrade presents the admin token via ?token", async () => {
        expect.assertions(1);

        const attachment = await upgradeAndCaptureAttachment({ CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN }, `https://shard.internal/?token=${ADMIN_TOKEN}`);

        expect(attachment).toEqual({ admin: true, subs: {} });
    });

    it("stamps admin:false when no token is presented", async () => {
        expect.assertions(1);

        const attachment = await upgradeAndCaptureAttachment({ CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN }, "https://shard.internal/");

        expect(attachment).toEqual({ admin: false, subs: {} });
    });

    it("accepts the admin token as an alternate credential when CIRRUS_WS_BEARER gates the socket", async () => {
        expect.assertions(1);

        const attachment = await upgradeAndCaptureAttachment({ CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN, CIRRUS_WS_BEARER: "user-bearer" }, "https://shard.internal/", {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
        });

        expect(attachment).toEqual({ admin: true, subs: {} });
    });
});
