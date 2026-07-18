import { beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db";
import { runExternalSourceTick } from "../src/external-source-materialize";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import type { SocketAttachment } from "../src/types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The external-source ingest tier shares the DO's poll alarm (plan 077). The base
 * `ShardDO.pollExternalSources()` is dormant (`undefined`); the codegen subclass
 * overrides it to materialize each sourced table and report the earliest
 * NEXT-DUE timestamp across its non-manual sources (plan 148 — NOT a bare active
 * count, so the shared alarm can re-arm at the exact time ingest needs to run
 * instead of spinning at the fixed global-shape floor). This test stands in for
 * that subclass: it overrides `pollExternalSources` to run `runExternalSourceTick`
 * over an in-memory "Hyperdrive" rowset, then drives `alarm()` directly — exactly
 * how the real runtime wakes the loop — and asserts the rows land in the DO's
 * SQLite and the shared alarm re-arms at the reported next-due time.
 */

const schema: SchemaLike = {
    tables: {
        documents: {
            indexes: [],
            shape: { orgId: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;
const alarmBox: { scheduled: null | number } = { scheduled: null };

const makeState = (): ShardDOState => {
    return {
        acceptWebSocket() {
            /* no sockets in this tier */
        },
        getWebSockets() {
            return [];
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

/** A shard whose `pollExternalSources` materializes an in-memory tenant slice — the role codegen fills with a Hyperdrive read. */
class SourcedShard extends ShardDO {
    public pollCount = 0;

    public pulled: Record<string, unknown>[] = [];

    /** The next-due timestamp `pollExternalSources` reports — defaults to "due now" (a short `everyMs`). */
    public nextDueAt: () => number = () => Date.now() + 1000;

    // eslint-disable-next-line class-methods-use-this -- this shard exercises only the ingest/alarm path; RPC is unused.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }

    protected override async pollExternalSources(): Promise<number | undefined> {
        this.pollCount += 1;

        const writer = createShardCtxDb({ broadcast: () => undefined, cdc: true, clock: () => 1_700_000_000_000, schema, sql: this.sql as SqlExec });

        await runExternalSourceTick(this.sql as SqlExec, writer, this.pulled, { table: "documents" });

        // A sourced DO keeps polling, so the shared alarm re-arms each tick — at
        // this source's actual next-due time, not a bare "still active" signal.
        return this.nextDueAt();
    }
}

/** A shard that does NOT override `pollExternalSources` — exercises the base no-op (returns `undefined`). */
class BareShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- unused RPC stub for the base-behavior shard.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }
}

/**
 * A shard combining a sourced table (far-future next-due) with a subscribed
 * `.global()`-table shape — proves the global-shape tier's fixed 2 s cadence
 * wins the `min(...)` even when the source itself doesn't need attention for
 * an hour (plan 148: neither tier may starve the other).
 */
class SourcedAndGlobalShard extends ShardDO {
    public globalRows: { doc: Record<string, unknown>; id: string }[] = [];

    public nextDueAt: () => number = () => Date.now() + 1000;

    // eslint-disable-next-line class-methods-use-this -- this shard exercises only the shape/ingest/alarm path; RPC is unused.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }

    protected override pollExternalSources(): Promise<number | undefined> {
        return Promise.resolve(this.nextDueAt());
    }

    // eslint-disable-next-line class-methods-use-this -- test stub: resolves the one global shape by name.
    protected override resolveShape(name: string): { effectiveWhere?: Record<string, unknown>; global?: boolean; table: string } | undefined {
        return name === "globalThings" ? { effectiveWhere: {}, global: true, table: "documents" } : undefined;
    }

    protected override readGlobalShapeRows(): Promise<{ doc: Record<string, unknown>; id: string }[]> {
        return Promise.resolve(this.globalRows.map((row) => ({ doc: { ...row.doc }, id: row.id })));
    }
}

const tableIds = (): string[] => (harness.sql.exec("SELECT id FROM documents ORDER BY id").toArray() as { id: string }[]).map((row) => row.id);

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

/** State factory for {@link SourcedAndGlobalShard} — unlike {@link makeState}, it tracks accepted sockets so a global-shape subscription is visible to `pollGlobalShapes`. */
const makeStateWithSockets = (sockets: FakeWebSocket[]): ShardDOState => {
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

const subscribeGlobalShape = async (shard: ShardDO, ws: FakeWebSocket): Promise<void> => {
    await shard.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ id: "g1", shape: { name: "globalThings" }, type: "shape_subscribe" }));
};

describe("shardDO external-source ingest tier", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema, { cdc: true });
        alarmBox.scheduled = null;
    });

    it("materializes the pulled slice into SQLite on an alarm tick and re-arms", async () => {
        expect.assertions(3);

        const shard = new SourcedShard(makeState(), {});
        shard.pulled = [
            { _id: "d1", orgId: "org_1", title: "one" },
            { _id: "d2", orgId: "org_1", title: "two" },
        ];

        await shard.alarm();

        expect(tableIds()).toStrictEqual(["d1", "d2"]);
        // The shared poll alarm re-armed because the sourced tier still has work.
        expect(alarmBox.scheduled).not.toBeNull();
        expect(shard.pollCount).toBe(1);
    });

    it("applies the upstream delta on the next tick — update, insert, and delete", async () => {
        expect.assertions(2);

        const shard = new SourcedShard(makeState(), {});
        shard.pulled = [
            { _id: "d1", orgId: "org_1", title: "one" },
            { _id: "d2", orgId: "org_1", title: "two" },
        ];
        await shard.alarm();

        // Upstream: d1 retitled, d2 gone, d3 new.
        shard.pulled = [
            { _id: "d1", orgId: "org_1", title: "one-edited" },
            { _id: "d3", orgId: "org_1", title: "three" },
        ];
        await shard.alarm();

        expect(tableIds()).toStrictEqual(["d1", "d3"]);

        const d1 = harness.sql.exec("SELECT __doc__ FROM documents WHERE id = 'd1'").toArray() as { __doc__: string }[];

        expect(JSON.parse(d1[0]!.__doc__).title).toBe("one-edited");
    });

    it("is dormant for the base ShardDO (no sourced tables) — alarm materializes nothing and does not re-arm", async () => {
        expect.assertions(2);

        // The base `pollExternalSources` returns `undefined` (dormant) and there
        // are no global subscribers, so neither tier has pending work → the alarm
        // neither writes nor re-arms.
        const shard = new BareShard(makeState(), {});

        await shard.alarm();

        expect(tableIds()).toStrictEqual([]);
        expect(alarmBox.scheduled).toBeNull();
    });

    it("re-arms at the source's actual next-due time, not the 2 s global-shape floor (plan 148)", async () => {
        expect.assertions(2);

        const shard = new SourcedShard(makeState(), {});
        const oneHourMs = 3_600_000;
        const before = Date.now();

        shard.pulled = [{ _id: "d1", orgId: "org_1", title: "one" }];
        // Simulate a source with `refresh: { everyMs: 3_600_000 }` that was just
        // polled — its next-due time is roughly an hour away.
        shard.nextDueAt = () => Date.now() + oneHourMs;

        await shard.alarm();

        expect(alarmBox.scheduled).not.toBeNull();
        // Far in the future — nowhere near the 2 s floor — and bounded above by a
        // generous slack so the assertion isn't flaky on a slow CI tick.
        expect(alarmBox.scheduled!).toBeGreaterThanOrEqual(before + oneHourMs - 1000);
    });

    it("still ticks at the 2 s global-shape floor even when a subscribed source's next-due is an hour away (plan 148)", async () => {
        expect.assertions(2);

        const sockets: FakeWebSocket[] = [];
        const shard = new SourcedAndGlobalShard(makeStateWithSockets(sockets), {});
        const ws = createFakeWebSocket();

        sockets.push(ws);
        shard.globalRows = [{ doc: { _id: "g1" }, id: "g1" }];
        await subscribeGlobalShape(shard, ws);

        const oneHourMs = 3_600_000;
        const before = Date.now();

        shard.nextDueAt = () => Date.now() + oneHourMs;
        alarmBox.scheduled = null; // clear the seed-time arm

        await shard.alarm();

        // The global-shape tier's fixed floor wins the `min(...)` — the alarm
        // ticks again within (well under) the hour, not after it.
        expect(alarmBox.scheduled).not.toBeNull();
        expect(alarmBox.scheduled!).toBeLessThan(before + oneHourMs);
    });
});
