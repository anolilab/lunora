import { describe, expect, it } from "vitest";

import { ORIGIN_PAYWALL_APPLIED, ORIGIN_PAYWALL_HEADER } from "../../../shared/origin-paywall";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/** Stands in for the codegen override that consults `LUNORA_FUNCTIONS[path].x402`. */
class PaidShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; routes by functionPath only
    public override async handleRpc(): Promise<unknown> {
        return { report: "paid-content" };
    }

    // eslint-disable-next-line class-methods-use-this -- override hook; the registry lookup needs no instance state
    protected override isPaidFunction(functionPath: string): boolean {
        return functionPath === "billing:premiumReport";
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

const rpc = (functionPath: string, headers: Record<string, string> = {}): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
    });

describe("shardDO — the paid (`.x402`) dispatch backstop", () => {
    it("refuses a paid procedure whose dispatch carries no origin paywall marker", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new PaidShard(makeState(database), {});

            // A worker built without `functions` (`createLunoraHandler()`, a
            // hand-rolled `createWorker({ shardDO })`) cannot read the `.x402` tag,
            // so it dispatches with no marker — and the shard must not serve the
            // paid result free.
            const response = await shard.fetch(rpc("billing:premiumReport"));

            expect(response.status).toBe(500);
            await expect(response.json()).resolves.toMatchObject({ error: { code: "MISCONFIGURED" } });
        } finally {
            database.close();
        }
    });

    it("serves a paid procedure once the origin says it applied the paywall", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new PaidShard(makeState(database), {});
            const response = await shard.fetch(rpc("billing:premiumReport", { [ORIGIN_PAYWALL_HEADER]: ORIGIN_PAYWALL_APPLIED }));

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({ result: { report: "paid-content" } });
        } finally {
            database.close();
        }
    });

    it("leaves free procedures alone on a marker-less dispatch", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new PaidShard(makeState(database), {});
            const response = await shard.fetch(rpc("reports:latest"));

            expect(response.status).toBe(200);
        } finally {
            database.close();
        }
    });

    it("refuses a paid procedure smuggled through the batch transport", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new PaidShard(makeState(database), {});
            const response = await shard.fetch(
                new Request("https://shard.internal/rpc-batch", {
                    body: JSON.stringify({ calls: [{ args: {}, functionPath: "billing:premiumReport", id: 0 }] }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            const body = await response.json<{ results: { body: unknown; status: number }[] }>();

            expect(body.results[0]!.status).toBe(500);
            expect(body.results[0]!.body).toMatchObject({ error: { code: "MISCONFIGURED" } });
        } finally {
            database.close();
        }
    });
});
