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
 * The error codes that ARE a verdict on the probed identity's access: an RLS
 * policy refusing the row (`FORBIDDEN`, what `rls(...)` throws on a denied
 * read/write), a secure-by-default table with no resolved policy
 * (`RLS_REQUIRED`), and a missing/unverified identity (`UNAUTHORIZED`).
 *
 * Everything else the dispatch can throw — a validation failure, an unknown
 * function path, an application error inside the handler, the admin gate itself
 * rejecting — says nothing about the rule under test, so it must not be painted
 * as a denial. A probe that cannot tell "the server refused you" from "your
 * query was malformed" is not a verification tool.
 */
const DENIAL_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "RLS_REQUIRED", "UNAUTHORIZED"]);

/** The machine `code` the client copies off the server's error envelope, when it carried one. */
const errorCode = (error: unknown): string | undefined => {
    const candidate = (error as { code?: unknown } | null | undefined)?.code;

    return typeof candidate === "string" ? candidate : undefined;
};

/**
 * Outcome of a probe run: an allowed result, a denied verdict, `errored` — the
 * dispatch failed for a reason that is not an access verdict — or `invalid`,
 * where the probe refused to dispatch because the inputs cannot answer the
 * question.
 *
 * `invalid` exists because `denied` is a verdict about the RULE, and the
 * server's own argument validation (a blank `userId` is a `BAD_REQUEST` raised
 * before anything is dispatched) would otherwise arrive down the same catch-all
 * and be painted as a confident denial of a call that never ran. `errored` is
 * the same argument applied to everything the dispatch itself can throw.
 */
type ProbeOutcome =
    { kind: "allowed"; value: unknown } | { kind: "denied"; message: string } | { kind: "errored"; message: string } | { kind: "invalid"; message: string };

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
 * classify the outcome. This is the single shared probe primitive (the function
 * runner inlines the same `RUN_AS` dispatch); a thrown error is caught rather
 * than propagating, so the playground renders every outcome uniformly — but only
 * an auth/RLS {@link DENIAL_CODES} code becomes the destructive `denied` verdict.
 * Anything else is `errored`: the probe ran and failed, which is not the same
 * claim as "this identity may not do this".
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
            const message = error instanceof Error ? error.message : String(error);
            const code = errorCode(error);

            return code !== undefined && DENIAL_CODES.has(code) ? { kind: "denied", message } : { kind: "errored", message };
        }
    };
};

export default useRunAsProbe;
export type { ProbeOutcome, RunAsProbeArgs };
