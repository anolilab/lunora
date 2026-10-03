import { describe, expect, it, vi } from "vitest";

import type { SpanHandle, TracerDeps } from "../src/context-telemetry";
import { createTracer } from "../src/context-telemetry";
import type { HostSpanLike, HostTracingLike } from "../src/host-span";
import { applyHostRootSpan, setHostSpanAttributes } from "../src/host-span";

/**
 * Unit coverage for the opt-in Cloudflare custom-spans bridge in
 * {@link createTracer}. The bridge is deliberately injectable
 * (`fuseHostSpans` + `resolveHostTracing`) so it can be exercised in
 * plain Node with a fake/undefined `tracing` — no `cloudflare:workers`, no DO.
 */

/** A fake CF custom span that records every `setAttribute` write. */
const makeFakeSpan = (isTraced = true): HostSpanLike & { readonly writes: [string, unknown][] } => {
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
const makeFakeTracing = (span: HostSpanLike): HostTracingLike & { readonly names: string[] } => {
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

        const resolveHostTracing = vi.fn<() => Promise<HostTracingLike>>(async () => makeFakeTracing(makeFakeSpan()));
        const { recorded, trace } = setup({ resolveHostTracing });

        const result = await trace("stripe.charge", () => "ok");

        expect(result).toBe("ok");
        expect(resolveHostTracing).not.toHaveBeenCalled();
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ functionPath: "messages:list", name: "stripe.charge", ok: true });
    });

    it("no-ops when the flag is on but tracing resolves to undefined", async () => {
        expect.assertions(3);

        const resolveHostTracing = vi.fn<() => Promise<undefined>>(async () => undefined);
        const { recorded, trace } = setup({ fuseHostSpans: true, resolveHostTracing });

        const result = await trace("span", () => 7);

        expect(result).toBe(7);
        expect(resolveHostTracing).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveLength(1);
    });

    it("no-ops when the resolved tracing lacks a callable enterSpan", async () => {
        expect.assertions(2);

        // Probe must reject a partial `tracing` without throwing.
        const resolveHostTracing = async () => ({ enterSpan: undefined }) as unknown as HostTracingLike;
        const { recorded, trace } = setup({ fuseHostSpans: true, resolveHostTracing });

        const result = await trace("span", () => "still-runs");

        expect(result).toBe("still-runs");
        expect(recorded).toHaveLength(1);
    });

    it("wraps the body in enterSpan and mirrors key attributes onto the CF span", async () => {
        expect.assertions(6);

        const span = makeFakeSpan();
        const tracing = makeFakeTracing(span);
        const { trace } = setup({
            fuseHostSpans: true,
            resolveHostTracing: async () => tracing,
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
            fuseHostSpans: true,
            resolveHostTracing: async () => makeFakeTracing(span),
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
            fuseHostSpans: true,
            resolveHostTracing: async () => tracing,
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
            fuseHostSpans: true,
            resolveHostTracing: async () => makeFakeTracing(makeFakeSpan()),
        });

        await on.trace("span", body, { start: 1 });

        expect(stable(on.recorded[0] as unknown as Record<string, unknown>)).toStrictEqual(stable(off.recorded[0] as unknown as Record<string, unknown>));
    });

    it("swallows a setAttribute throw without failing the handler or losing the record", async () => {
        expect.assertions(2);

        const explodingSpan: HostSpanLike = {
            isTraced: true,
            setAttribute: () => {
                throw new Error("attribute sink down");
            },
        };
        const { recorded, trace } = setup({
            fuseHostSpans: true,
            resolveHostTracing: async () => makeFakeTracing(explodingSpan),
        });

        const result = await trace("span", () => "safe");

        expect(result).toBe("safe");
        expect(recorded).toHaveLength(1);
    });

    it("still runs the body when resolving host tracing rejects", async () => {
        expect.assertions(3);

        const body = vi.fn<() => string>(() => "ran");
        const { recorded, trace } = setup({
            fuseHostSpans: true,
            resolveHostTracing: async () => {
                throw new Error("tracing probe exploded");
            },
        });

        // `runRecorded` is the ARGUMENT to `enterSpan`: an unguarded probe failure
        // means the handler body never executes and the caller sees a telemetry
        // error instead of their result.
        await expect(trace("span", body)).resolves.toBe("ran");
        expect(body).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveLength(1);
    });

    it("still runs the body when enterSpan throws before invoking it", async () => {
        expect.assertions(2);

        const body = vi.fn<() => string>(() => "ran");
        const { recorded, trace } = setup({
            fuseHostSpans: true,
            resolveHostTracing: async () => {
                return {
                    enterSpan: () => {
                        throw new Error("enterSpan down");
                    },
                };
            },
        });

        await expect(trace("span", body)).resolves.toBe("ran");
        expect(recorded).toHaveLength(1);
    });

    it("re-throws the body's own error without re-running it", async () => {
        expect.assertions(2);

        const body = vi.fn<() => string>(() => {
            throw new Error("handler blew up");
        });
        const { trace } = setup({
            fuseHostSpans: true,
            resolveHostTracing: async () => makeFakeTracing(makeFakeSpan()),
        });

        await expect(trace("span", body)).rejects.toThrow("handler blew up");
        expect(body).toHaveBeenCalledTimes(1);
    });

    it("uses the native setAttributes and recordException when the runtime has them", async () => {
        expect.assertions(4);

        const bags: Record<string, boolean | number | string>[] = [];
        const exceptions: { message: string; name: string }[] = [];
        const span: HostSpanLike = {
            isTraced: true,
            recordException: (exception) => {
                exceptions.push(exception);
            },
            setAttribute: () => {
                throw new Error("setAttribute must not be used when setAttributes exists");
            },
            setAttributes: (attributes) => {
                bags.push(attributes);
            },
        };
        const { trace } = setup({ fuseHostSpans: true, resolveHostTracing: async () => makeFakeTracing(span) });

        await expect(
            trace("span", () => {
                throw new TypeError("kaboom");
            }),
        ).rejects.toThrow("kaboom");

        expect(bags).toHaveLength(1);
        expect(bags[0]).toMatchObject({ "error.message": "kaboom", "lunora.function_path": "messages:list", "lunora.ok": false });
        expect(exceptions).toStrictEqual([{ message: "kaboom", name: "TypeError" }]);
    });
});

describe("createTracer cloudflare span status", () => {
    type Status = Parameters<NonNullable<HostSpanLike["setStatus"]>>[0];

    /** A fake CF span that also records every `setStatus` call. */
    const makeStatusSpan = (isTraced = true): HostSpanLike & { readonly statuses: Status[] } => {
        const statuses: Status[] = [];

        return {
            isTraced,
            setAttribute: () => undefined,
            setStatus: (status) => {
                statuses.push(status);
            },
            statuses,
        };
    };

    it("sets error status with the redacted message on a failed span", async () => {
        expect.assertions(2);

        const span = makeStatusSpan();
        const { trace } = setup({ fuseHostSpans: true, resolveHostTracing: async () => makeFakeTracing(span) });

        await expect(
            trace("span", () => {
                throw new Error("User 12345 not found");
            }),
        ).rejects.toThrow("User 12345 not found");

        // The redacted message — the host exports this span, so it must not
        // carry the raw one (`standardRules` masks a bare 5-digit run as `<DL>`).
        expect(span.statuses).toStrictEqual([{ code: "error", message: "User <DL> not found" }]);
    });

    it("never sets a status on a successful span (OTel leaves it unset)", async () => {
        expect.assertions(2);

        const span = makeStatusSpan();
        const { trace } = setup({ fuseHostSpans: true, resolveHostTracing: async () => makeFakeTracing(span) });

        await expect(trace("span", () => "ok")).resolves.toBe("ok");
        expect(span.statuses).toHaveLength(0);
    });

    it("never sets a status on an untraced span", async () => {
        expect.assertions(2);

        const span = makeStatusSpan(false);
        const { recorded, trace } = setup({ fuseHostSpans: true, resolveHostTracing: async () => makeFakeTracing(span) });

        await expect(
            trace("span", () => {
                throw new Error("kaboom");
            }),
        ).rejects.toThrow("kaboom");

        expect({ recorded: recorded.length, statuses: span.statuses }).toStrictEqual({ recorded: 1, statuses: [] });
    });

    it("sets the status even when the attribute mirror throws", async () => {
        expect.assertions(2);

        const statuses: Status[] = [];
        const span: HostSpanLike = {
            isTraced: true,
            setAttribute: () => {
                throw new Error("attribute sink down");
            },
            setStatus: (status) => {
                statuses.push(status);
            },
        };
        const { trace } = setup({ fuseHostSpans: true, resolveHostTracing: async () => makeFakeTracing(span) });

        await expect(
            trace("span", () => {
                throw new Error("kaboom");
            }),
        ).rejects.toThrow("kaboom");

        expect(statuses).toStrictEqual([{ code: "error", message: "kaboom" }]);
    });

    it("still mirrors a failure onto a span without setStatus (older runtime)", async () => {
        expect.assertions(3);

        const span = makeFakeSpan();
        const { recorded, trace } = setup({ fuseHostSpans: true, resolveHostTracing: async () => makeFakeTracing(span) });

        await expect(
            trace("span", () => {
                throw new Error("kaboom");
            }),
        ).rejects.toThrow("kaboom");

        expect(recorded[0]).toMatchObject({ ok: false });
        expect(new Map(span.writes).get("error.message")).toBe("kaboom");
    });
});

describe(applyHostRootSpan, () => {
    type Status = Parameters<NonNullable<HostSpanLike["setStatus"]>>[0];

    /** A fake invocation span recording status and attribute writes; setters can be made to throw. */
    const makeRootSpan = (options: { isTraced?: boolean; throwOnAttributes?: boolean; throwOnStatus?: boolean } = {}) => {
        const statuses: Status[] = [];
        const bags: Record<string, boolean | number | string>[] = [];
        const span: HostSpanLike = {
            isTraced: options.isTraced ?? true,
            setAttribute: () => undefined,
            setAttributes: (attributes) => {
                if (options.throwOnAttributes === true) {
                    throw new Error("attribute sink down");
                }

                bags.push(attributes);
            },
            setStatus: (status) => {
                if (options.throwOnStatus === true) {
                    throw new Error("status sink down");
                }

                statuses.push(status);
            },
        };
        const tracing: HostTracingLike = { enterSpan: (_name, callback) => callback(span), getActiveSpan: () => span };

        return { bags, statuses, tracing };
    };

    it("sets error status for a server fault (an RPC answered 5xx)", () => {
        expect.assertions(1);

        const root = makeRootSpan();

        applyHostRootSpan(root.tracing, { error: { message: "internal error", serverFault: true } });

        expect(root.statuses).toStrictEqual([{ code: "error", message: "internal error" }]);
    });

    it("leaves the status unset for a client fault (an RPC answered 4xx)", () => {
        expect.assertions(2);

        const root = makeRootSpan();

        applyHostRootSpan(root.tracing, { attributes: { "order.id": "o-1" }, error: { message: "not yours", serverFault: false } });

        expect(root.statuses).toStrictEqual([]);
        // The attributes still land — only the status is withheld.
        expect(root.bags).toStrictEqual([{ "order.id": "o-1" }]);
    });

    it("sets error status for a trigger that threw, whatever the error's code", () => {
        expect.assertions(1);

        const root = makeRootSpan();

        // A trigger passes `serverFault: true` unconditionally: it re-throws, so
        // there is no client response to call a 4xx.
        applyHostRootSpan(root.tracing, { error: { message: "FORBIDDEN", serverFault: true } });

        expect(root.statuses).toStrictEqual([{ code: "error", message: "FORBIDDEN" }]);
    });

    it("is a no-op without tracing or without getActiveSpan", () => {
        expect.assertions(1);

        const failure = { error: { message: "x", serverFault: true } };

        expect(() => {
            applyHostRootSpan(undefined, failure);
            applyHostRootSpan({ enterSpan: (_name, callback) => callback(makeFakeSpan()) }, failure);
        }).not.toThrow();
    });

    it("writes nothing to an untraced span", () => {
        expect.assertions(2);

        const root = makeRootSpan({ isTraced: false });

        applyHostRootSpan(root.tracing, { attributes: { a: 1 }, error: { message: "x", serverFault: true } });

        expect(root.statuses).toStrictEqual([]);
        expect(root.bags).toStrictEqual([]);
    });

    it("swallows a throwing setStatus and still mirrors the attributes", () => {
        expect.assertions(2);

        const root = makeRootSpan({ throwOnStatus: true });

        expect(() => {
            applyHostRootSpan(root.tracing, { attributes: { a: 1 }, error: { message: "x", serverFault: true } });
        }).not.toThrow();
        expect(root.bags).toStrictEqual([{ a: 1 }]);
    });

    it("does not let a throwing attribute setter drop the status", () => {
        expect.assertions(2);

        const root = makeRootSpan({ throwOnAttributes: true });

        expect(() => {
            applyHostRootSpan(root.tracing, { attributes: { a: 1 }, error: { message: "x", serverFault: true } });
        }).not.toThrow();
        expect(root.statuses).toStrictEqual([{ code: "error", message: "x" }]);
    });
});

describe(setHostSpanAttributes, () => {
    it("falls back to setAttribute per key, dropping non-primitives", () => {
        expect.assertions(1);

        const span = makeFakeSpan();

        setHostSpanAttributes(span, { a: 1, b: "x", c: null, d: true });

        expect(span.writes).toStrictEqual([
            ["a", 1],
            ["b", "x"],
            ["d", true],
        ]);
    });

    it("writes nothing to an untraced span", () => {
        expect.assertions(1);

        const span = makeFakeSpan(false);

        setHostSpanAttributes(span, { a: 1 });

        expect(span.writes).toHaveLength(0);
    });
});
