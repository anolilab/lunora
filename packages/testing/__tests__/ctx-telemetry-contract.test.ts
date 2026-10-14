import type { ContextMetrics, ContextTracer, SpanHandle as ObservabilitySpanHandle } from "@lunora/observability";
import type { LunoraMetrics, LunoraTracer, SpanHandle as ServerSpanHandle } from "@lunora/server";
import { describe, expect, it } from "vitest";

/**
 * Cross-package drift guard for the `ctx.trace` / `ctx.metrics` contracts.
 *
 * `@lunora/observability` declares `ContextTracer`/`ContextMetrics` structurally
 * rather than importing `@lunora/server`, because the dependency edge runs the
 * other way — the telemetry layer is the lower tier. That leaves two hand-mirrored definitions of one
 * contract, and a mirror with no guard drifts (the studio's `TraceSummary` copy
 * already did, one commit after the shape it mirrors was corrected).
 *
 * This package is the natural place to catch it: it is the only one depending on
 * BOTH, so the check costs no new dependency edge. Unlike the `KeysMatch` guards
 * used for the flat wire shapes, these assert **mutual assignability** of
 * function types — so a drifted parameter or return type fails the build too, not
 * just an added or removed key.
 *
 * `lint:types` is what actually fails on drift; the assertions below only exist
 * so the guards are referenced at runtime. Verified to fire on a changed
 * parameter or return type.
 *
 * Known blind spot, inherent to structural assignability rather than to this
 * guard: adding a *trailing optional* parameter to one side stays mutually
 * assignable, so it is not caught. Widening or renaming an existing parameter,
 * changing a return type, or adding a required member all are.
 */

/** `true` only when `A` and `B` are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const TRACER_CONTRACT_GUARD: MutuallyAssignable<ContextTracer, LunoraTracer> = true;

const METRICS_CONTRACT_GUARD: MutuallyAssignable<ContextMetrics, LunoraMetrics> = true;

// The `SpanHandle` the tracer's body receives (post-hoc attributes).
// `@lunora/observability` re-exports the shared/bundler-inlined shape; `@lunora/server` mirrors it
// structurally — this fails the build if the two drift. Unlike the tracer guard,
// `SpanHandle`'s members are non-optional, so a widened/renamed/dropped method is
// caught outright (no trailing-optional blind spot).
const SPAN_HANDLE_CONTRACT_GUARD: MutuallyAssignable<ObservabilitySpanHandle, ServerSpanHandle> = true;

describe("ctx telemetry contract", () => {
    it("keeps @lunora/observability's ContextTracer in lockstep with @lunora/server's LunoraTracer", () => {
        expect.assertions(1);

        expect(TRACER_CONTRACT_GUARD).toBe(true);
    });

    it("keeps @lunora/observability's ContextMetrics in lockstep with @lunora/server's LunoraMetrics", () => {
        expect.assertions(1);

        expect(METRICS_CONTRACT_GUARD).toBe(true);
    });

    it("keeps @lunora/observability's SpanHandle in lockstep with @lunora/server's SpanHandle", () => {
        expect.assertions(1);

        expect(SPAN_HANDLE_CONTRACT_GUARD).toBe(true);
    });
});
