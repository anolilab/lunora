import type { FunctionReference } from "@lunora/client";
import { useLunora } from "@lunora/react";

import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions } from "../../lib/internal";

/**
 * The admin RPC that executes a target function under a forged identity — the
 * same primitive the function runner's "Run as identity" tool uses. Routed
 * through `client.query` (the DO intercepts admin RPCs by `functionPath`
 * regardless of method) and gated server-side by the admin bearer.
 */
const RUN_AS = adminRef(ADMIN_FUNCTIONS.runAs);

/**
 * Outcome of a probe run: an allowed result, a denied verdict, or `invalid` —
 * the probe refused to dispatch because the inputs cannot answer the question.
 * `invalid` exists because `denied` is a verdict about the RULE, and the
 * server's own argument validation (a blank `userId` is a `BAD_REQUEST` raised
 * before anything is dispatched) would otherwise arrive down the same catch-all
 * and be painted as a confident denial of a call that never ran.
 */
type ProbeOutcome = { kind: "allowed"; value: unknown } | { kind: "denied"; message: string } | { kind: "invalid"; message: string };

interface RunAsProbeArgs {
    /** Parsed JSON args passed to the probed function. */
    args: Record<string, unknown>;
    /** Dotted function path to dispatch under the forged identity. */
    functionPath: string;
    /** Optional shard key; empty ⇒ the root shard. */
    shardKey?: string;
    /** The userId to forge as the per-request identity. */
    userId: string;
}

/**
 * Dispatch a function under a forged identity via the admin-gated `runAs` RPC and
 * classify the outcome as allowed or denied. This is the single shared probe
 * primitive (the function runner inlines the same `RUN_AS` dispatch); a thrown
 * error — the way RLS surfaces a denial — becomes a `denied` outcome rather than
 * propagating, so the playground renders allow/deny uniformly.
 *
 * A blank `userId` is refused here rather than sent: `runAs` forges an identity,
 * and the server rejects a blank one with a `BAD_REQUEST` before dispatching
 * anything, so sending it would answer with a rejection that says nothing about
 * the rule under test. The function runner and the CLI guard their own dispatch
 * sites the same way; this is the shared one.
 */
const useRunAsProbe = (): ((probe: RunAsProbeArgs) => Promise<ProbeOutcome>) => {
    const client = useLunora();

    return async ({ args, functionPath, shardKey = "", userId }: RunAsProbeArgs): Promise<ProbeOutcome> => {
        if (userId.trim() === "") {
            return { kind: "invalid", message: "No identity to probe: enter the userId whose access you want to test." };
        }

        const reference: FunctionReference = RUN_AS;

        try {
            const value = await client.query(reference, { args, functionPath, userId }, callOptions(shardKey));

            return { kind: "allowed", value };
        } catch (error) {
            return { kind: "denied", message: error instanceof Error ? error.message : String(error) };
        }
    };
};

export default useRunAsProbe;
export type { ProbeOutcome, RunAsProbeArgs };
