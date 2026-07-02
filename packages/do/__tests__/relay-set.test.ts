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

describe("owner promotion hysteresis (plan 075 Phase 4)", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    /**
     * A single owner instance (its `OwnerRelay` collaborator, and thus its
     * `promotionState`, is created once) probed repeatedly with a mutable live
     * socket count — this is the integration surface `nextPromotionState`'s own
     * unit tests (`relay.test.ts`) can't cover, since hysteresis only shows up
     * across successive `relayCount()` calls on the SAME stateful owner.
     */
    const makeProbe = (env: Record<string, string>): { probe: () => Promise<number>; setSocketCount: (count: number) => void } => {
        let socketCount = 0;
        const state = {
            acceptWebSocket() {},
            getWebSockets: () => Array.from({ length: socketCount }, () => ({}) as WebSocket),
            id: { name: "room-1" },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        } as unknown as ShardDOState;
        const shard = new RelaySetShard(state, env);

        return {
            probe: async () => {
                const response = await shard.fetch(new Request("https://shard.internal/_lunora/route", { method: "GET" }));
                const body: { relayCount: number } = await response.json();

                return body.relayCount;
            },
            setSocketCount: (count: number) => {
                socketCount = count;
            },
        };
    };

    const ENV = { LUNORA_MAX_RELAYS: "8", LUNORA_RELAY_COLLAPSE_THRESHOLD: "4", LUNORA_RELAY_FAN: "2", LUNORA_RELAY_THRESHOLD: "8" };

    it("stays owner-served below tUp, promotes at/above tUp, holds through the anti-flap band, and only collapses below tDown", async () => {
        expect.assertions(6);

        const { probe, setSocketCount } = makeProbe(ENV);

        setSocketCount(5);

        await expect(probe()).resolves.toBe(0); // below tUp (8) → owner-served

        setSocketCount(8);

        await expect(probe()).resolves.toBe(2); // reaches tUp → promotes, fan of 2

        // Anti-flap: subscribers drop back into the (tDown, tUp) band, but the
        // shard must STAY promoted rather than flapping back to owner-served.
        setSocketCount(6);

        await expect(probe()).resolves.toBe(2);

        setSocketCount(5);

        await expect(probe()).resolves.toBe(2);

        // Still in-band at exactly tDown (collapse is strictly BELOW tDown).
        setSocketCount(4);

        await expect(probe()).resolves.toBe(2);

        // Drops below tDown (4) → collapses back to owner-served.
        setSocketCount(3);

        await expect(probe()).resolves.toBe(0);
    });

    it("clamps an inverted/too-close collapse threshold instead of throwing on the hot path", async () => {
        expect.assertions(2);

        // LUNORA_RELAY_COLLAPSE_THRESHOLD >= LUNORA_RELAY_THRESHOLD would make an
        // invalid (empty/inverted) hysteresis band; relayCount() must clamp tDown
        // rather than let the reducer throw on every routing probe.
        const { probe, setSocketCount } = makeProbe({
            LUNORA_MAX_RELAYS: "8",
            LUNORA_RELAY_COLLAPSE_THRESHOLD: "10",
            LUNORA_RELAY_FAN: "2",
            LUNORA_RELAY_THRESHOLD: "8",
        });

        setSocketCount(8);

        await expect(probe()).resolves.toBe(2); // promotes at tUp despite the bogus collapse threshold

        setSocketCount(3); // below the clamped tDown (floor(8/2) = 4)

        await expect(probe()).resolves.toBe(0);
    });
});

describe("relay collapse (detach on drain)", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    it("a drained relay detaches from its owner, and re-arms to re-attach", async () => {
        expect.assertions(2);

        // Capture the owner↔relay control messages the relay POSTs to siblings.
        const posts: { body: { relayIndex?: number; type: string }; name: string }[] = [];
        const namespace = {
            // `postRelayMessage` calls `stub.fetch(url, init)` (the DO-stub form workerd
            // accepts), so the body arrives as `init.body`, not a Request.
            get: (id: { __name: string }) => {
                return {
                    fetch: (_input: string, init: { body: string }) => {
                        posts.push({ body: JSON.parse(init.body) as { type: string }, name: id.__name });

                        return Promise.resolve(new Response(null, { status: 204 }));
                    },
                };
            },
            idFromName: (name: string) => {
                return { __name: name };
            },
        };

        const state = {
            acceptWebSocket() {},
            getWebSockets: () => [] as WebSocket[],
            id: { name: "room-1::relay::0" },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        } as unknown as ShardDOState;

        const shard = new RelaySetShard(state, { SHARD: namespace });

        // Teach the relay its namespace binding via any forwarded request.
        await shard.fetch(new Request("https://shard.internal/_lunora/route", { headers: { "x-lunora-shard-binding": "SHARD" }, method: "GET" }));

        // The relay's last socket closes → it detaches from the owner.
        await shard.webSocketClose({} as WebSocket, 1000, "", true);

        const detach = posts.find((post) => post.body.type === "relay_detach");

        expect(detach).toStrictEqual({ body: { relayIndex: 0, type: "relay_detach" }, name: "room-1" });
        expect(detach?.name).toBe("room-1"); // forwarded to the owner, not a relay
    });
});
