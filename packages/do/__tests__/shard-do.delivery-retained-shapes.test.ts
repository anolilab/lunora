import { readGlobalShapeSnapshot, readShapePokeCursor, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryAuthorization } from "../src/delivery-authorization";
import type { ShardDOState } from "../src/shard-do";
import { Socket, TestShard } from "./_helpers/delivery-authorization";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

class ShapeShard extends TestShard {
    public globalReads = 0;
    private readonly shapes = new Map([
        ["global", { global: true, table: "profiles" }],
        ["local", { table: "messages" }],
    ]);

    public enableAuthorization(authority: DeliveryAuthorization): void {
        // Preserve warm memos while exercising the same guard a new deployment enables.
        Reflect.set(this, "deliveryAuthorization", authority);
    }

    protected override resolveShape(name: string): { global?: boolean; table: string } | undefined {
        return this.shapes.get(name);
    }

    protected override readGlobalShapeRows(): Promise<{ doc: Record<string, unknown>; id: string }[]> {
        this.globalReads += 1;
        return Promise.resolve([{ doc: { userId: "alice" }, id: "profile" }]);
    }
}

const databases: ReturnType<typeof createSqliteExec>[] = [];

const setup = async (withShapes = true) => {
    const database = createSqliteExec();
    databases.push(database);
    runShardMigrations(database.sql, messagesSchema, { cdc: true });
    let socket = new Socket();
    socket.attachment.connectionId = "retained-connection";
    const setAlarm = vi.fn<() => Promise<void>>(async () => {});
    const getWebSockets = vi.fn<(tag?: string) => WebSocket[]>(() => [socket as unknown as WebSocket]);
    const state: ShardDOState = {
        acceptWebSocket() {},
        getWebSockets,
        storage: { setAlarm, sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
    const shard = new ShapeShard(state, {});
    const subscribeShape = (name: string) =>
        shard.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "shape_subscribe", id: name, shape: { name } }));
    if (withShapes) {
        await subscribeShape("local");
        await subscribeShape("global");
    }
    await shard.webSocketMessage(
        socket as unknown as WebSocket,
        JSON.stringify({ type: "subscribe", id: "ordinary", query: { functionPath: "messages:list", args: {} } }),
    );
    const authority = vi.fn<DeliveryAuthorization>(async () => {
        return { scope: "alice", epoch: 0 };
    });
    const enable = (hibernated: boolean): ShapeShard => {
        if (hibernated) {
            const resumed = new Socket();
            resumed.attachment = structuredClone(socket.attachment);
            socket = resumed;
            return new ShapeShard(state, {}, { deliveryAuthorization: authority });
        }
        shard.enableAuthorization(authority);
        return shard;
    };
    const write = (target: ShapeShard) =>
        target.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:write", args: {} }),
            }),
        );
    return { authority, database, enable, getWebSockets, setAlarm, shard, socket: () => socket, state, write };
};

const refresh = async (test: Awaited<ReturnType<typeof setup>>, shard: ShapeShard): Promise<void> => {
    const response = await test.write(shard);

    expect(response.status).toBe(200);
};
const alarm = async (_test: Awaited<ReturnType<typeof setup>>, shard: ShapeShard): Promise<void> => shard.alarm();

describe("retained shapes when delivery authorization is enabled", () => {
    afterEach(() => {
        for (const database of databases.splice(0)) {
            database.close();
        }
    });

    it.each([
        { hibernated: false, withShapes: false },
        { hibernated: false, withShapes: true },
        { hibernated: true, withShapes: false },
        { hibernated: true, withShapes: true },
    ])("stops scanning after a complete sweep with shapes=$withShapes and hibernated=$hibernated", async ({ hibernated, withShapes }) => {
        expect.hasAssertions();

        const test = await setup(withShapes);
        const shard = test.enable(hibernated);

        test.getWebSockets.mockClear();

        await shard.alarm();

        expect(Object.keys(test.socket().attachment.shapes ?? {})).toEqual([]);

        test.getWebSockets.mockClear();

        await shard.alarm();

        const alarmScans = test.getWebSockets.mock.calls.length;

        test.getWebSockets.mockClear();

        shard.rows = ["after"];
        await refresh(test, shard);

        // Ordinary subscriptions still need one fan-out; retired shapes need none.
        expect({ alarmScans, writeScans: test.getWebSockets.mock.calls.length }).toEqual({ alarmScans: 0, writeScans: 1 });
        expect(test.socket().frames.findLast((frame) => frame.type === "data")).toMatchObject({ id: "ordinary", data: ["after"] });
    });

    it("retries an interrupted shape sweep before disabling further scans", async () => {
        expect.hasAssertions();

        const test = await setup();
        const shard = test.enable(true);
        // Complete room cleanup first so the failure belongs to the shape sweep.
        await shard.webSocketMessage(test.socket() as unknown as WebSocket, JSON.stringify({ type: "connect" }));
        // A fresh instance over the same state starts with an empty attachment cache, so the
        // sweep's read must reach storage to fail there.
        const woken = new ShapeShard(test.state, {}, { deliveryAuthorization: test.authority });

        vi.spyOn(test.socket(), "deserializeAttachment").mockImplementationOnce(() => {
            throw new Error("attachment read unavailable");
        });

        test.setAlarm.mockClear();

        await woken.alarm();

        expect(Object.keys(test.socket().attachment.shapes ?? {})).toEqual(["local", "global"]);
        // The read failed before any shape was refused, so the failure belongs to the shape sweep.
        expect(test.socket().frames.filter((frame) => frame.type === "error")).toEqual([]);
        expect(test.setAlarm).toHaveBeenCalledTimes(1);

        await shard.alarm();

        expect(test.socket().frames.filter((frame) => frame.type === "error")).toHaveLength(2);
        expect(test.socket().attachment.shapes).toEqual({});
        expect(readShapePokeCursor(test.database.sql, "retained-connection", "local")).toBeUndefined();
        expect(readGlobalShapeSnapshot(test.database.sql, "retained-connection", "global")).toBeUndefined();

        test.getWebSockets.mockClear();

        await shard.alarm();

        expect(test.getWebSockets).not.toHaveBeenCalled();
        expect(shard.globalReads).toBe(0);
    });

    it.each([
        { hibernated: false, path: "refresh", run: refresh },
        { hibernated: false, path: "alarm", run: alarm },
        { hibernated: true, path: "refresh", run: refresh },
        { hibernated: true, path: "alarm", run: alarm },
    ])("removes both shapes on $path with hibernated=$hibernated", async ({ hibernated, run }) => {
        expect.hasAssertions();

        const test = await setup();

        expect(readShapePokeCursor(test.database.sql, "retained-connection", "local")).toBeDefined();
        expect(readGlobalShapeSnapshot(test.database.sql, "retained-connection", "global")).toBeDefined();

        const shard = test.enable(hibernated);
        const socket = test.socket();
        socket.frames.length = 0;

        test.setAlarm.mockClear();

        const reads = shard.globalReads;

        await run(test, shard);

        expect(socket.frames.filter((frame) => frame.type === "error")).toEqual([
            expect.objectContaining({ id: "local", code: "NOT_IMPLEMENTED" }),
            expect.objectContaining({ id: "global", code: "NOT_IMPLEMENTED" }),
        ]);
        expect(socket.attachment.shapes).toEqual({});

        const caches = shard as unknown as {
            globalShapeSnapshots: WeakMap<object, Map<string, unknown>>;
            shapeMemos: WeakMap<object, Map<string, unknown>>;
        };

        expect(caches.shapeMemos.get(socket)?.size ?? 0).toBe(0);
        expect(caches.globalShapeSnapshots.get(socket)?.size ?? 0).toBe(0);
        expect(Object.keys(socket.attachment.subs)).toEqual(["ordinary"]);
        expect(readShapePokeCursor(test.database.sql, "retained-connection", "local")).toBeUndefined();
        expect(readGlobalShapeSnapshot(test.database.sql, "retained-connection", "global")).toBeUndefined();
        expect(socket.frames.some((frame) => String(frame.type).startsWith("poke"))).toBe(false);
        expect(shard.globalReads).toBe(reads);
        expect(test.setAlarm).not.toHaveBeenCalled();

        shard.rows = ["after"];

        await refresh(test, shard);

        await shard.alarm();

        expect(socket.frames.filter((frame) => frame.type === "error")).toHaveLength(2);
        expect(socket.frames.findLast((frame) => frame.type === "data")).toMatchObject({ id: "ordinary", data: ["after"] });
        expect(test.authority).toHaveBeenCalledWith(expect.objectContaining({ functionPath: "messages:list" }));
        expect(test.setAlarm).not.toHaveBeenCalled();
    });

    it("cleans retained shapes even when the socket cannot receive the error", async () => {
        expect.hasAssertions();

        const test = await setup();
        const shard = test.enable(true);
        vi.spyOn(test.socket(), "send").mockImplementation(() => {
            throw new Error("socket closed");
        });

        test.setAlarm.mockClear();

        await shard.alarm();

        expect(test.socket().attachment.shapes).toEqual({});
        expect(readShapePokeCursor(test.database.sql, "retained-connection", "local")).toBeUndefined();
        expect(readGlobalShapeSnapshot(test.database.sql, "retained-connection", "global")).toBeUndefined();
        expect(test.setAlarm).not.toHaveBeenCalled();
    });

    it("retries failed attachment cleanup without reading shape data", async () => {
        expect.hasAssertions();

        const test = await setup();
        const shard = test.enable(true);
        vi.spyOn(test.socket(), "serializeAttachment").mockImplementationOnce(() => {
            throw new Error("attachment unavailable");
        });

        test.setAlarm.mockClear();

        await shard.alarm();

        expect(Object.keys(test.socket().attachment.shapes ?? {})).toEqual(["local"]);
        expect(readShapePokeCursor(test.database.sql, "retained-connection", "local")).toBeDefined();
        expect(readGlobalShapeSnapshot(test.database.sql, "retained-connection", "global")).toBeUndefined();
        expect(test.setAlarm).toHaveBeenCalledTimes(1);

        test.setAlarm.mockClear();

        await shard.alarm();

        expect(test.socket().attachment.shapes).toEqual({});
        expect(readShapePokeCursor(test.database.sql, "retained-connection", "local")).toBeUndefined();
        expect(shard.globalReads).toBe(0);
        expect(test.setAlarm).not.toHaveBeenCalled();

        test.getWebSockets.mockClear();

        await shard.alarm();

        expect(test.getWebSockets).not.toHaveBeenCalled();
    });

    it("keeps scanning until every socket is clean, not just the last one swept", async () => {
        expect.hasAssertions();

        const test = await setup();
        const shard = test.enable(true);
        const second = new Socket();
        second.attachment = structuredClone(test.socket().attachment);

        test.getWebSockets.mockImplementation(() => [test.socket(), second] as unknown as WebSocket[]);

        // The first socket keeps a registration because its attachment write fails; the last one sweeps clean.
        vi.spyOn(test.socket(), "serializeAttachment").mockImplementationOnce(() => {
            throw new Error("attachment unavailable");
        });

        test.setAlarm.mockClear();

        await shard.alarm();

        expect(Object.keys(test.socket().attachment.shapes ?? {})).toEqual(["local"]);
        expect(second.attachment.shapes).toEqual({});
        expect(test.setAlarm).toHaveBeenCalledTimes(1);

        await shard.alarm();

        expect(test.socket().attachment.shapes).toEqual({});

        test.getWebSockets.mockClear();

        await shard.alarm();

        expect(test.getWebSockets).not.toHaveBeenCalled();
    });

    it("keeps both shapes and global polling when the feature stays off", async () => {
        expect.hasAssertions();

        const test = await setup();

        test.socket().frames.length = 0;

        test.setAlarm.mockClear();

        await refresh(test, test.shard);

        await test.shard.alarm();

        expect(Object.keys(test.socket().attachment.shapes ?? {})).toEqual(["local", "global"]);
        expect(test.socket().frames.filter((frame) => frame.type === "error")).toEqual([]);
        expect(test.shard.globalReads).toBeGreaterThan(1);
        expect(test.setAlarm).toHaveBeenCalledTimes(1);
        expect(readShapePokeCursor(test.database.sql, "retained-connection", "local")).toBeDefined();
        expect(readGlobalShapeSnapshot(test.database.sql, "retained-connection", "global")).toBeDefined();
    });
});
