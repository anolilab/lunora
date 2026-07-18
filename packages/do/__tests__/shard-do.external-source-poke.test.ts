import { beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { runExternalSourceTick } from "../src/external-source-materialize";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import type { SocketAttachment } from "../src/types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The headline guarantee of plan 077: a poll tick that materializes a sourced
 * table must POKE that table's `defineShape` subscribers live — not merely land
 * rows in SQLite. A sourced table is local (`.shardBy()`/root), so it is poked
 * through the standard changed-table → `pokeShapeSubscribers` path; the alarm has
 * to drain it via `flushChangedTables`. This test subscribes a socket to a sourced
 * table's shape, drives `alarm()`, and asserts the subscriber receives the diff —
 * the regression guard for the "rows land but subscribers never see them" bug.
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
        attachment: { subs: {} },
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

const schema: SchemaLike = {
    tables: { documents: { indexes: [], shape: { orgId: { kind: "string" }, title: { kind: "string" } } } },
};

/** A sourced shard exposing `tenantDocs` (a local shape over `documents`) and an in-memory "Hyperdrive" slice it materializes on the alarm. */
class SourcedShapeShard extends ShardDO {
    public pulled: Record<string, unknown>[] = [];

    // eslint-disable-next-line class-methods-use-this -- unused RPC stub for the ingest/shape path.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }

    protected override async pollExternalSources(): Promise<number | undefined> {
        const writer: DatabaseWriterLike = createShardContextDatabase({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema,
            sql: this.sql as SqlExec,
        });

        await runExternalSourceTick(this.sql as SqlExec, writer, this.pulled, { table: "documents" });

        // Report a plausible next-due time (plan 148: the alarm re-arms at this
        // value, not a bare active count) — the exact number is irrelevant here
        // since this test only asserts on the poke fan-out, not the alarm target.
        return Date.now() + 1000;
    }

    // eslint-disable-next-line class-methods-use-this -- test stub: resolves the one local shape by name.
    protected override resolveShape(name: string): { effectiveWhere?: Record<string, unknown>; table: string } | undefined {
        return name === "tenantDocs" ? { effectiveWhere: {}, table: "documents" } : undefined;
    }
}

let harness: ReturnType<typeof createSqliteExec>;

const makeState = (sockets: FakeWebSocket[]): ShardDOState => {
    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        // No `waitUntil` → `flushChangedTables` awaits the fan-out synchronously, so
        // the poke is observable immediately after `alarm()` resolves.
        storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const subscribe = async (shard: ShardDO, ws: FakeWebSocket): Promise<void> => {
    await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ id: "s1", shape: { name: "tenantDocs" }, type: "shape_subscribe" }));
};

const pokeOps = (ws: FakeWebSocket): { key: string; op: string }[] =>
    ws.sent
        .map((raw) => JSON.parse(raw) as { rowsPatch?: { key: string; op: string }[]; type: string })
        .filter((frame) => frame.type === "pokePart")
        .flatMap((frame) => frame.rowsPatch ?? []);

describe("shardDO external-source poke (alarm materialize reaches subscribers)", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema, { cdc: true });
    });

    it("pokes a sourced table's shape subscriber with the inserts the poll materializes", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new SourcedShapeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        // Subscribe while the table is empty (seeds nothing), then forget the seed frames.
        await subscribe(shard, ws);
        ws.sent.length = 0;

        // The next poll brings two rows; the alarm must materialize AND poke.
        shard.pulled = [
            { _id: "d1", orgId: "org_1", title: "one" },
            { _id: "d2", orgId: "org_1", title: "two" },
        ];

        await shard.alarm();

        const ops = pokeOps(ws);

        expect(ops.map((op) => `${op.op}:${op.key}`).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["insert:d1", "insert:d2"]);
        expect(ops).toHaveLength(2);
    });

    it("pokes update + delete on a later poll, not just inserts", async () => {
        expect.assertions(1);

        const sockets: FakeWebSocket[] = [];
        const shard = new SourcedShapeShard(makeState(sockets), {});
        const ws = createFakeWebSocket();
        sockets.push(ws);

        await subscribe(shard, ws);

        shard.pulled = [
            { _id: "d1", orgId: "org_1", title: "one" },
            { _id: "d2", orgId: "org_1", title: "two" },
        ];
        await shard.alarm();
        ws.sent.length = 0;

        // Upstream: d1 retitled, d2 gone.
        shard.pulled = [{ _id: "d1", orgId: "org_1", title: "one-edited" }];
        await shard.alarm();

        expect(
            pokeOps(ws)
                .map((op) => `${op.op}:${op.key}`)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["delete:d2", "update:d1"]);
    });
});
