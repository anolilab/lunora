import { describe, expect, it } from "vitest";

import type { ShardDOState, TelemetrySink } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The generated `buildCtx` instruments `ctx.db` through `instrumentDb` and THEN attaches one facade per table onto
 * the instrumented object (`db["notes"] = bindTableFacade(db, "notes")`) before handing it to the handler. A deployment
 * with a telemetry sink gets a wrapper there; `lunora dev` has none and gets the raw object. This pins that the
 * handler sees the same facades either way.
 */

const fakeDatabase = (): Record<string, unknown> => {
    return { findMany: async (): Promise<unknown[]> => [] };
};

class FacadeShard extends ShardDO {
    public constructor(
        state: ShardDOState,
        private readonly sink: TelemetrySink | undefined,
    ) {
        super(state, {});
    }

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const database = this.instrumentDb(fakeDatabase(), functionPath, this.resolveDispatchAnchor(false), this.sink);

        database["notes"] = { findFirst: async (): Promise<string> => "row" };

        return (database["notes"] as { findFirst: () => Promise<string> }).findFirst();
    }
}

const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const rpc = (sink: TelemetrySink | undefined): Promise<Response> => {
    const database = createSqliteExec();
    const shard = new FacadeShard(makeState(database), sink);

    return shard
        .fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "notes:first" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        )
        .finally(() => {
            database.close();
        });
};

describe("a table facade attached to an instrumented ctx.db", () => {
    const cases: [label: string, sink: TelemetrySink | undefined][] = [
        ["with no telemetry sink (the dev shape)", undefined],
        ["with a summary sink", { instrumentDatabase: "summary" }],
        ["with a spans sink", { instrumentDatabase: "spans" }],
    ];

    it.each(cases)("is readable %s", async (_label, sink) => {
        expect.assertions(2);

        const response = await rpc(sink);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ result: "row" });
    });
});
