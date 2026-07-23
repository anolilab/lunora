import type { SocketAttachment } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

import { migrateGlobalShapeSnapshot } from "../src/ctx-db";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The `.global()`-table shape tier. A `.global()` table lives in D1, which has
 * no per-DO op-log, so a global shape can't be poke-live: the DO seeds its
 * membership from the global backend once on subscribe, then on each alarm tick
 * re-reads the full membership and pokes only the diff against a per-socket
 * snapshot.
 *
 * The base `ShardDO` has no global backend (`readGlobalShapeRows` → `[]`), so the
 * test subclass overrides it with an in-memory reader (standing in for D1) and
 * `resolveShape` to mark the shape `global`. Driving `alarm()` directly exercises
 * the poll/diff loop the real runtime invokes when the poll alarm fires.
 */

interface ShapeRow {
    doc: Record<string, unknown>;
    id: string;
}

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: () => void;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: { subs: {} },
        close() {
            /* no-op */
        },
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

/** A shard whose only shape is a `.global()`-table shape served from an in-memory reader. */
class GlobalShapeShard extends ShardDO {
    /** The stand-in for the D1 membership; mutate it then drive `alarm()`. */
    public rows: ShapeRow[] = [];

    // eslint-disable-next-line class-methods-use-this -- this shard exercises only the shape/alarm path; RPC is unused.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }

    // eslint-disable-next-line class-methods-use-this -- test stub override: resolves by `name` alone.
    protected override resolveShape(name: string): { effectiveWhere?: Record<string, unknown>; global?: boolean; table: string } | undefined {
        if (name !== "globalThings") {
            return undefined;
        }

        return { effectiveWhere: {}, global: true, table: "things" };
    }

    protected override readGlobalShapeRows(): Promise<ShapeRow[]> {
        return Promise.resolve(
            this.rows.map((row) => {
                return { doc: { ...row.doc }, id: row.id };
            }),
        );
    }
}

/**
 * A {@link GlobalShapeShard} that can be made to fail on demand — `failResolve`
 * makes `resolveShape` throw, and `failUserId` makes the global-backend read
 * reject for one socket's identity. Used to prove the poll path contains a
 * per-socket / per-shape failure instead of aborting the whole tick (and its
 * re-arm).
 */
class FlakyGlobalShard extends GlobalShapeShard {
    public failResolve = false;

    public failUserId: string | undefined = undefined;

    protected override readGlobalShapeRows(_resolved?: unknown, identity?: { userId?: string }): Promise<ShapeRow[]> {
        if (this.failUserId !== undefined && identity?.userId === this.failUserId) {
            return Promise.reject(new Error("global backend unavailable"));
        }

        return super.readGlobalShapeRows();
    }

    protected override resolveShape(name: string): { effectiveWhere?: Record<string, unknown>; global?: boolean; table: string } | undefined {
        if (this.failResolve) {
            throw new Error("policy lookup failed");
        }

        return super.resolveShape(name);
    }
}

let harness: ReturnType<typeof createSqliteExec>;
const alarmBox: { scheduled: null | number } = { scheduled: null };

const makeState = (sockets: FakeWebSocket[]): ShardDOState => {
    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        storage: {
            setAlarm(scheduledTime) {
                alarmBox.scheduled = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();

                return Promise.resolve();
            },
            sql: harness.sql as unknown as ShardDOState["storage"]["sql"],
        },
    };
};

const subscribeShape = async (shard: ShardDO, ws: FakeWebSocket): Promise<void> => {
    await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ id: "g1", shape: { name: "globalThings" }, type: "shape_subscribe" }));
};

/** Collect the row-ops across every `pokePart` frame the socket received. */
const pokeOps = (ws: FakeWebSocket): { key: string; op: string; value?: Record<string, unknown> }[] =>
    ws.sent
        .map((raw) => JSON.parse(raw) as { rowsPatch?: { key: string; op: string; value?: Record<string, unknown> }[]; type: string })
        .filter((frame) => frame.type === "pokePart")
        .flatMap((frame) => frame.rowsPatch ?? []);

const frameTypes = (ws: FakeWebSocket): string[] => ws.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);

describe("shardDO global-shape poll tier", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        alarmBox.scheduled = null;
    });

    it("seeds the current global membership as an insert-poke and arms the alarm", async () => {
        expect.assertions(4);

        const sockets: FakeWebSocket[] = [];
        const shard = new GlobalShapeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        shard.rows = [
            { doc: { _id: "t1", label: "a" }, id: "t1" },
            { doc: { _id: "t2", label: "b" }, id: "t2" },
        ];

        await subscribeShape(shard, ws);

        // The seed poke (start/part/end), then the ack last — the ack is sent only
        // after the shape resolves and seeds.
        expect(frameTypes(ws)).toStrictEqual(["pokeStart", "pokePart", "pokeEnd", "ack"]);

        const ops = pokeOps(ws);

        expect(ops).toHaveLength(2);
        expect(ops).toStrictEqual([
            { key: "t1", op: "insert", table: "things", value: expect.objectContaining({ _id: "t1", label: "a" }) },
            { key: "t2", op: "insert", table: "things", value: expect.objectContaining({ _id: "t2", label: "b" }) },
        ]);
        // The poll alarm is armed so the runtime will call `alarm()` to refresh.
        expect(alarmBox.scheduled).not.toBeNull();
    });

    it("fails an over-cap global shape closed: error frame, no poke, no armed alarm", async () => {
        expect.assertions(3);

        const sockets: FakeWebSocket[] = [];
        const shard = new GlobalShapeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        // One row past the membership cap — materializing it into a per-socket
        // snapshot is refused, so the subscription is rolled back and the client
        // gets a structured error (never an `ack` without data), and the poll alarm
        // is never armed for it.
        const cap = (ShardDO as unknown as { GLOBAL_SHAPE_MAX_ROWS: number }).GLOBAL_SHAPE_MAX_ROWS;

        shard.rows = Array.from({ length: cap + 1 }, (_, index) => {
            return { doc: { _id: `t${String(index)}` }, id: `t${String(index)}` };
        });

        await subscribeShape(shard, ws);

        // The refused shape errors instead of acking, and carries no seed poke.
        expect(frameTypes(ws)).toStrictEqual(["error"]);

        const errorFrame = ws.sent.map((raw) => JSON.parse(raw) as { code?: string; type?: string }).find((frame) => frame.type === "error");

        expect(errorFrame?.code).toBe("SHAPE_GLOBAL_TOO_LARGE");
        expect(alarmBox.scheduled).toBeNull();
    });

    it("pokes only the diff (insert / update / delete) on an alarm tick", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new GlobalShapeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        shard.rows = [
            { doc: { _id: "t1", label: "a" }, id: "t1" },
            { doc: { _id: "t2", label: "b" }, id: "t2" },
        ];
        await subscribeShape(shard, ws);
        ws.sent.length = 0;

        // t1 changes, t2 vanishes, t3 joins.
        shard.rows = [
            { doc: { _id: "t1", label: "a2" }, id: "t1" },
            { doc: { _id: "t3", label: "c" }, id: "t3" },
        ];

        await shard.alarm();

        expect(frameTypes(ws)).toStrictEqual(["pokeStart", "pokePart", "pokeEnd"]);
        expect(pokeOps(ws)).toStrictEqual([
            { key: "t1", op: "update", table: "things", value: expect.objectContaining({ label: "a2" }) },
            { key: "t3", op: "insert", table: "things", value: expect.objectContaining({ _id: "t3", label: "c" }) },
            { key: "t2", op: "delete", table: "things" },
        ]);
    });

    it("sends no poke on an alarm tick when membership is unchanged", async () => {
        expect.assertions(1);

        const sockets: FakeWebSocket[] = [];
        const shard = new GlobalShapeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        shard.rows = [{ doc: { _id: "t1", label: "a" }, id: "t1" }];
        await subscribeShape(shard, ws);
        ws.sent.length = 0;

        await shard.alarm();

        expect(ws.sent).toStrictEqual([]);
    });

    it("re-arms the alarm while a global shape stays subscribed", async () => {
        expect.assertions(1);

        const sockets: FakeWebSocket[] = [];
        const shard = new GlobalShapeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        shard.rows = [{ doc: { _id: "t1" }, id: "t1" }];
        await subscribeShape(shard, ws);
        alarmBox.scheduled = null; // clear the seed-time arm

        await shard.alarm();

        // Still one global subscriber ⇒ the alarm is re-armed for the next tick.
        expect(alarmBox.scheduled).not.toBeNull();
    });

    it("survives hibernation: a fresh instance pokes a delete from the durable baseline", async () => {
        expect.assertions(2);

        // Production shards run `runShardMigrations` (which creates this table) via
        // the codegen subclass; the base test shard's `ensureMigrated` is a no-op,
        // so create the durable snapshot table by hand to exercise the durable path.
        migrateGlobalShapeSnapshot(harness.sql);

        const sockets: FakeWebSocket[] = [];
        const shard = new GlobalShapeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        // A connection id (minted at upgrade in production) keys the durable
        // baseline; without it the snapshot stays in-memory only.
        ws.attachment = { connectionId: "conn-1", subs: {} };
        sockets.push(ws);

        shard.rows = [
            { doc: { _id: "t1", label: "a" }, id: "t1" },
            { doc: { _id: "t2", label: "b" }, id: "t2" },
        ];
        await subscribeShape(shard, ws);

        // Simulate a hibernation eviction: the in-memory snapshot cache is gone,
        // but the durable table + the socket's serialized attachment survive. A
        // brand-new DO instance over the same state + sql is what the runtime wakes.
        const wokenSockets: FakeWebSocket[] = [ws];
        const woken = new GlobalShapeShard(makeState(wokenSockets), {});

        // t2 was deleted from the global backend while the DO slept.
        woken.rows = [{ doc: { _id: "t1", label: "a" }, id: "t1" }];
        ws.sent.length = 0;

        await woken.alarm();

        // The durable baseline still carried t2, so the diff emits its delete —
        // without persistence the empty cold cache would miss it (phantom row).
        expect(frameTypes(ws)).toStrictEqual(["pokeStart", "pokePart", "pokeEnd"]);
        expect(pokeOps(ws)).toStrictEqual([{ key: "t2", op: "delete", table: "things" }]);
    });

    it("does not re-arm the alarm once the global shape is unsubscribed", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new GlobalShapeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        shard.rows = [{ doc: { _id: "t1" }, id: "t1" }];
        await subscribeShape(shard, ws);
        ws.sent.length = 0;

        await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ id: "g1", type: "shape_unsubscribe" }));
        alarmBox.scheduled = null;

        await shard.alarm();

        // No global subscribers remain ⇒ the alarm is not re-armed and the DO idles.
        expect(alarmBox.scheduled).toBeNull();
        expect(pokeOps(ws)).toStrictEqual([]);
    });

    it("contains one socket's poll failure: pokes the healthy socket and still re-arms", async () => {
        expect.assertions(3);

        const sockets: FakeWebSocket[] = [];
        const shard = new FlakyGlobalShard(makeState(sockets), {});
        const ok = createFakeWebSocket();

        ok.attachment = { subs: {}, userId: "ok" };

        const boom = createFakeWebSocket();

        boom.attachment = { subs: {}, userId: "boom" };
        sockets.push(ok, boom);

        shard.rows = [{ doc: { _id: "t1", label: "a" }, id: "t1" }];
        await subscribeShape(shard, ok);
        await subscribeShape(shard, boom);
        ok.sent.length = 0;
        boom.sent.length = 0;

        // The global backend starts rejecting reads for `boom` only, and t1 changes.
        shard.failUserId = "boom";
        shard.rows = [{ doc: { _id: "t1", label: "a2" }, id: "t1" }];
        alarmBox.scheduled = null;

        await shard.alarm();

        // The healthy socket still receives the update...
        expect(pokeOps(ok)).toStrictEqual([{ key: "t1", op: "update", table: "things", value: expect.objectContaining({ label: "a2" }) }]);
        // ...the failing socket's read is contained (no frames leak)...
        expect(boom.sent).toStrictEqual([]);
        // ...and the alarm re-arms despite the failure, so polling survives.
        expect(alarmBox.scheduled).not.toBeNull();
    });

    it("contains a throwing resolveShape on an alarm tick and still re-arms", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new FlakyGlobalShard(makeState(sockets), {});
        const ws = createFakeWebSocket();

        sockets.push(ws);

        shard.rows = [{ doc: { _id: "t1", label: "a" }, id: "t1" }];
        await subscribeShape(shard, ws);
        ws.sent.length = 0;

        // resolveShape now throws (e.g. a revoked-policy lookup blowing up).
        shard.failResolve = true;
        alarmBox.scheduled = null;

        await shard.alarm();

        // No poke leaks from the throwing resolve...
        expect(ws.sent).toStrictEqual([]);
        // ...but the shape stays counted, so the alarm re-arms and retries next tick.
        expect(alarmBox.scheduled).not.toBeNull();
    });
});
