import { LunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/* eslint-disable no-secrets/no-secrets -- doc comment names framework classes/methods, not credentials */

/**
 * Plan 118: `OwnerRelay.buildShapeSeedFrames`'s `resolveShape` catch now routes
 * through `toErrorBody` instead of embedding a caught error's raw `.message`
 * directly into the `relay_shape_subscribe` reply — the relay surfaces that
 * `error` verbatim to the subscribing socket (see `relay.ts`'s `RelayShapeSeed`
 * doc), so an unredacted internal message there is a real leak. This drives the
 * owner's real `/_lunora/relay` control-channel path (the same one a sibling
 * relay POSTs to) rather than constructing an `OwnerRelay` + `RelayHost` mock by
 * hand, so it also pins the control-channel wiring itself.
 */
/* eslint-enable no-secrets/no-secrets */
class ThrowingShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- abstract stub; this test never dispatches a user RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({});
    }

    // eslint-disable-next-line class-methods-use-this -- test fixture: force `resolveShape` down the throwing branch for one shape name, per case
    protected override resolveShape(name: string): { table: string } | undefined {
        if (name === "internalThrow") {
            throw new Error('column "secret_column" does not exist — raw SQL detail');
        }

        if (name === "structuredThrow") {
            throw new LunoraError("CONFLICT", "cross-shard join guard tripped");
        }

        return { table: "messages" };
    }
}

describe("ownerRelay.buildShapeSeedFrames — resolveShape throw envelope (toErrorBody migration)", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let shard: ThrowingShard;

    beforeEach(() => {
        database = createSqliteExec();

        const state = {
            acceptWebSocket() {},
            getWebSockets: () => [],
            id: { name: "room-1" },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        } as unknown as ShardDOState;

        shard = new ThrowingShard(state, {});
    });

    afterEach(() => {
        database.close();
    });

    const subscribe = (name: string): Promise<Response> =>
        shard.fetch(
            new Request("https://shard.internal/_lunora/relay", {
                body: JSON.stringify({ args: {}, name, subId: "sub-1", type: "relay_shape_subscribe" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

    it("redacts an unrecognized resolveShape throw instead of leaking its raw message", async () => {
        expect.assertions(2);

        const response = await subscribe("internalThrow");
        const body = await response.json<{ error?: { code: string; message: string } }>();

        expect(body.error?.code).toBe("SHAPE_RESOLVE_FAILED");
        expect(body.error?.message).toBe("shape resolution failed");
    });

    it("still surfaces a recognized LunoraError's real code + message", async () => {
        expect.assertions(2);

        const response = await subscribe("structuredThrow");
        const body = await response.json<{ error?: { code: string; message: string } }>();

        expect(body.error?.code).toBe("CONFLICT");
        expect(body.error?.message).toBe("cross-shard join guard tripped");
    });
});
