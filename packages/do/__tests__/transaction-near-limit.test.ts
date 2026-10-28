/**
 * A dispatch that comes close to a transaction ceiling without crossing it must
 * say so, once, on its own function path — the line is how a developer sees the
 * transaction that will fail on production-sized data.
 */
import type { SchemaLike, SqlExec, TransactionHeadroomTracker } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const schema: SchemaLike = {
    tables: {
        items: {
            indexes: [],
            shape: { value: { kind: "string" } },
        },
    },
};

interface LoggedLine {
    fields?: Record<string, unknown>;
    functionPath?: string;
    level: string;
    message: string;
}

class NearLimitShard extends ShardDO {
    public writes = 0;

    public override async handleRpc(_functionPath: string, _args: Record<string, unknown>, headroom?: TransactionHeadroomTracker): Promise<unknown> {
        const writer = createShardContextDatabase({ headroom: headroom ?? this.transactionHeadroom(), schema, sql: this.sql as SqlExec });

        for (let index = 0; index < this.writes; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- writes land in order against the one tracker under test
            await writer.insert("items", { value: String(index) });
        }

        return { ok: true };
    }

    /** Fill through a live-query re-run's tracker, as the generated `executeSubscription` mints it. */
    public async fillAsSubscription(functionPath: string, userId: string): Promise<void> {
        const writer = createShardContextDatabase({ headroom: this.subscriptionHeadroom(functionPath, { userId }), schema, sql: this.sql as SqlExec });

        for (let index = 0; index < this.writes; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- writes land in order against the one tracker under test
            await writer.insert("items", { value: String(index) });
        }
    }

    public loggedLines(): LoggedLine[] {
        return (this as unknown as { logs: { entries: () => LoggedLine[] } }).logs.entries();
    }

    // eslint-disable-next-line class-methods-use-this -- tiny so the threshold is reached in a handful of writes
    protected override transactionLimits(): { maxWrittenRows: number } {
        return { maxWrittenRows: 10 };
    }
}

const rpc = (shard: ShardDO, functionPath: string): Promise<Response> =>
    shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );

const createShard = (events: { functionPath?: string; traceId?: string; userId?: string }[] = []): NearLimitShard => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);

    const state: ShardDOState = {
        acceptWebSocket: () => undefined,
        getWebSockets: () => [],
        storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
    };

    return new NearLimitShard(
        state,
        {},
        {
            telemetrySink: () => {
                return {
                    onLog: (event) => {
                        events.push(event);
                    },
                };
            },
        },
    );
};

describe("transaction near-limit warning", () => {
    it("logs one warn line on the dispatch's function path at 80% of a ceiling", async () => {
        expect.assertions(3);

        const shard = createShard();

        shard.writes = 9;

        const response = await rpc(shard, "items:fill");
        const warnings = shard.loggedLines().filter((line) => line.level === "warn");

        expect(response.status).toBe(200);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ fields: { kind: "writtenRows", limit: 10, used: 8 }, functionPath: "items:fill" });
    });

    it("files a live-query re-run's warning under the query and its subscriber", async () => {
        expect.assertions(1);

        const events: { functionPath?: string; traceId?: string; userId?: string }[] = [];
        const shard = createShard(events);

        shard.writes = 9;
        await shard.fillAsSubscription("items:list", "subscriber-1");

        expect(events).toStrictEqual([expect.objectContaining({ functionPath: "items:list", traceId: undefined, userId: "subscriber-1" })]);
    });

    it("warns once per query, not once per re-run", async () => {
        expect.assertions(1);

        const events: { functionPath?: string }[] = [];
        const shard = createShard(events);

        shard.writes = 9;
        await shard.fillAsSubscription("items:list", "subscriber-1");
        await shard.fillAsSubscription("items:list", "subscriber-2");

        expect(events).toHaveLength(1);
    });

    it("stays quiet for a dispatch well inside its ceilings", async () => {
        expect.assertions(1);

        const shard = createShard();

        shard.writes = 2;
        await rpc(shard, "items:fill");

        expect(shard.loggedLines().filter((line) => line.level === "warn")).toHaveLength(0);
    });
});
