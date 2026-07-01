import { beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db";
import { runExternalSourceTick } from "../src/external-source-materialize";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The external-source ingest tier shares the DO's poll alarm (plan 077). The base
 * `ShardDO.pollExternalSources()` is a no-op (`0`); the codegen subclass overrides
 * it to materialize each sourced table. This test stands in for that subclass: it
 * overrides `pollExternalSources` to run `runExternalSourceTick` over an in-memory
 * "Hyperdrive" rowset, then drives `alarm()` directly — exactly how the real
 * runtime wakes the loop — and asserts the rows land in the DO's SQLite and the
 * shared alarm re-arms.
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

    // eslint-disable-next-line class-methods-use-this -- this shard exercises only the ingest/alarm path; RPC is unused.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }

    protected override async pollExternalSources(): Promise<number> {
        this.pollCount += 1;

        const writer = createShardCtxDb({ broadcast: () => undefined, cdc: true, clock: () => 1_700_000_000_000, schema, sql: this.sql as SqlExec });

        await runExternalSourceTick(this.sql as SqlExec, writer, this.pulled, { table: "documents" });

        // A sourced DO keeps polling, so the shared alarm re-arms each tick.
        return 1;
    }
}

/** A shard that does NOT override `pollExternalSources` — exercises the base no-op (returns 0). */
class BareShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- unused RPC stub for the base-behavior shard.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }
}

const tableIds = (): string[] => (harness.sql.exec("SELECT id FROM documents ORDER BY id").toArray() as { id: string }[]).map((row) => row.id);

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

        // The base `pollExternalSources` returns 0 and there are no global
        // subscribers, so `remaining` is 0 → the alarm neither writes nor re-arms.
        const shard = new BareShard(makeState(), {});

        await shard.alarm();

        expect(tableIds()).toStrictEqual([]);
        expect(alarmBox.scheduled).toBeNull();
    });
});
