/**
 * Real-workerd validation for the opt-in Cloudflare custom-spans bridge in
 * {@link createTracer} (trace-fusion piece 2, shipped disabled by #174).
 *
 * The unit suite (`../context-telemetry-cf-bridge.test.ts`) proves the bridge's
 * WIRING against a FAKE `tracing` object in plain Node — it does not prove that
 * `import { tracing } from "cloudflare:workers"` / `tracing.enterSpan` actually
 * exist and run inside a real `workerd` Durable Object. That is exactly the #174
 * caveat this file closes: it drives `createTracer` with the REAL
 * `resolveCloudflareTracing` (a guarded dynamic `import("cloudflare:workers")`,
 * mirroring `shard-do.ts`) both at worker top-level and INSIDE a live DO via
 * `runInDurableObject`, and asserts the bridge is additive — our recorded
 * `SpanEvent`s stay intact whether the CF bridge fires or not.
 *
 * What this harness CAN observe: whether `tracing`/`enterSpan` resolve, that a
 * traced body runs without throwing, that `span.isTraced` is a boolean, and that
 * OUR recorded span tree (parent/child via threaded `parentSpanId`) is unchanged.
 * What it CANNOT observe: Cloudflare's own EXPORTED span tree — there is no
 * collector/tail-worker attached in the pool, so CF's parent-linking of the
 * custom span under the DO's ambient span is not directly introspectable here.
 * Those assertions are called out inline.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { SpanEvent } from "../../../../shared/span-event";
import type { CloudflareTracingLike, TracerDeps } from "../../src/context-telemetry";
import { createTracer } from "../../src/context-telemetry";
import type { TestShardDO } from "./test-worker";

/**
 * The REAL resolver — a byte-for-byte behavioural mirror of
 * `shard-do.ts`'s `resolveCloudflareTracing`: a guarded dynamic import of
 * `cloudflare:workers`, returning `tracing` only when `enterSpan` is callable,
 * and `undefined` on any absence/throw. Not memoized here so each test observes
 * a fresh resolution.
 */
const realResolveCloudflareTracing = async (): Promise<CloudflareTracingLike | undefined> => {
    try {
        const cloudflareModule = (await import("cloudflare:workers")) as { tracing?: unknown };
        const candidate = cloudflareModule.tracing;

        return candidate !== null && typeof candidate === "object" && typeof (candidate as CloudflareTracingLike).enterSpan === "function"
            ? (candidate as CloudflareTracingLike)
            : undefined;
    } catch {
        return undefined;
    }
};

const anchor = { rootSpanId: "root0000root0000", traceId: "trace00000000000000000000000000" };

/** Build a tracer over a captured `record`, defaulting the non-bridge deps. */
const setup = (overrides: Partial<TracerDeps> = {}) => {
    const recorded: SpanEvent[] = [];

    const trace = createTracer({
        anchor,
        functionPath: "messages:list",
        record: (span) => {
            recorded.push(span);
        },
        shardKey: "room-1",
        userId: () => "user-42",
        ...overrides,
    });

    return { recorded, trace };
};

const newShardStub = (name: string): DurableObjectStub<TestShardDO> => env.SHARD.get(env.SHARD.idFromName(name));

describe("createTracer cloudflare custom-spans bridge (workerd)", () => {
    it("resolves the real `tracing` namespace from cloudflare:workers with a callable enterSpan", async () => {
        expect.assertions(2);

        // The availability probe: does `import { tracing } from "cloudflare:workers"`
        // actually yield a working `enterSpan` in THIS pool-workers runtime
        // (workerd + the wrangler compat date/flags in ./wrangler.jsonc)?
        const tracing = await realResolveCloudflareTracing();

        expect(tracing).toBeDefined();
        expect(typeof tracing?.enterSpan).toBe("function");
    });

    it("runs a nested ctx.trace inside a real DO with the bridge ON — no throw, isTraced is boolean, our spans intact", async () => {
        expect.assertions(9);

        const stub = newShardStub("cf-bridge-on");

        // Everything below executes INSIDE the live Durable Object's async
        // context, which is where the #174 caveat lived (enterSpan parent-linking
        // + availability within a DO was unverified upstream).
        const outcome = await runInDurableObject(stub, async () => {
            const recorded: SpanEvent[] = [];
            const isTracedSeen: unknown[] = [];

            const trace = createTracer({
                anchor,
                fuseCloudflareSpans: true,
                functionPath: "messages:list",
                record: (span) => {
                    recorded.push(span);
                },
                resolveCloudflareTracing: realResolveCloudflareTracing,
                shardKey: "room-1",
                userId: () => "user-42",
            });

            const result = await trace(
                "parent.op",
                async (childTrace, span) => {
                    // `span` here is our own SpanHandle (post-hoc attributes), not
                    // the CF span; the CF span is threaded internally by the bridge.
                    span.setAttribute("parentAttr", "p");

                    // Nested child — bound to the parent span via the threaded
                    // tracer, so our recorded tree must show child.parentSpanId ===
                    // parent.spanId regardless of what CF does with its own tree.
                    const childValue = await childTrace("child.op", (_t, childSpan) => {
                        childSpan.setAttribute("childAttr", "c");

                        return "child-done";
                    });

                    return `parent(${childValue})`;
                },
                { mode: "live" },
            );

            // Probe `isTraced` through the same real resolver the bridge used, so
            // we assert on the concrete platform Span shape, not a fake.
            const tracing = await realResolveCloudflareTracing();

            tracing?.enterSpan("probe.isTraced", (cfSpan) => {
                isTracedSeen.push(cfSpan.isTraced);
            });

            return { isTracedSeen, recorded, result };
        });

        // 1. The traced body ran to completion inside the DO without throwing.
        expect(outcome.result).toBe("parent(child-done)");

        // 2. Both spans were recorded — the bridge is additive, not a replacement.
        expect(outcome.recorded).toHaveLength(2);

        const parent = outcome.recorded.find((s) => s.name === "parent.op");
        const child = outcome.recorded.find((s) => s.name === "child.op");

        expect(parent).toBeDefined();
        expect(child).toBeDefined();

        // 3. OUR recorded parent/child linkage is intact under the real bridge:
        //    parent hangs off the anchor root, child hangs off the parent. This is
        //    the nesting the harness CAN observe (our threaded tree). CF's own
        //    exported span tree is not introspectable here — see the file header.
        expect(parent?.parentSpanId).toBe(anchor.rootSpanId);
        expect(child?.parentSpanId).toBe(parent?.spanId);

        // 4. Attributes we attached post-hoc survived through the bridged path.
        expect(parent?.attributes).toMatchObject({ mode: "live", parentAttr: "p" });
        expect(child?.attributes).toMatchObject({ childAttr: "c" });

        // 5. `span.isTraced` is a real boolean on the platform Span (its concrete
        //    value depends on whether the runtime is sampling; both are valid).
        expect(typeof outcome.isTracedSeen[0]).toBe("boolean");
    });

    it("is a true no-op inside a real DO when the bridge is default-off (resolver never consulted)", async () => {
        expect.assertions(4);

        const stub = newShardStub("cf-bridge-off");

        const outcome = await runInDurableObject(stub, async () => {
            const recorded: SpanEvent[] = [];
            const resolveSpy = vi.fn<() => Promise<CloudflareTracingLike | undefined>>(realResolveCloudflareTracing);

            // No `fuseCloudflareSpans` — the default path. The resolver is wired in
            // but must never be called.
            const trace = createTracer({
                anchor,
                functionPath: "messages:list",
                record: (span) => {
                    recorded.push(span);
                },
                resolveCloudflareTracing: resolveSpy,
                shardKey: "room-1",
                userId: () => "user-42",
            });

            const result = await trace("plain.op", () => "ok");

            return { recorded, resolveCalls: resolveSpy.mock.calls.length, result };
        });

        expect(outcome.result).toBe("ok");
        expect(outcome.resolveCalls).toBe(0);
        expect(outcome.recorded).toHaveLength(1);
        expect(outcome.recorded[0]).toMatchObject({ functionPath: "messages:list", name: "plain.op", ok: true });
    });

    it("records an identical SpanEvent (bar per-call id/timestamps) with the real bridge ON vs OFF, inside the DO", async () => {
        expect.assertions(1);

        const stub = newShardStub("cf-bridge-parity");

        const stable = (span: SpanEvent) => {
            const { durationMs, spanId, startTs, ...rest } = span as unknown as Record<string, unknown>;

            return rest;
        };

        const { off, on } = await runInDurableObject(stub, async () => {
            const body = (_t: unknown, span: { setAttribute: (k: string, v: unknown) => void }) => {
                span.setAttribute("posthoc", "yes");

                return "v";
            };

            const offBuild = setup();

            await offBuild.trace("span", body, { start: 1 });

            const onBuild = setup({ fuseCloudflareSpans: true, resolveCloudflareTracing: realResolveCloudflareTracing });

            await onBuild.trace("span", body, { start: 1 });

            return { off: offBuild.recorded[0]!, on: onBuild.recorded[0]! };
        });

        // The recorded span content is byte-for-byte identical whether or not the
        // real CF bridge fired — the bridge only ADDS a CF-side span.
        expect(stable(on)).toStrictEqual(stable(off));
    });
});
