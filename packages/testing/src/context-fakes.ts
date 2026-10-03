/**
 * The stand-in `ctx` surfaces the `lunoraTest` harness hands every context: throwing stubs for
 * what the in-memory harness does not model, the injectable `ctx.services`, and
 * the no-op / recording telemetry handles.
 */
import { LunoraError } from "@lunora/errors";
import type { LogFields, LunoraLogger, LunoraMetrics, LunoraTracer, SpanHandle } from "@lunora/server";

import { evaluationAttributes } from "./evaluation-telemetry";

/**
 * Build a value that throws a clear "not available in v1" error the moment a
 * handler touches the stubbed surface — but not at context construction, so
 * functions that never reach for it still run.
 */
const unavailable = (surface: string): never => {
    throw new LunoraError("INTERNAL", `ctx.${surface} is not available in the in-memory @lunora/testing harness (v1)`);
};

/** Keys read off any value by `await` and by vitest's printer and matchers — never a service name. */
const PROBED_KEYS: ReadonlySet<PropertyKey> = new Set(["$$typeof", "asymmetricMatch", "then", "toJSON"]);

/**
 * `ctx.services` for an action: the fakes passed to `lunoraTest`, with a
 * read of any other key throwing — a missing fake then names itself instead of
 * failing as `Cannot read properties of undefined`.
 */
const servicesContext = (fakes: Readonly<Record<string, object>> | undefined): Record<string, object> =>
    new Proxy(
        { ...fakes },
        {
            get(target, property): unknown {
                // Probed by `await` (`then`) and by test tooling printing or matching
                // the object; answering them would make it a thenable or a matcher.
                if (PROBED_KEYS.has(property) && !Object.hasOwn(target, property)) {
                    return undefined;
                }

                // A fake, or what every object has — symbols and `Object.prototype`
                // members (`toString`, `hasOwnProperty`) read by inspection and coercion.
                if (typeof property === "symbol" || Object.hasOwn(target, property) || property in Object.prototype) {
                    return Reflect.get(target, property) as unknown;
                }

                throw new LunoraError(
                    "INTERNAL",
                    `ctx.services.${property} has no fake in the @lunora/testing harness — pass lunoraTest(schema, { services: { ${property}: … } })`,
                );
            },
        },
    );

/**
 * The proxy target MUST be a function so the `apply` trap fires when the
 * stub is called directly (e.g. `ctx.fetch(url)`). A plain `{}` target is
 * not callable and throws "not a function" before our trap can run.
 */
const stubProxy = (surface: string): unknown =>
    new Proxy((..._args: unknown[]): never => unavailable(surface), {
        apply: () => unavailable(surface),
        get: () => unavailable(surface),
    });

/** What a handler attached to the dispatch's span (`ctx.span`) during a harness run. */
interface RecordedWideEvent {
    /**
     * Attributes accumulated across the run, merged in call order. Values are
     * recorded AS PASSED (not coerced the way the real pipeline normalizes them),
     * so a test asserts on what the handler meant rather than on the wire form.
     */
    attributes: LogFields;
    /** Span events recorded via `ctx.span.addEvent` / `recordException`, in order. */
    events: { attributes?: LogFields; name: string }[];
    /** Links recorded via `ctx.span.addLink`, in order. */
    links: { spanId: string; traceId: string }[];
}

/**
 * Fixed, well-formed trace ids for the harness.
 *
 * Constant rather than random so a snapshot or an assertion that happens to
 * include them stays stable across runs; well-formed (32/16 lowercase hex) so
 * code under test that parses or builds a `traceparent` from them behaves as it
 * would in production instead of hitting a validation path only tests can reach.
 */
const HARNESS_SPAN_CONTEXT = { spanId: "0000000000000001", traceId: "00000000000000000000000000000001" };

/**
 * A no-op {@link SpanHandle} for a `ctx.trace` body under test: a child span has
 * nowhere to go without a sink, so accept and drop what the body attaches (like
 * `noopMetrics`).
 *
 * The DISPATCH span (`ctx.span`) is deliberately NOT this — see
 * {@link createRecordingSpan}. What a handler records about the request as a
 * whole is exactly the kind of thing a test wants to assert on, and dropping it
 * would make the wide-event API the one part of `ctx` that is untestable.
 */
const noopSpan: SpanHandle = {
    addEvent: () => undefined,
    addLink: () => undefined,
    recordEvaluation: () => undefined,
    recordException: () => undefined,
    setAttribute: () => undefined,
    setAttributes: () => undefined,
    spanContext: () => HARNESS_SPAN_CONTEXT,
};

/**
 * A recording {@link SpanHandle} backing `ctx.span` in the harness, so a test can
 * assert on the wide event a handler builds:
 *
 * ```ts
 * await t.mutation(checkout, { … });
 * expect(t.wideEvent().attributes["payment.provider"]).toBe("stripe");
 * ```
 *
 * Without this, the recommended way to instrument a handler would have no
 * assertion story at all, and "did we record the right thing?" would only be
 * answerable by deploying.
 */
const createRecordingSpan = (): { handle: SpanHandle; recorded: RecordedWideEvent } => {
    const recorded: RecordedWideEvent = { attributes: {}, events: [], links: [] };

    const handle: SpanHandle = {
        addEvent: (name, attributes) => {
            recorded.events.push({ ...(attributes === undefined ? {} : { attributes: { ...attributes } }), name });
        },
        addLink: (link) => {
            recorded.links.push({ spanId: link.spanId, traceId: link.traceId });
        },
        recordEvaluation: (evaluation) => {
            // Merged into the recorded attributes exactly as production does, so a
            // test asserting on `gen_ai.evaluation.<name>.score` sees the same keys
            // the collector would. Reuses this package's own `evaluationAttributes`
            // rather than the bundler-inlined `shared/` copy — same contract, no
            // extra import path for the harness to carry.
            Object.assign(recorded.attributes, evaluationAttributes(evaluation));
        },
        recordException: (error) => {
            // Mirrors the production recorder's attribute set, `exception.stacktrace`
            // included: a test that asserts on the harness's exception events should
            // see the same shape a collector would, or it silently passes against a
            // narrower record than the one that ships.
            const attributes: LogFields = {
                "exception.message": error instanceof Error ? error.message : String(error),
                // NOTE: production prefers a `LunoraError`'s stable `code` here (via
                // `toErrorType`), which is not exported from `@lunora/do`. For a
                // plain Error — the common case in a test — the two agree.
                "exception.type": error instanceof Error ? error.constructor.name : "Error",
            };

            if (error instanceof Error && error.stack !== undefined) {
                attributes["exception.stacktrace"] = error.stack;
            }

            handle.addEvent("exception", attributes);
        },
        setAttribute: (key, value) => {
            recorded.attributes[key] = value;
        },
        setAttributes: (fields) => {
            Object.assign(recorded.attributes, fields);
        },
        spanContext: () => HARNESS_SPAN_CONTEXT,
    };

    return { handle, recorded };
};

/**
 * `ctx.trace` under test: runs the body and returns its value, recording
 * nothing. There is no sink in the harness, so a span has nowhere to go — but
 * the body must still execute and its result and any throw must pass through
 * untouched, or instrumenting a handler would change what the test observes. The
 * body still receives a (no-op) span handle so post-hoc attributes are accepted.
 */
const passthroughTrace: LunoraTracer = async <T>(_name: string, function_: (trace: LunoraTracer, span: SpanHandle) => Promise<T> | T): Promise<T> =>
    await function_(passthroughTrace, noopSpan);

/** `ctx.metrics` under test: accepts every measurement and records nothing. */
const noopMetrics: LunoraMetrics = {
    count: () => undefined,
    gauge: () => undefined,
    record: () => undefined,
};

const noopLog: LunoraLogger = {
    debug: () => undefined,
    error: () => undefined,
    event: () => undefined,
    fatal: () => undefined,
    info: () => undefined,
    log: () => undefined,
    trace: () => undefined,
    warn: () => undefined,
    with: () => noopLog,
};

export type { RecordedWideEvent };
export { createRecordingSpan, noopLog, noopMetrics, passthroughTrace, servicesContext, stubProxy };
