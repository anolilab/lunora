import { describe, expect, it } from "vitest";

import type { MaskPoliciesResult } from "../src/introspect";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * The RLS-uniform gate (plan 075 Phase 3): a reactive shape may be relay-multicast
 * ONLY if its resolved query is identical regardless of the caller's identity and
 * none of its projected columns are masked. The gate probes `resolveShape` under
 * two distinct synthetic identities and compares — airtight and fail-closed.
 */
interface Resolved {
    columns?: ReadonlyArray<string>;
    effectiveWhere?: Record<string, unknown>;
    global?: boolean;
    table: string;
}

class GateShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- abstract stub; the gate never dispatches an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({});
    }

    /** Expose the protected gate for the test. */
    public uniform(name: string, args: Record<string, unknown>): boolean {
        return this.isShapeRelayUniform(name, args);
    }

    // eslint-disable-next-line class-methods-use-this -- test fixture: a per-shape masking declaration
    protected override maskMetadata(): MaskPoliciesResult {
        return { columns: [{ column: "ssn", strategy: "redact", table: "people" }] };
    }

    // eslint-disable-next-line class-methods-use-this -- test fixture: a pure name→shape lookup
    protected override resolveShape(name: string, args: Record<string, unknown>, identity?: { userId?: string }): Resolved | undefined {
        switch (name) {
            // No where at all — identity-independent.
            case "allMessages": {
                return { table: "messages" };
            }
            // A `.global()` table is never poke-relayable.
            case "globalFeed": {
                return { effectiveWhere: {}, global: true, table: "feed" };
            }
            // An identity-gated resolve that throws for a probe.
            case "guarded": {
                throw new Error("RLS: auth required");
            }
            // Identity-DEPENDENT: the where is scoped to the caller.
            case "myInbox": {
                return { effectiveWhere: { ownerId: identity?.userId }, table: "messages" };
            }
            // Projects a masked column → the value is identity-dependent.
            case "peopleCard": {
                return { columns: ["name", "ssn"], effectiveWhere: { teamId: args["teamId"] }, table: "people" };
            }
            // Masked column exists on the table but isn't projected → still uniform.
            case "peopleNames": {
                return { columns: ["name"], effectiveWhere: { teamId: args["teamId"] }, table: "people" };
            }
            // Identity-independent: the where depends only on args.
            case "publicRoom": {
                return { effectiveWhere: { roomId: args["roomId"] }, table: "messages" };
            }
            default: {
                return undefined;
            }
        }
    }
}

const makeShard = (): GateShard => {
    const state = { acceptWebSocket() {}, getWebSockets: () => [], id: { name: "room-1" }, storage: { sql: {} } } as unknown as ShardDOState;

    return new GateShard(state, {});
};

describe("relay-uniform shape gate", () => {
    it("marks an identity-independent shape relay-uniform", () => {
        expect.assertions(2);

        const shard = makeShard();

        expect(shard.uniform("publicRoom", { roomId: "r1" })).toBe(true);
        expect(shard.uniform("allMessages", {})).toBe(true);
    });

    it("rejects an identity-dependent shape", () => {
        expect.assertions(1);

        expect(makeShard().uniform("myInbox", {})).toBe(false);
    });

    it("rejects a shape that projects a masked column, but allows one that doesn't", () => {
        expect.assertions(2);

        const shard = makeShard();

        expect(shard.uniform("peopleCard", { teamId: "t1" })).toBe(false);
        expect(shard.uniform("peopleNames", { teamId: "t1" })).toBe(true);
    });

    it("rejects a global-table shape, an unknown shape, and a resolve that throws (fail-closed)", () => {
        expect.assertions(3);

        const shard = makeShard();

        expect(shard.uniform("globalFeed", {})).toBe(false);
        expect(shard.uniform("nope", {})).toBe(false);
        expect(shard.uniform("guarded", {})).toBe(false);
    });
});
