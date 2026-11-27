import type { SchemaLike } from "@lunora/shard-engine";
import { recordScheduleOutbox, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A schedule-outbox replay runs on the poll alarm, with no caller behind it. The user a deferred
 * schedule was made for is fixed in the custody record (`dedupUserId`, set by `@lunora/server`'s
 * facade), and the replay must hand that stored value to the scheduler client, which derives the
 * job's dedup scope from it: a replay that dropped it would land the job in another scope.
 */

const NOW = 1_700_000_000_000;

const schema: SchemaLike = { tables: { notes: { indexes: [], shape: { body: { kind: "string" } } } } };

let harness: ReturnType<typeof createSqliteExec>;

const makeState = (): ShardDOState => {
    return {
        acceptWebSocket() {
            /* no sockets in this test */
        },
        getWebSockets() {
            return [];
        },
        storage: {
            getAlarm: () => null,
            setAlarm: () => Promise.resolve(),
            sql: harness.sql as unknown as ShardDOState["storage"]["sql"],
        } as ShardDOState["storage"],
    };
};

class ReplayShard extends ShardDO {
    public readonly replayed: Record<string, unknown>[] = [];

    // eslint-disable-next-line class-methods-use-this -- this shard exercises only the alarm path; RPC is unused.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({ ok: true });
    }

    protected override scheduleOutboxScheduler(): undefined {
        return {
            runAt: (_when: number, _target: unknown, _args: unknown, options: Record<string, unknown> | undefined) => {
                this.replayed.push(options ?? {});

                return Promise.resolve(typeof options?.["id"] === "string" ? options["id"] : "job");
            },
        } as never;
    }
}

describe("schedule-outbox replay — scheduling user", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    });

    afterEach(() => {
        vi.useRealTimers();
        harness.close();
    });

    it("hands the stored dedupUserId and dedupKey to the scheduler client", async () => {
        expect.assertions(1);

        recordScheduleOutbox(
            harness.sql,
            "job-1",
            JSON.stringify({ args: {}, options: { dedupKey: "daily", dedupUserId: "user-1" }, target: "jobs:run", when: NOW + 60_000 }),
            NOW,
        );

        const shard = new ReplayShard(makeState(), {});

        await shard.alarm();

        expect(shard.replayed).toStrictEqual([{ dedupKey: "daily", dedupUserId: "user-1", id: "job-1" }]);
    });
});
