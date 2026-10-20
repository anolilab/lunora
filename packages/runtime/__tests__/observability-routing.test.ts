import { describe, expect, it, vi } from "vitest";

import type { LogEvent, MetricEvent, ObservabilityEvent, ObservabilitySink, ObservabilitySinkContext, SpanEvent } from "../src/observability";
import { emitRpcEvent } from "../src/observability";
import type { SinkEnricher } from "../src/observability-routing";
import { enrichSink, filterSink, globMatch } from "../src/observability-routing";
import { combineSinks, otlpSink } from "../src/observability-sinks";

const rpc: ObservabilityEvent = { durationMs: 5, functionPath: "messages:list", ok: true, shardKey: "channel-1" };

const log: LogEvent = {
    args: [],
    functionPath: "messages:list",
    level: "info",
    message: "listed",
    shardKey: "channel-1",
    ts: 1_700_000_000_000,
};

const metric: MetricEvent = {
    attributes: { plan: "pro" },
    functionPath: "messages:list",
    kind: "counter",
    name: "messages.listed",
    ts: 1_700_000_000_000,
    value: 1,
};

const span: SpanEvent = {
    durationMs: 25,
    functionPath: "messages:list",
    name: "db.query",
    ok: true,
    parentSpanId: "b7ad6b7169203331",
    spanId: "00f067aa0ba902b7",
    startTs: 1_700_000_000_000,
    traceId: "0af7651916cd43dd8448eb211c80319c",
};

/** A sink that records every call it receives, with every hook defined. */
const recordingSink = () => {
    const received = {
        flushes: [] as unknown[],
        logs: [] as LogEvent[],
        metrics: [] as MetricEvent[],
        rpcs: [] as ObservabilityEvent[],
        spans: [] as SpanEvent[],
    };
    const sink: ObservabilitySink = {
        flush: vi.fn<(context?: ObservabilitySinkContext) => void>((context) => {
            received.flushes.push(context);
        }),
        onLog: (event) => {
            received.logs.push(event);
        },
        onMetric: (event) => {
            received.metrics.push(event);
        },
        onRpc: (event) => {
            received.rpcs.push(event);
        },
        onSpan: (event) => {
            received.spans.push(event);
        },
    };

    return { received, sink };
};

describe("globMatch", () => {
    it.each([
        ["messages:*", "messages:list", true],
        ["messages:*", "messages:", true],
        ["messages:*", "orders:list", false],
        ["*", "anything:at/all", true],
        ["*:list", "messages:list", true],
        ["*:list", "messages:send", false],
        ["a*b*c", "axxbyyc", true],
        ["a*b*c", "acb", false],
        ["a*b*c", "axxc", false],
        ["a*b*c", "abxc", true],
        ["messages:list", "messages:list", true],
        ["messages:list", "messages:listing", false],
        ["alarm:*", "alarm:rearm", true],
    ])("matches %s against %s as %s", (pattern, value, expected) => {
        expect.hasAssertions();

        expect(globMatch(pattern, value)).toBe(expected);
    });
});

describe("enrichSink", () => {
    it("adds derived fields to all four signal kinds, the worker half included", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { plan: "pro" };
        });

        // Worker half: the path the runtime takes for one RPC event.
        emitRpcEvent(wrapped, rpc);

        // Shard half: the calls the shard makes for ctx.log, ctx.metrics and ctx.trace.
        wrapped.onLog?.(log);
        wrapped.onMetric?.(metric);
        wrapped.onSpan?.(span);

        expect(received.rpcs[0]?.attributes).toStrictEqual({ plan: "pro" });
        expect(received.logs[0]?.fields).toStrictEqual({ plan: "pro" });
        expect(received.metrics[0]?.attributes).toStrictEqual({ plan: "pro" });
        expect(received.spans[0]?.attributes).toStrictEqual({ plan: "pro" });
    });

    it("hands the enricher the signal kind and the event", () => {
        expect.hasAssertions();

        const { sink } = recordingSink();
        const enrich = vi.fn<SinkEnricher>(() => undefined);
        const wrapped = enrichSink(sink, enrich);

        wrapped.onLog?.(log);
        wrapped.onRpc?.(rpc);

        expect(enrich).toHaveBeenNthCalledWith(1, log, "log");
        expect(enrich).toHaveBeenNthCalledWith(2, rpc, "rpc");
    });

    it("keeps the event's own attributes when a key collides with the enricher's", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { plan: "free", region: "eu" };
        });

        wrapped.onMetric?.(metric);

        expect(received.metrics[0]?.attributes).toStrictEqual({ plan: "pro", region: "eu" });
    });

    it("returns a copy and leaves the original event untouched", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { plan: "pro" };
        });

        wrapped.onLog?.(log);

        expect(log.fields).toBeUndefined();
        expect(received.logs[0]).not.toBe(log);
    });

    it("normalizes the enricher's output so an unserialisable value cannot throw", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { big: 10n, nested: { a: 1 } };
        });

        wrapped.onLog?.(log);

        expect(received.logs).toHaveLength(1);
        expect(JSON.stringify(received.logs[0]?.fields)).toContain('"big"');
    });

    it("delivers the event unchanged when the enricher throws", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            throw new Error("enricher exploded");
        });

        expect(() => {
            emitRpcEvent(wrapped, rpc);
            wrapped.onLog?.(log);
        }).not.toThrow();
        expect(received.rpcs[0]).toBe(rpc);
        expect(received.logs[0]).toBe(log);
    });

    it("does not let a throwing inner sink break the caller", () => {
        expect.hasAssertions();

        const sink: ObservabilitySink = {
            onRpc: () => {
                throw new Error("sink exploded");
            },
        };
        const wrapped = enrichSink(sink, () => {
            return { plan: "pro" };
        });

        expect(() => {
            emitRpcEvent(wrapped, rpc);
        }).not.toThrow();
    });

    it("redacts enriched values with the same rules as logged fields", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { contact: "user@example.com" };
        });

        wrapped.onLog?.(log);

        expect(JSON.stringify(received.logs[0]?.fields)).not.toContain("user@example.com");
    });

    it("delivers the event unchanged when normalizing the enricher's output throws", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return {
                get boom(): never {
                    throw new Error("getter exploded");
                },
            };
        });

        wrapped.onLog?.(log);

        expect(received.logs[0]).toBe(log);
    });

    it("keeps ids and URLs on metric attributes, which the log PII rules would mask", () => {
        expect.assertions(2);

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { id: "order-7", url: "https://shop.example/orders/7" };
        });

        wrapped.onMetric?.(metric);

        expect(received.metrics[0]?.attributes).toMatchObject({ id: "order-7", url: "https://shop.example/orders/7" });
        expect(received.metrics[0]?.attributes).toMatchObject({ plan: "pro" });
    });

    it("masks a credential in an enriched Error's message as the sink receives it", () => {
        expect.assertions(1);

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { diagnostic: new Error("password=hunter2-secret") }; // gitleaks:allow -- test fixture, not a credential
        });

        wrapped.onLog?.(log);

        expect(JSON.stringify(received.logs[0]?.fields)).not.toContain("hunter2-secret");
    });

    it("redacts the message of an Error nested in an array, as it does a top-level one", () => {
        expect.assertions(2);

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { diagnostics: [new Error("password=hunter2-secret")] }; // gitleaks:allow -- test fixture, not a credential
        });

        wrapped.onLog?.(log);

        const serialized = JSON.stringify(received.logs[0]?.fields);

        expect(serialized).toContain("password=<REDACTED>");
        expect(serialized).not.toContain("hunter2-secret");
    });

    it("keeps an enriched __proto__ field as an own field the sink receives", () => {
        expect.assertions(1);

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { ["__proto__"]: "kept" };
        });

        wrapped.onLog?.(log);

        expect(Object.getOwnPropertyDescriptor(received.logs[0]?.fields ?? {}, "__proto__")?.value).toBe("kept");
    });

    it("leaves out an enriched key whose value is undefined, and keeps the rest", () => {
        expect.assertions(2);

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { plan: "pro", tenant: undefined };
        });

        wrapped.onLog?.(log);

        expect(received.logs[0]?.fields?.plan).toBe("pro");
        expect(received.logs[0]?.fields?.tenant).toBeUndefined();
    });

    it("exports a value shared under two keys under both keys", () => {
        expect.assertions(2);

        const tags = ["a"];
        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { dims: tags, labels: tags };
        });

        wrapped.onLog?.(log);

        expect(received.logs[0]?.fields?.labels).toBeDefined();
        expect(received.logs[0]?.fields?.dims).toStrictEqual(received.logs[0]?.fields?.labels);
    });

    it("exports a value shared under two keys under both keys on a metric, which redacts differently", () => {
        expect.assertions(2);

        const tags = ["a"];
        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { dims: tags, labels: tags };
        });

        wrapped.onMetric?.(metric);

        expect(received.metrics[0]?.attributes?.dims).toBe('["a"]');
        expect(received.metrics[0]?.attributes?.labels).toBe('["a"]');
    });

    it("copies a class's own fields when its toJSON returns the object itself", () => {
        expect.assertions(1);

        class Point {
            public x = 1;

            public y = 2;

            public toJSON(): this {
                return this;
            }
        }

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { point: new Point() };
        });

        wrapped.onMetric?.(metric);

        expect(received.metrics[0]?.attributes?.point).toBe(JSON.stringify({ x: 1, y: 2 }));
    });

    it("reads a shared subtree once, so a compact shared-reference graph copies in linear work", () => {
        expect.assertions(2);

        let reads = 0;
        const leaf = {};

        Object.defineProperty(leaf, "value", {
            enumerable: true,
            get: () => {
                reads += 1;

                return "leaf";
            },
        });

        let node: unknown = leaf;

        for (let depth = 0; depth < 10; depth += 1) {
            node = { left: node, right: node };
        }

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => undefined);
        const event: LogEvent = { ...log, args: [node] };

        wrapped.onLog?.(event);

        // Without the copy memo the leaf is read once per path: 2^10 = 1024 times.
        expect(reads).toBeLessThan(5);
        expect(received.logs[0]).toBe(event);
    });

    it("still delivers the event when a thrown error's name getter throws", () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { received, sink } = recordingSink();
        const hostile = new Error("enricher exploded");

        Object.defineProperty(hostile, "name", {
            get: () => {
                throw new Error("name getter");
            },
        });

        const wrapped = enrichSink(sink, () => {
            throw hostile;
        });

        wrapped.onLog?.(log);

        expect(received.logs[0]).toBe(log);

        spy.mockRestore();
    });

    it("masks an Error that a class's toJSON returns, as the sink receives it", () => {
        expect.assertions(1);

        class Labelled {
            private readonly secret = "sekret"; // gitleaks:allow -- test fixture, not a credential

            public toJSON(): Error {
                return new Error(`password=${this.secret}`);
            }
        }

        const { received, sink } = recordingSink();
        const wrapped = enrichSink(sink, () => {
            return { note: new Labelled() };
        });

        wrapped.onMetric?.(metric);

        expect(JSON.stringify(received.metrics[0]?.attributes)).toContain("password=<REDACTED>");
    });

    it("does not let an enricher change the event it was given", () => {
        expect.assertions(1);

        const { sink } = recordingSink();
        const wrapped = enrichSink(sink, (event) => {
            Reflect.set(event, "functionPath", "changed");
            throw new Error("enricher exploded");
        });

        wrapped.onLog?.(log);

        expect(log.functionPath).toBe("messages:list");
    });

    it("reports a throwing enricher, so a broken one is not silent", async () => {
        expect.assertions(1);

        // The reporter caps logging per isolate, and the other tests in this file spend that cap.
        // A fresh module starts it at zero.
        vi.resetModules();

        const { enrichSink: freshEnrichSink } = await import("../src/observability-routing");
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { sink } = recordingSink();
        const wrapped = freshEnrichSink(sink, () => {
            throw new Error("enricher exploded");
        });

        wrapped.onLog?.(log);

        // The error's name, not the error: its message is never logged.
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("enrichSink's enricher threw"), "Error");

        spy.mockRestore();
    });
});

describe("filterSink", () => {
    it("honours include and exclude across all four signal kinds", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        // `admin:*` matches include AND exclude, so only exclude can drop it.
        const wrapped = filterSink(sink, { exclude: ["admin:*"], include: ["messages:*", "admin:*"] });
        const admin = { ...rpc, functionPath: "admin:wipe" };

        emitRpcEvent(wrapped, rpc);
        emitRpcEvent(wrapped, admin);
        wrapped.onLog?.(log);
        wrapped.onLog?.({ ...log, functionPath: "orders:checkout" });
        wrapped.onMetric?.(metric);
        wrapped.onSpan?.({ ...span, functionPath: "orders:checkout" });
        wrapped.onSpan?.(span);
        wrapped.onSpan?.({ ...span, functionPath: "admin:wipe" });

        expect(received.rpcs.map((event) => event.functionPath)).toStrictEqual(["messages:list"]);
        expect(received.logs.map((event) => event.functionPath)).toStrictEqual(["messages:list"]);
        expect(received.metrics.map((event) => event.functionPath)).toStrictEqual(["messages:list"]);
        expect(received.spans.map((event) => event.functionPath)).toStrictEqual(["messages:list"]);
    });

    it("passes everything when include is absent or empty, and exclude still applies", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const open = filterSink(sink, {});
        const emptyInclude = filterSink(sink, { include: [] });
        const excluding = filterSink(sink, { exclude: ["admin:*"] });

        emitRpcEvent(open, rpc);
        emitRpcEvent(emptyInclude, { ...rpc, functionPath: "orders:checkout" });
        emitRpcEvent(excluding, { ...rpc, functionPath: "admin:wipe" });

        expect(received.rpcs.map((event) => event.functionPath)).toStrictEqual(["messages:list", "orders:checkout"]);
    });

    it("drops platform-originated signals unless the include list names them", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const wrapped = filterSink(sink, { include: ["messages:*"] });

        wrapped.onMetric?.({ ...metric, functionPath: "alarm:rearm" });

        expect(received.metrics).toHaveLength(0);
    });

    it("does not run an enricher for an event the filter drops", () => {
        expect.hasAssertions();

        const { sink } = recordingSink();
        const enrich = vi.fn<SinkEnricher>(() => {
            return { plan: "pro" };
        });
        const wrapped = filterSink(enrichSink(sink, enrich), { include: ["messages:*"] });

        wrapped.onLog?.({ ...log, functionPath: "orders:checkout" });

        expect(enrich).not.toHaveBeenCalled();
    });
});

describe("wrapper contract", () => {
    it("carries the sink's configuration fields through, including traceFetch", () => {
        expect.hasAssertions();

        const propagate = (url: URL): boolean => url.host.endsWith(".internal");
        const sink: ObservabilitySink = { metricHistory: true, onRpc: () => undefined, traceFetch: { propagate } };
        const enriched = enrichSink(sink, () => undefined);

        expect(enriched.traceFetch).toStrictEqual({ propagate });
        expect(filterSink(sink, {}).metricHistory).toBe(true);
        expect(filterSink(enriched, {}).traceFetch).toStrictEqual({ propagate });
    });

    it("forwards flush with its context", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const context = { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() };
        const wrapped = filterSink(
            enrichSink(sink, () => undefined),
            {},
        );

        wrapped.flush?.(context);

        expect(received.flushes).toStrictEqual([context]);
    });

    it("defines only the hooks the wrapped sink defines", () => {
        expect.hasAssertions();

        const wrapped = enrichSink({ onRpc: () => undefined }, () => undefined);

        expect(wrapped.onRpc).toBeDefined();
        expect(wrapped.onSpan).toBeUndefined();
        expect(wrapped.onLog).toBeUndefined();
        expect(wrapped.onMetric).toBeUndefined();
        expect(wrapped.flush).toBeUndefined();
    });

    it("composes with combineSinks without losing either wrapper's effect", () => {
        expect.hasAssertions();

        const { received, sink } = recordingSink();
        const routed = filterSink(
            enrichSink(sink, () => {
                return { plan: "pro" };
            }),
            { include: ["messages:*"] },
        );
        const combined = combineSinks(routed);

        combined.onSpan?.(span);
        combined.onSpan?.({ ...span, functionPath: "orders:checkout" });

        expect(received.spans).toHaveLength(1);
        expect(received.spans[0]?.attributes).toStrictEqual({ plan: "pro" });
    });
});

describe("enrichment reaches the OTLP wire", () => {
    it("exports an enriched RPC attribute on the span and masks an enriched PII value in a log", () => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);

        try {
            const sink = enrichSink(otlpSink({ batch: false, endpoint: "https://collector.example" }), (_event, signal) =>
                signal === "rpc" ? { tenantPlan: "pro" } : { contact: "user@example.com" },
            );

            emitRpcEvent(sink, rpc);
            sink.onLog?.(log);

            const bodyOf = (suffix: string): string => {
                const call = fetchMock.mock.calls.find(([url]) => typeof url === "string" && url.endsWith(suffix));
                const body = call?.[1]?.body;

                return typeof body === "string" ? body : "";
            };

            expect(bodyOf("/v1/traces")).toContain("tenantPlan");
            expect(bodyOf("/v1/logs")).not.toContain("user@example.com");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("drops an enriched span key that names a built-in field the event does not carry", () => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);

        try {
            // A fan-out has no shard key, and a successful dispatch has no error: the enricher fills both gaps.
            const sink = enrichSink(otlpSink({ batch: false, endpoint: "https://collector.example" }), () => {
                return {
                    "cloudflare.ray_id": "forged",
                    "error.type": "forged",
                    "lunora.shard_key": "forged",
                };
            });

            emitRpcEvent(sink, { durationMs: 5, fanOut: { failed: 0, shards: 2, table: "messages" }, functionPath: "messages:list", ok: true });

            const call = fetchMock.mock.calls.find(([url]) => typeof url === "string" && url.endsWith("/v1/traces"));

            expect(call).toBeDefined();

            const body: unknown = call?.[1]?.body;

            expect(typeof body).toBe("string");
            expect(body).not.toContain("forged");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("drops an enriched log field that names a built-in field the log does not carry", () => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);

        try {
            const sink = enrichSink(otlpSink({ batch: false, endpoint: "https://collector.example" }), () => {
                return { "lunora.shard_key": "forged" };
            });
            const unsharded: LogEvent = { args: [], functionPath: log.functionPath, level: log.level, message: log.message, ts: log.ts };

            sink.onLog?.(unsharded);

            const call = fetchMock.mock.calls.find(([url]) => typeof url === "string" && url.endsWith("/v1/logs"));

            expect(call).toBeDefined();

            const body: unknown = call?.[1]?.body;

            expect(typeof body).toBe("string");
            expect(body).not.toContain("forged");
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
