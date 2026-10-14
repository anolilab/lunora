/**
 * `@lunora/server/otel` — hand a Lunora `ctx` to anything that speaks
 * `@opentelemetry/api`.
 *
 * **The problem.** Lunora's tracing is hand-rolled and zero-dependency, which is
 * the right call for a runtime that has to boot in a Workers isolate. The cost
 * is that a library instrumented against `@opentelemetry/api` — the Vercel AI
 * SDK's `experimental_telemetry`, a database driver's instrumentation, an
 * in-house shared package — cannot see Lunora's trace. Its spans go to whatever
 * global provider is registered, which in a Worker is the no-op one. They vanish.
 *
 * **The fix.** {@link createOtelTracer} adapts a `ctx` into an OTel `Tracer`, so
 * the library's spans become real `ctx.trace` spans in the request's trace:
 *
 * ```ts
 * import { createOtelTracer } from "@lunora/server/otel";
 *
 * export const summarize = action.action(async ({ args, ctx }) =>
 *     generateText({
 *         model: openai("gpt-4o"),
 *         prompt: args.prompt,
 *         experimental_telemetry: { isEnabled: true, tracer: createOtelTracer(ctx) },
 *     }),
 * );
 * ```
 *
 * **Why passing the tracer explicitly is the supported path.** OTel's ambient
 * `context` API (`trace.getActiveSpan()`, implicit parenting inside
 * `startActiveSpan`) needs `AsyncLocalStorage` to track the current span across
 * `await`s. Durable Objects run under a slimmer compatibility profile than
 * `nodejs_compat`, and `@lunora/do` deliberately avoids ALS for that reason —
 * the same reason `ctx.trace` threads its parent explicitly instead of keeping
 * an ambient stack. So this bridge implements the `Tracer` surface faithfully
 * and parents each span to the `Context` its caller THREADED (falling back to
 * the dispatch when none was), never to a dynamically-scoped "current" span:
 * nesting is flatter than a full SDK would give for a library that relies on
 * ambient context, but every span lands in the right trace, under the parent it
 * was told about, with the right timings, and none are lost. See
 * {@link createOtelTracer} for the precise semantics.
 *
 * `@opentelemetry/api` is a PEER dependency: it keeps a module-global registry,
 * so a second copy in the tree would silently split it.
 */
import type {
    Attributes,
    AttributeValue,
    Context,
    Exception,
    Link,
    Span,
    SpanContext,
    SpanOptions as OtelSpanOptions,
    SpanStatus,
    TimeInput,
    Tracer,
} from "@opentelemetry/api";
import { SpanKind, SpanStatusCode, trace as otelTrace, TraceFlags } from "@opentelemetry/api";

import type { LunoraTracer, SpanHandle } from "./types";

/**
 * The slice of a Lunora function `ctx` this bridge needs — the dispatch's span
 * handle and the span factory.
 *
 * Structural rather than `QueryCtx`/`MutationCtx`/`ActionCtx` so one signature
 * accepts all three (and a test double), while still being expressed in the real
 * {@link SpanHandle} / {@link LunoraTracer} types now that this lives beside them.
 */
interface LunoraTraceContext {
    /** The dispatch's own span handle — supplies the trace this bridge joins. */
    readonly span: SpanHandle;
    /** The span factory: `ctx.trace(name, fn, options)`. */
    readonly trace: LunoraTracer;
}

/** Options for {@link createOtelTracer}. */
interface OtelTracerOptions {
    /**
     * Prefix applied to every span name the bridge creates, e.g. `"ai."`.
     *
     * Useful when a third-party library emits generic names (`doGenerate`,
     * `execute`) that would be ambiguous next to your own spans in a collector.
     * Off by default — renaming someone else's spans breaks the dashboards their
     * own documentation tells you to build.
     */
    namePrefix?: string;
}

/** OTel `SpanKind` (a numeric enum) mapped onto Lunora's readable union. */
const KIND_NAMES: Record<number, "client" | "consumer" | "internal" | "producer" | "server"> = {
    [SpanKind.CLIENT]: "client",
    [SpanKind.CONSUMER]: "consumer",
    [SpanKind.INTERNAL]: "internal",
    [SpanKind.PRODUCER]: "producer",
    [SpanKind.SERVER]: "server",
};

/**
 * A random lowercase-hex id, matching the form Lunora's OTLP encoders emit.
 *
 * Uses the Web Crypto GLOBAL (present in workerd, Node >= 19, Bun, Deno), not
 * `node:crypto` — the same choice `shared/otlp.ts` makes, so the bridge stays
 * runtime-agnostic and needs no Node built-in import.
 */
const randomHex = (bytes: number): string => {
    const buffer = new Uint8Array(bytes);

    crypto.getRandomValues(buffer);

    let hex = "";

    for (const byte of buffer) {
        hex += byte.toString(16).padStart(2, "0");
    }

    return hex;
};

/**
 * Flatten OTel `Attributes` (whose values may be arrays) into the flat,
 * JSON-primitive bag Lunora's normalizer accepts.
 *
 * Arrays are joined rather than dropped: an attribute like
 * `gen_ai.request.stop_sequences` is genuinely useful, and a silently missing
 * attribute is harder to debug than a stringified one.
 */
const flattenAttributes = (attributes: Attributes | undefined): Record<string, unknown> => {
    const flat: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(attributes ?? {})) {
        if (value === undefined) {
            continue;
        }

        flat[key] = Array.isArray(value) ? value.map(String).join(",") : value;
    }

    return flat;
};

/**
 * An OTel `Span` backed by a live `ctx.trace` span.
 *
 * The two models disagree on lifetime: OTel spans are `start()` / `end()` pairs
 * a caller holds, while `ctx.trace` brackets a callback. The adapter bridges
 * them by keeping the `ctx.trace` body suspended on a promise that `end()`
 * resolves — so Lunora measures exactly the interval between `startSpan` and
 * `end`, records it through the normal path, and no part of the runtime needs a
 * special case for bridged spans.
 *
 * A span that is never ended therefore never records. That matches OTel's own
 * contract (an unended span is not exported) and beats guessing an end time.
 *
 * **Late end and sampling.** A bridged span may `end()` AFTER its dispatch has
 * settled — a streaming AI-SDK call, a detached handler. When it does, it records
 * through the normal `ctx.trace` → `recordSpan` path, which now snapshots the
 * trace's sampling verdict when the span opens and honours it at close (see
 * `@lunora/do`'s `recordSpan`): a late child of a sampled-OUT trace is no longer
 * exported unconditionally. The complementary lifetime bound — settling an
 * ABANDONED span (one whose `end()` is never called) so its suspended `ctx.trace`
 * body cannot pin this closure in a long-lived isolate — is deferred: the clean
 * route is a dispatch-teardown hook, and the `LunoraTraceContext` surface this
 * bridge is handed exposes none, while a timer is the very mechanism the DO
 * profile avoids. The correctness half (no orphan export) is done; the retention
 * half awaits a teardown hook on the ctx.
 */
class BridgeSpan implements Span {
    private ended = false;

    /** Resolves the suspended `ctx.trace` body, causing the span to be recorded. */
    private finish: (() => void) | undefined;

    private handle: SpanHandle | undefined;

    private readonly ids: SpanContext;

    /** Buffers writes that arrive before the `ctx.trace` body hands over its handle. */
    private readonly pending: ((handle: SpanHandle) => void)[] = [];

    private thrown: Error | undefined;

    public constructor(ids: SpanContext) {
        this.ids = ids;
    }

    /** The error to re-throw from the `ctx.trace` body so the span records as failed. */
    public get failure(): Error | undefined {
        return this.thrown;
    }

    public addEvent(name: string, attributes?: Attributes, _startTime?: TimeInput): this {
        this.write((handle) => {
            handle.addEvent(name, flattenAttributes(attributes));
        });

        return this;
    }

    public addLink(link: Link): this {
        this.write((handle) => {
            handle.addLink({
                attributes: flattenAttributes(link.attributes),
                spanId: link.context.spanId,
                traceId: link.context.traceId,
            });
        });

        return this;
    }

    public addLinks(links: Link[]): this {
        for (const link of links) {
            this.addLink(link);
        }

        return this;
    }

    /**
     * Attach the live handle from the `ctx.trace` body and replay anything that
     * was written before it arrived.
     *
     * The gap is real and unavoidable: `startSpan` must return synchronously,
     * while `ctx.trace` invokes its body on a microtask. A library that sets an
     * attribute immediately would otherwise lose it.
     */
    public attach(handle: SpanHandle, finish: () => void): void {
        this.handle = handle;
        this.finish = finish;

        for (const write of this.pending) {
            write(handle);
        }

        this.pending.length = 0;

        // `end()` beat the body to the punch — settle now rather than leaking a
        // suspended promise for a span that is already over.
        if (this.ended) {
            finish();
        }
    }

    public end(_endTime?: TimeInput): void {
        if (this.ended) {
            return;
        }

        this.ended = true;
        this.finish?.();
    }

    public isRecording(): boolean {
        return !this.ended;
    }

    public recordException(exception: Exception, _time?: TimeInput): void {
        this.write((handle) => {
            // OTel's `Exception` is `string | Error | { code?, message?, name?, stack? }`.
            // The object form is not an Error, so forwarding it verbatim would have
            // `String(value)` render it as "[object Object]" and lose the message —
            // the one part a reader actually needs.
            if (exception instanceof Error || typeof exception === "string") {
                handle.recordException(exception);

                return;
            }

            const normalized = new Error(exception.message ?? String(exception.code ?? "exception"));

            if (exception.name !== undefined) {
                normalized.name = exception.name;
            }

            if (exception.stack !== undefined) {
                normalized.stack = exception.stack;
            }

            handle.recordException(normalized);
        });
    }

    public setAttribute(key: string, value: AttributeValue): this {
        this.write((handle) => {
            handle.setAttribute(key, Array.isArray(value) ? value.map(String).join(",") : value);
        });

        return this;
    }

    public setAttributes(attributes: Attributes): this {
        this.write((handle) => {
            handle.setAttributes(flattenAttributes(attributes));
        });

        return this;
    }

    public setStatus(status: SpanStatus): this {
        if (status.code === SpanStatusCode.ERROR) {
            // Recorded as a THROWN error rather than an attribute, because that is
            // what makes the Lunora span `ok: false` — and therefore what makes it
            // survive error-biased tail sampling and render red in the studio. The
            // error is caught inside the bridge and never reaches user code.
            this.thrown = new Error(status.message ?? "span reported an error status");
        }

        return this;
    }

    public spanContext(): SpanContext {
        return this.ids;
    }

    public updateName(name: string): this {
        // Lunora names a span at creation (the name is what a collector groups
        // on, so it is snapshotted). Rather than silently ignore a rename, record
        // it as an attribute so the intent stays visible in the trace.
        this.write((handle) => {
            handle.setAttribute("otel.updated_name", name);
        });

        return this;
    }

    /**
     * Apply a write to the live handle, or buffer it until `attach` supplies one.
     * Last in the class so the public `Span` surface reads first.
     */
    private write(write: (handle: SpanHandle) => void): void {
        if (this.handle === undefined) {
            this.pending.push(write);

            return;
        }

        write(this.handle);
    }
}

/**
 * Adapt a Lunora `ctx` into an `@opentelemetry/api` `Tracer`.
 *
 * Spans created through it are ordinary `ctx.trace` spans: they join the
 * request's trace, appear in the studio waterfall, ride the same sampling
 * decision, and export through the same OTLP sink. Nothing in the runtime has to
 * know they came from a third-party library.
 *
 * **Parenting.** The parent is read from the `Context` the caller threads —
 * `startSpan(name, options, ctx)` parents to `trace.getSpanContext(ctx)` when it
 * names a span in THIS trace — and falls back to the dispatch when no Context is
 * passed (or it carries a span from a different trace, which would be a lie to
 * parent to). What the bridge does NOT do is track a dynamically scoped "current"
 * span, because that needs `AsyncLocalStorage` — unavailable in the Durable
 * Object profile (see the module doc). `startActiveSpan` therefore runs its
 * callback with the new span passed in, exactly as the interface requires, but
 * does NOT make it ambient: `trace.getActiveSpan()` inside that callback still
 * reports whatever the global provider says. A library that threads its `Context`
 * or the span it is handed (the common case, and what the AI SDK does) nests
 * correctly; one that relies on ambient context gets a flat trace instead of a
 * nested one — flatter, never wrong, never lost.
 *
 * **Ids and sampling.** The `SpanContext` returned by `startSpan` is the one the
 * span is RECORDED under: the id is minted here and handed to `ctx.trace` as its
 * span identity, so a `traceparent` a library builds from it names a span that
 * actually reaches the collector. `traceFlags` carries the trace's settled
 * sampling verdict rather than a hardcoded SAMPLED, so a sampled-out trace is not
 * announced downstream as kept.
 * @param context Any Lunora function context (`QueryCtx` / `MutationCtx` / `ActionCtx`).
 * @param options See {@link OtelTracerOptions}.
 */
const createOtelTracer = (context: LunoraTraceContext, options: OtelTracerOptions = {}): Tracer => {
    const { namePrefix = "" } = options;

    const startSpan = (name: string, spanOptions?: OtelSpanOptions, parentContext?: Context): Span => {
        // The trace is fixed by the dispatch; only the span id is new. It is
        // minted here rather than read back from `ctx.trace` because `startSpan`
        // is synchronous and callers may read `spanContext()` immediately — e.g.
        // to build a `traceparent` for an outbound call. It is then handed to
        // `ctx.trace` as the span's identity, so the id announced here is the id
        // the collector receives instead of a second, private one.
        const dispatch = context.span.spanContext();
        // The threaded `Context` names the parent when it carries one from THIS
        // trace. A span from another trace is not a parent — parenting to it would
        // invent an edge that does not exist — so that falls back to the dispatch,
        // exactly like an absent Context.
        const threaded = parentContext === undefined ? undefined : otelTrace.getSpanContext(parentContext);
        const parentSpanId = threaded?.traceId === dispatch.traceId ? threaded.spanId : dispatch.spanId;
        const spanId = randomHex(8);
        const ids: SpanContext = {
            spanId,
            // The trace's settled verdict, not a hardcoded SAMPLED: announcing a
            // sampled-out trace as sampled makes every downstream tier record
            // spans the collector will only ever hold the middle of.
            traceFlags: (dispatch.sampled ?? true) ? TraceFlags.SAMPLED : TraceFlags.NONE,
            traceId: dispatch.traceId,
        };
        const span = new BridgeSpan(ids);

        let settle: () => void = () => undefined;
        const ended = new Promise<void>((resolve) => {
            settle = resolve;
        });

        // Deliberately not awaited: the caller drives the lifetime through
        // `end()`. `.catch` is mandatory — the body re-throws on an ERROR status
        // so Lunora records a failed span, and that rejection must die here
        // rather than surfacing as an unhandled rejection in the isolate.
        context
            .trace(
                `${namePrefix}${name}`,
                async (_tracer, handle) => {
                    span.attach(handle, settle);

                    await ended;

                    if (span.failure !== undefined) {
                        throw span.failure;
                    }
                },
                {
                    ...(spanOptions?.attributes === undefined ? {} : { attributes: flattenAttributes(spanOptions.attributes) }),
                    ...(spanOptions?.kind === undefined ? {} : { kind: KIND_NAMES[spanOptions.kind] ?? "internal" }),
                    ...(spanOptions?.links === undefined
                        ? {}
                        : {
                              links: spanOptions.links.map((link) => {
                                  return {
                                      attributes: flattenAttributes(link.attributes),
                                      spanId: link.context.spanId,
                                      traceId: link.context.traceId,
                                  };
                              }),
                          }),
                },
                { parentSpanId, spanId },
            )
            .catch(() => {
                // Expected on the ERROR-status path; the span is already recorded.
            });

        return span;
    };

    return {
        startActiveSpan: (name: string, ...rest: unknown[]) => {
            // The interface has three overloads; the callback is always last, and
            // the two optional arguments are positional in a fixed order —
            // `(options, context, fn)`. The Context is threaded through so a
            // caller that scoped its parent explicitly still nests, which is the
            // only nesting available without an ambient span stack.
            const callback = rest.at(-1) as (span: Span) => unknown;
            const spanOptions = typeof rest[0] === "object" && rest[0] !== null ? (rest[0] as OtelSpanOptions) : undefined;
            const parentContext = rest.length > 2 ? (rest[1] as Context | undefined) : undefined;
            const span = startSpan(name, spanOptions, parentContext);

            // No ambient activation — see the parenting note above. The span IS
            // handed to the callback, which is what the overload contract
            // guarantees and what well-behaved instrumentation uses.
            return callback(span);
        },
        startSpan,
    };
};

export type { LunoraTraceContext, OtelTracerOptions };
export { createOtelTracer };
