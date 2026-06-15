import type { FunctionReference } from "@lunora/client";
import { useLunora } from "@lunora/react";
import { useCallback } from "react";

import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions } from "../../lib/internal";

/**
 * The admin RPC that executes a target function under a forged identity — the
 * same primitive the function runner's "Run as identity" tool uses. Routed
 * through `client.query` (the DO intercepts admin RPCs by `functionPath`
 * regardless of method) and gated server-side by the admin bearer.
 */
const RUN_AS = adminRef(ADMIN_FUNCTIONS.runAs);

/** Outcome of a probe run: an allowed result or a denied/error message. */
type ProbeOutcome = { kind: "allowed"; value: unknown } | { kind: "denied"; message: string };

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
 */
const useRunAsProbe = (): ((probe: RunAsProbeArgs) => Promise<ProbeOutcome>) => {
    const client = useLunora();

    return useCallback(
        async ({ args, functionPath, shardKey = "", userId }: RunAsProbeArgs): Promise<ProbeOutcome> => {
            const reference: FunctionReference = RUN_AS;

            try {
                const value = await client.query(reference, { args, functionPath, userId }, callOptions(shardKey));

                return { kind: "allowed", value };
            } catch (error) {
                return { kind: "denied", message: error instanceof Error ? error.message : String(error) };
            }
        },
        [client],
    );
};

export default useRunAsProbe;
export type { ProbeOutcome, RunAsProbeArgs };
