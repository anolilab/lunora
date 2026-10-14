import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * What a replica-role DO refuses.
 *
 * A replica runs the owner's class — same generated subclass, same alarm tiers,
 * same routes — and its role is known only from its name. Everything that
 * belongs to the single writer therefore has to be turned off explicitly here,
 * and each of these is a behaviour the engine-level suite cannot see because it
 * is about the DO's wiring rather than the follow loop.
 */
class RoleShard extends ShardDO {
    public readonly dispatched: string[] = [];

    public override async handleRpc(functionPath: string): Promise<unknown> {
        this.dispatched.push(functionPath);

        return { ok: true };
    }

    /** Drive the alarm entry the runner delegates to. */
    public async driveAlarm(): Promise<void> {
        await this.handleAlarmCloudflare();
    }
}

/**
 * Count the alarm's first tier without declaring an override.
 *
 * `pollGlobalShapes` is private on the base class, so a subclass cannot declare
 * it — but dispatch is dynamic, and what is under test is precisely whether the
 * alarm DISPATCHES it at all. Installing the counter on the instance keeps the
 * production surface unchanged and still observes the thing that matters.
 */
const countAlarmWork = (shard: RoleShard): { runs: number } => {
    const seen = { runs: 0 };

    Object.assign(shard, {
        pollGlobalShapes: async () => {
            seen.runs += 1;

            return 0;
        },
    });

    return seen;
};

const rpc = (headers: Record<string, string> = {}): Request =>
    new Request("https://shard.internal/rpc", { body: JSON.stringify({ args: {}, functionPath: "posts:list" }), headers, method: "POST" });

describe("shardDO replica role", () => {
    let harness: ReturnType<typeof createSqliteExec>;

    const shardNamed = (name?: string): RoleShard =>
        new RoleShard(
            {
                getWebSockets: () => [],
                ...(name === undefined ? {} : { id: { name } }),
                storage: { sql: harness.sql },
            } as unknown as ShardDOState,
            {},
        );

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("refuses a dispatch the runtime did not mark as a replica read", async () => {
        expect.assertions(2);

        const shard = shardNamed("tenant-7::replica::weur");
        const response = await shard.fetch(rpc());

        expect(response.status).toBe(421);
        // The gate runs before user code: a mutation that slipped through the
        // routing must not have executed by the time it is rejected.
        expect(shard.dispatched).toStrictEqual([]);
    });

    it("refuses a WebSocket upgrade", async () => {
        expect.assertions(1);

        // A replica advances only when a read triggers a catch-up, so a
        // subscription served here would be a live query that mostly is not.
        const response = await shardNamed("tenant-7::replica::weur").fetch(new Request("https://shard.internal/ws", { headers: { Upgrade: "websocket" } }));

        expect(response.status).toBe(421);
    });

    it("runs no background work on the alarm", async () => {
        expect.assertions(1);

        const shard = shardNamed("tenant-7::replica::weur");
        const work = countAlarmWork(shard);

        await shard.driveAlarm();

        // Every alarm tier the schema arms — external-source polling above all,
        // which resolves its tenant from this DO's own name — would otherwise
        // fire against a copy.
        expect(work.runs).toBe(0);
    });

    it("leaves an owner-role DO untouched", async () => {
        expect.assertions(3);

        const shard = shardNamed("tenant-7");
        const work = countAlarmWork(shard);
        const response = await shard.fetch(rpc());

        await shard.driveAlarm();

        expect(response.status).toBe(200);
        expect(shard.dispatched).toStrictEqual(["posts:list"]);
        // The guard is role-specific, not a blanket disable.
        expect(work.runs).toBe(1);
    });

    it("leaves an unnamed single-DO shard untouched", async () => {
        expect.assertions(1);

        const shard = shardNamed();

        await shard.fetch(rpc());

        expect(shard.dispatched).toStrictEqual(["posts:list"]);
    });
});
