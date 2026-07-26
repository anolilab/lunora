import { describe, expect, it, vi } from "vitest";

import type { CloudflareSpanLike, CloudflareTracingLike, SpanHandle, TracerDeps } from "../src/context-telemetry";
import { createTracer } from "../src/context-telemetry";

/**
 * Unit coverage for the opt-in Cloudflare custom-spans bridge in
 * {@link createTracer}. The bridge is deliberately injectable
 * (`fuseCloudflareSpans` + `resolveCloudflareTracing`) so it can be exercised in
 * plain Node with a fake/undefined `tracing` — no `cloudflare:workers`, no DO.
 */

/** A fake CF custom span that records every `setAttribute` write. */
const makeFakeSpan = (isTraced = true): CloudflareSpanLike & { readonly writes: [string, unknown][] } => {
    const writes: [string, unknown][] = [];

    return {
        isTraced,
        setAttribute: (key, value) => {
            writes.push([key, value]);
        },
        writes,
    };
};

/** A fake `tracing` namespace whose `enterSpan` runs the callback with `span`. */
const makeFakeTracing = (span: CloudflareSpanLike): CloudflareTracingLike & { readonly names: string[] } => {
    const names: string[] = [];

    return {
        enterSpan: (name, callback) => {
            names.push(name);

            return callback(span);
        },
        names,
    };
};

/** Build a tracer over a captured `record`, with bridge deps merged in. */
const setup = (overrides: Partial<TracerDeps> = {}) => {
    const recorded: Parameters<TracerDeps["record"]>[0][] = [];

    const trace = createTracer({
        anchor: { rootSpanId: "root0000root0000", traceId: "trace00000000000000000000000000" },
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

describe("createTracer cloudflare custom-spans bridge", () => {
    it("no-ops (default off): never resolves tracing, records unchanged", async () => {
        expect.assertions(4);

        const resolveCloudflareTracing = vi.fn<() => Promise<CloudflareTracingLike>>(async () => makeFakeTracing(makeFakeSpan()));
        const { recorded, trace } = setup({ resolveCloudflareTracing });

        const result = await trace("stripe.charge", () => "ok");

        expect(result).toBe("ok");
        expect(resolveCloudflareTracing).not.toHaveBeenCalled();
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ functionPath: "messages:list", name: "stripe.charge", ok: true });
    });

    it("no-ops when the flag is on but tracing resolves to undefined", async () => {
        expect.assertions(3);

        const resolveCloudflareTracing = vi.fn<() => Promise<undefined>>(async () => undefined);
        const { recorded, trace } = setup({ fuseCloudflareSpans: true, resolveCloudflareTracing });

        const result = await trace("span", () => 7);

        expect(result).toBe(7);
        expect(resolveCloudflareTracing).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveLength(1);
    });

    it("no-ops when the resolved tracing lacks a callable enterSpan", async () => {
        expect.assertions(2);

        // Probe must reject a partial `tracing` without throwing.
        const resolveCloudflareTracing = async () => ({ enterSpan: undefined }) as unknown as CloudflareTracingLike;
        const { recorded, trace } = setup({ fuseCloudflareSpans: true, resolveCloudflareTracing });

        const result = await trace("span", () => "still-runs");

        expect(result).toBe("still-runs");
        expect(recorded).toHaveLength(1);
    });

    it("wraps the body in enterSpan and mirrors key attributes onto the CF span", async () => {
        expect.assertions(6);

        const span = makeFakeSpan();
        const tracing = makeFakeTracing(span);
        const { trace } = setup({
            fuseCloudflareSpans: true,
            resolveCloudflareTracing: async () => tracing,
        });

        const result = await trace("stripe.charge", () => "done", { attempt: 2, mode: "live", nested: { skip: true } });

        expect(result).toBe("done");
        expect(tracing.names).toStrictEqual(["stripe.charge"]);

        const writes = new Map(span.writes);

        expect(writes.get("lunora.function_path")).toBe("messages:list");
        expect(writes.get("lunora.ok")).toBe(true);
        // User attributes are copied under `lunora.attr.*`, already coerced to
        // JSON primitives by `normalizeLogFields` (a nested object arrives as its
        // JSON string, not the object).
        expect(writes.get("lunora.attr.attempt")).toBe(2);
        expect(writes.get("lunora.attr.nested")).toBe(String.raw`{"skip":true}`);
    });

    it("skips setAttribute work when the CF span is not traced, but still records", async () => {
        expect.assertions(3);

        const span = makeFakeSpan(false);
        const { recorded, trace } = setup({
            fuseCloudflareSpans: true,
            resolveCloudflareTracing: async () => makeFakeTracing(span),
        });

        await trace("span", () => undefined);

        expect(span.isTraced).toBe(false);
        expect(span.writes).toHaveLength(0);
        expect(recorded).toHaveLength(1);
    });

    it("mirrors error attributes and re-throws, with the CF span still entered", async () => {
        expect.assertions(5);

        const span = makeFakeSpan();
        const tracing = makeFakeTracing(span);
        const { recorded, trace } = setup({
            fuseCloudflareSpans: true,
            resolveCloudflareTracing: async () => tracing,
        });

        const boom = new Error("kaboom");

        await expect(
            trace("span", () => {
                throw boom;
            }),
        ).rejects.toBe(boom);

        expect(tracing.names).toStrictEqual(["span"]);
        expect(recorded[0]).toMatchObject({ error: { message: "kaboom" }, ok: false });

        const writes = new Map(span.writes);

        expect(writes.get("lunora.ok")).toBe(false);
        expect(writes.get("error.message")).toBe("kaboom");
    });

    it("records an IDENTICAL SpanEvent (bar the per-call id/timestamps) with the bridge on", async () => {
        expect.assertions(1);

        const body = (_trace: unknown, span: SpanHandle) => {
            span.setAttribute("posthoc", "yes");

            return "v";
        };

        // Strip the fields that are intrinsically per-call (random id, wall clock)
        // so the comparison isolates whether the bridge altered span CONTENT.
        const stable = (span: Record<string, unknown>) => {
            const { durationMs, spanId, startTs, ...rest } = span;

            return rest;
        };

        const off = setup();

        await off.trace("span", body, { start: 1 });

        const on = setup({
            fuseCloudflareSpans: true,
            resolveCloudflareTracing: async () => makeFakeTracing(makeFakeSpan()),
        });

        await on.trace("span", body, { start: 1 });

        expect(stable(on.recorded[0] as unknown as Record<string, unknown>)).toStrictEqual(stable(off.recorded[0] as unknown as Record<string, unknown>));
    });

    it("swallows a setAttribute throw without failing the handler or losing the record", async () => {
        expect.assertions(2);

        const explodingSpan: CloudflareSpanLike = {
            isTraced: true,
            setAttribute: () => {
                throw new Error("attribute sink down");
            },
        };
        const { recorded, trace } = setup({
            fuseCloudflareSpans: true,
            resolveCloudflareTracing: async () => makeFakeTracing(explodingSpan),
        });

        const result = await trace("span", () => "safe");

        expect(result).toBe("safe");
        expect(recorded).toHaveLength(1);
    });
});
