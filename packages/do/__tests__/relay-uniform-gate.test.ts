import type { MaskPoliciesResult, RlsPoliciesResult } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * The RLS-uniform gate (plan 075 Phase 3): a reactive shape may be relay-multicast
 * ONLY if its resolved query is identical regardless of the caller's identity and
 * its table declares no mask at all (L7: conservative — any table-level mask
 * disqualifies, whether or not the shape projects the masked column). The gate combines a static RLS
 * read-policy guard with a claim-exhaustive identity probe — proxy-backed, so a
 * resolver reading ANY claim (even a custom one) diverges — whose base is the exact
 * anonymous identity the owner multicasts under, plus a copy backstop. Fail-closed
 * on every ground.
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
            // Reads a CUSTOM claim no hardcoded probe list would name — only the
            // proxy-backed probe (distinct value per ANY accessed key) catches it.
            case "customClaim": {
                return { effectiveWhere: { region: identity?.identity?.["region_code_xyz"] }, table: "messages" };
            }
            // Output is identical per probe (same backing keys) but it ENUMERATES the
            // claims — a wholesale copy the proxy can't differentiate, so the copy
            // backstop must reject it.
            case "enumeratesClaims": {
                return { effectiveWhere: { keys: Object.keys(identity?.identity ?? {}) }, table: "messages" };
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
            // Masked column exists on the table but isn't projected → the L7
            // conservative gate still rejects it (any table-level mask disqualifies).
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

    it("rejects a where reading an arbitrary custom claim (no hardcoded list to miss it)", () => {
        expect.assertions(1);

        expect(makeShard().uniform("customClaim", {})).toBe(false);
    });

    it("rejects a where that enumerates/copies the identity claims (copy backstop)", () => {
        expect.assertions(1);

        expect(makeShard().uniform("enumeratesClaims", {})).toBe(false);
    });

    it("rejects a shape that narrows only for authenticated callers (anon multicast identity is probed)", () => {
        expect.assertions(1);

        expect(makeShard().uniform("authNarrow", {})).toBe(false);
    });

    it("rejects a shape over a table with an RLS read policy, even when its where looks uniform", () => {
        expect.assertions(1);

        expect(makeShard().uniform("securedRoom", { roomId: "r1" })).toBe(false);
    });

    it("rejects any shape on a table that declares a mask, even when the masked column isn't projected (L7 conservative gate)", () => {
        expect.assertions(2);

        const shard = makeShard();

        // Projects the masked `ssn` column → non-uniform.
        expect(shard.uniform("peopleCard", { teamId: "t1" })).toBe(false);
        // Does NOT project `ssn`, but the `people` table declares a mask, so the
        // gate is conservative and still rejects it — a later `select` change (or
        // added column) can't silently widen a cohort to an identity-dependent value.
        expect(shard.uniform("peopleNames", { teamId: "t1" })).toBe(false);
    });

    it("rejects a global-table shape, an unknown shape, and a resolve that throws (fail-closed)", () => {
        expect.assertions(3);

        const shard = makeShard();

        expect(shard.uniform("globalFeed", {})).toBe(false);
        expect(shard.uniform("nope", {})).toBe(false);
        expect(shard.uniform("guarded", {})).toBe(false);
    });
});
