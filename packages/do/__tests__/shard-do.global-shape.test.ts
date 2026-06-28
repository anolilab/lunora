import { beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import type { SocketAttachment } from "../src/types";
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
            deleteAlarm() {
                alarmBox.scheduled = null;

                return Promise.resolve();
            },
            getAlarm() {
                return Promise.resolve(alarmBox.scheduled);
            },
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

        expect(frameTypes(ws)).toStrictEqual(["ack", "pokeStart", "pokePart", "pokeEnd"]);

        const ops = pokeOps(ws);

        expect(ops).toHaveLength(2);
        expect(ops).toStrictEqual([
            { key: "t1", op: "insert", table: "things", value: expect.objectContaining({ _id: "t1", label: "a" }) },
            { key: "t2", op: "insert", table: "things", value: expect.objectContaining({ _id: "t2", label: "b" }) },
        ]);
        // The poll alarm is armed so the runtime will call `alarm()` to refresh.
        expect(alarmBox.scheduled).not.toBeNull();
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
});
