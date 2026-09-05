import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

interface FakeState extends ShardDOState {
    storage: { sql: { databaseSize?: number; exec: (query: string) => unknown } };
}

const createFakeState = (): FakeState => {
    return {
        acceptWebSocket: vi.fn<ShardDOState["acceptWebSocket"]>(),
        getWebSockets: vi.fn<ShardDOState["getWebSockets"]>(() => []),
        id: { name: "test-shard" },
        storage: { sql: { databaseSize: undefined, exec: vi.fn<(query: string) => unknown>() } },
    };
};

/**
 * Probe shard whose `handleRpc` reports the protected system-dispatch flag —
 * the signal a generated `handleRpc` consults to decide whether an `internal`
 * function may run. Exercises the real `/rpc` fetch path (not a stubbed shard),
 * so it verifies the `x-lunora-system` header is honored end-to-end.
 */
class ProbeShardDO extends ShardDO {
    public constructor(state: ShardDOState) {
        super(state, {});
    }

    public override async handleRpc(): Promise<unknown> {
        return { system: this.isSystemDispatch() };
    }
}

const readSystemFlag = async (shard: ProbeShardDO, headers: Record<string, string>): Promise<boolean> => {
    const response = await shard.fetch(
        new Request("https://shard.invalid/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "noop" }),
            headers: { "content-type": "application/json", ...headers },
            method: "POST",
        }),
    );

    const body: { result: { system: boolean } } = await response.json();

    return body.result.system;
};

describe("shardDO system dispatch", () => {
    it("isSystemDispatch() is true only when the x-lunora-system header is set", async () => {
        expect.assertions(2);

        const shard = new ProbeShardDO(createFakeState());

        await expect(readSystemFlag(shard, { "x-lunora-system": "1" })).resolves.toBe(true);
        await expect(readSystemFlag(shard, {})).resolves.toBe(false);
    });

    it("clears the system flag between requests so it never leaks", async () => {
        expect.assertions(1);

        const shard = new ProbeShardDO(createFakeState());

        await readSystemFlag(shard, { "x-lunora-system": "1" });

        await expect(readSystemFlag(shard, {})).resolves.toBe(false);
    });

    /**
     * The admin branch of `fetch` returns before `beginDispatch`, so it used to
     * stamp none of the per-request scope — including the system flag the
     * generated `handleRpc` gates `internal` functions on. A `/rpc` carrying
     * `x-lunora-system: 1` that is parked on an await therefore lent its system
     * bit to any admin call that arrived meanwhile, and `runAs` dispatches
     * straight through that gate.
     *
     * Two overlapping `fetch()` calls on one instance is what the DO actually
     * does — the system request is entered and left parked, exactly the window
     * the shared instance fields are read across.
     */
    it("does not lend a parked system dispatch's flag to a concurrent admin runAs", async () => {
        expect.assertions(3);

        const harness = createSqliteExec();
        let releaseParked = (): void => undefined;
        const parked = new Promise<void>((resolve) => {
            releaseParked = resolve;
        });

        class GatedProbeShardDO extends ShardDO {
            public override async handleRpc(functionPath: string): Promise<unknown> {
                if (functionPath === "park") {
                    await parked;
                }

                return { system: this.isSystemDispatch() };
            }
        }

        const shard = new GatedProbeShardDO(
            {
                acceptWebSocket: vi.fn<ShardDOState["acceptWebSocket"]>(),
                getWebSockets: vi.fn<ShardDOState["getWebSockets"]>(() => []),
                id: { name: "test-shard" },
                storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
            },
            { LUNORA_ADMIN_TOKEN: "s3cret-admin" },
        );

        const parkedDispatch = shard.fetch(
            new Request("https://shard.invalid/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "park" }),
                headers: { "content-type": "application/json", "x-lunora-system": "1" },
                method: "POST",
            }),
        );

        // Let the parked dispatch reach its await, so the system flag is live on
        // the instance while the admin request below runs.
        await Promise.resolve();

        const adminResponse = await shard.fetch(
            new Request("https://shard.invalid/rpc", {
                body: JSON.stringify({
                    args: { args: {}, functionPath: "target", userId: "victim" },
                    functionPath: ADMIN_FUNCTIONS.runAs,
                }),
                headers: { authorization: "Bearer s3cret-admin", "content-type": "application/json" },
                method: "POST",
            }),
        );
        const adminBody: { result: { system: boolean } } = await adminResponse.json();

        expect(adminResponse.status).toBe(200);
        expect(adminBody.result.system).toBe(false);

        // …and the parked dispatch still owns its own flag on the way out: the
        // admin scope restores what it found rather than clearing it.
        releaseParked();

        const parkedResponse = await parkedDispatch;
        const parkedBody: { result: { system: boolean } } = await parkedResponse.json();

        expect(parkedBody.result.system).toBe(true);

        harness.close();
    });
});
