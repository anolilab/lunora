/**
 * A scheduled job's dispatch carries its due time; the shard turns the gap
 * between that and the dispatch into the `scheduler.lag_ms` histogram.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const schema: SchemaLike = { tables: {} };
const NOW = 1_700_000_000_000;

interface SeriesLike {
    attributes?: Record<string, unknown>;
    count: number;
    functionPath: string;
    kind: string;
    last: number;
    name: string;
}

class JobShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- the handler under test does no work; only the dispatch around it matters
    public override async handleRpc(): Promise<unknown> {
        return { ok: true };
    }

    public series(): SeriesLike[] {
        return (this as unknown as { metricSeries: { entries: () => SeriesLike[] } }).metricSeries.entries();
    }
}

const createShard = (): JobShard => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);

    return new JobShard(
        {
            acceptWebSocket: () => undefined,
            getWebSockets: () => [],
            storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
        },
        {},
    );
};

const rpc = (shard: ShardDO, headers: Record<string, string>): Promise<Response> =>
    shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "jobs:sweep" }),
            headers: { "content-type": "application/json", ...headers },
            method: "POST",
        }),
    );

describe("scheduler lag metric", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("records how late a system dispatch started against its due time", async () => {
        expect.assertions(1);

        const shard = createShard();

        await rpc(shard, { "x-lunora-scheduled-for": String(NOW - 250), "x-lunora-system": "1" });

        expect(shard.series().filter((series) => series.name === "scheduler.lag_ms")).toStrictEqual([
            expect.objectContaining({ attributes: { function: "jobs:sweep" }, count: 1, kind: "histogram", last: 250 }),
        ]);
    });

    it("ignores a due time on a dispatch that is not a system call", async () => {
        expect.assertions(1);

        const shard = createShard();

        await rpc(shard, { "x-lunora-scheduled-for": String(NOW - 250) });

        expect(shard.series().filter((series) => series.name === "scheduler.lag_ms")).toHaveLength(0);
    });
});
