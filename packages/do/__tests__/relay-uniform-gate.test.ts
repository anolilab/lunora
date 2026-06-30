import { describe, expect, it } from "vitest";

import type { MaskPoliciesResult, RlsPoliciesResult } from "../src/introspect";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * The RLS-uniform gate (plan 075 Phase 3): a reactive shape may be relay-multicast
 * ONLY if its resolved query is identical regardless of the caller's identity and
 * none of its projected columns are masked. The gate combines a static RLS
 * read-policy guard with a claim-diverse identity probe (whose base is the exact
 * anonymous identity the owner multicasts under) — fail-closed on every ground.
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

    // A declared RLS *read* policy on `secured` — its presence alone must keep any
    // shape over that table off the relay, even when the resolved where looks uniform.
    // eslint-disable-next-line class-methods-use-this -- test fixture: a per-table RLS read-policy declaration
    protected override rlsMetadata(): RlsPoliciesResult {
        return { policies: [{ file: "secured", on: "read", procedure: "listSecured", table: "secured" }], roles: [] };
    }

    // eslint-disable-next-line class-methods-use-this -- test fixture: a pure name→shape lookup
    protected override resolveShape(
        name: string,
        args: Record<string, unknown>,
        identity?: { identity?: Record<string, unknown>; userId?: string },
    ): Resolved | undefined {
        switch (name) {
            // No where at all — identity-independent.
            case "allMessages": {
                return { table: "messages" };
            }
            // Narrows ONLY for an authenticated caller — uniform under the old
            // two-authed-probe gate, but the anonymous multicast identity diverges.
            case "authNarrow": {
                return identity?.userId === undefined ? { table: "messages" } : { effectiveWhere: { published: true }, table: "messages" };
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
            // Identity-DEPENDENT on a NON-userId claim (org) — only caught when the
            // probes vary more than `userId`.
            case "orgScoped": {
                return { effectiveWhere: { org: identity?.identity?.["org_id"] }, table: "messages" };
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
            // Resolved where is identity-independent, but the table carries an RLS
            // read policy → the static guard must still reject it.
            case "securedRoom": {
                return { effectiveWhere: { roomId: args["roomId"] }, table: "secured" };
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

    it("rejects identity-dependence on a non-userId claim (claim-diverse probes)", () => {
        expect.assertions(1);

        expect(makeShard().uniform("orgScoped", {})).toBe(false);
    });

    it("rejects a shape that narrows only for authenticated callers (anon multicast identity is probed)", () => {
        expect.assertions(1);

        expect(makeShard().uniform("authNarrow", {})).toBe(false);
    });

    it("rejects a shape over a table with an RLS read policy, even when its where looks uniform", () => {
        expect.assertions(1);

        expect(makeShard().uniform("securedRoom", { roomId: "r1" })).toBe(false);
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
