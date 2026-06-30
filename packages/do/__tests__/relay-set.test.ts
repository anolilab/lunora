import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The owner's relay set (plan 075 Phase 2) is the `__lunora_relays` SQLite table,
 * driven by the internal `/_lunora/relay` `relay_attach`/`relay_detach` control
 * messages and read synchronously on the whisper-forward hot path. This exercises
 * that persistence directly in Node (the cross-DO fan-out it drives is covered by
 * the workerd e2e).
 */
class RelaySetShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- abstract stub; the relay-set control path never dispatches an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({});
    }
}

describe("owner relay-set persistence", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let shard: RelaySetShard;

    beforeEach(() => {
        database = createSqliteExec();
        const state = {
            acceptWebSocket() {},
            getWebSockets: () => [],
            id: { name: "room-1" },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        } as unknown as ShardDOState;

        shard = new RelaySetShard(state, {});
    });

    afterEach(() => {
        database.close();
    });

    const post = (body: Record<string, unknown>): Promise<Response> =>
        shard.fetch(
            new Request("https://shard.internal/_lunora/relay", {
                body: JSON.stringify(body),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

    const relayIndices = (): number[] =>
        (database.sql.exec("SELECT idx FROM __lunora_relays ORDER BY idx").toArray() as { idx: bigint | number }[]).map((row) => Number(row.idx));

    it("records attached relays (idempotently) and drops detached ones", async () => {
        expect.assertions(4);

        const attached = await post({ relayIndex: 0, type: "relay_attach" });

        expect(attached.status).toBe(204);

        await post({ relayIndex: 2, type: "relay_attach" });
        await post({ relayIndex: 0, type: "relay_attach" }); // duplicate — INSERT OR IGNORE

        expect(relayIndices()).toStrictEqual([0, 2]);

        await post({ relayIndex: 0, type: "relay_detach" });

        expect(relayIndices()).toStrictEqual([2]);

        // Detaching an absent relay is a no-op, not an error.
        const absent = await post({ relayIndex: 9, type: "relay_detach" });

        expect(absent.status).toBe(204);
    });

    it("rejects a malformed relay control body without throwing", async () => {
        expect.assertions(1);

        const response = await shard.fetch(
            new Request("https://shard.internal/_lunora/relay", { body: "not json", headers: { "content-type": "application/json" }, method: "POST" }),
        );

        expect(response.status).toBe(400);
    });
});

describe("owner promotion probe (/_lunora/route)", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    const probe = async (name: string, socketCount: number, env: Record<string, string>): Promise<number> => {
        const state = {
            acceptWebSocket() {},
            getWebSockets: () => Array.from({ length: socketCount }, () => ({}) as WebSocket),
            id: { name },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        } as unknown as ShardDOState;
        const shard = new RelaySetShard(state, env);
        const response = await shard.fetch(new Request("https://shard.internal/_lunora/route", { method: "GET" }));
        const body: { relayCount: number } = await response.json();

        return body.relayCount;
    };

    const ENV = { LUNORA_MAX_RELAYS: "8", LUNORA_RELAY_FAN: "2", LUNORA_RELAY_THRESHOLD: "3" };

    it("keeps an owner un-promoted below the threshold and promotes at/above it", async () => {
        expect.assertions(3);

        await expect(probe("room-1", 2, ENV)).resolves.toBe(0); // below threshold → owner-served
        await expect(probe("room-1", 3, ENV)).resolves.toBe(2); // at threshold → fan of 2
        await expect(probe("room-1", 9000, ENV)).resolves.toBe(2); // well above → still the configured fan
    });

    it("caps the fan at LUNORA_MAX_RELAYS", async () => {
        expect.assertions(1);

        await expect(probe("room-1", 5, { LUNORA_MAX_RELAYS: "3", LUNORA_RELAY_FAN: "100", LUNORA_RELAY_THRESHOLD: "1" })).resolves.toBe(3);
    });

    it("never promotes a relay-role DO (flat single tier)", async () => {
        expect.assertions(1);

        await expect(probe("room-1::relay::0", 9000, ENV)).resolves.toBe(0);
    });
});
