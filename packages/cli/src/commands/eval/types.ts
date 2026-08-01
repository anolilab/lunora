import type { EvalResult } from "@lunora/testing";

/**
 * What a discovered `*.eval.ts` file must default-export. `run` is the ENTIRE
 * eval body — it calls `evaluate`/`agentHarness` (or whatever else it needs)
 * from `@lunora/testing` itself and returns the kit's own `EvalResult`. The
 * runner never touches a scorer or the harness; this is the whole contract.
 *
 * A single default export (never mixed with named exports) so the file can
 * carry `name`/`threshold` metadata alongside the runnable body without
 * violating the repo's "no mixed default + named exports" rule.
 */
interface EvalModule {
    /** Display name; defaults to the file's basename (minus `.eval.ts`) when omitted. */
    name?: string;

    /**
     * Run the eval. Reuses `evaluate`/`agentHarness` from `@lunora/testing`
     * unchanged — this type imposes no new shape on the kit's own `EvalResult`.
     */
    run: () => Promise<EvalResult> | EvalResult;

    /**
     * Per-eval score gate in `[0, 1]`, overriding a global `--threshold` for
     * THIS eval only. Omitted → the global `--threshold` (if any) applies.
     */
    threshold?: number;
}

/** Runtime shape-check for a dynamically imported eval module's default export. */
const isEvalModule = (value: unknown): value is EvalModule =>
    typeof value === "object" && value !== null && typeof (value as { run?: unknown }).run === "function";

export type { EvalModule };
export { isEvalModule };
