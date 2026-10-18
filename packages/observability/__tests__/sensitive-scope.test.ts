import { describe, expect, it, vi } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import type { TracerDeps } from "../src/context-telemetry";
import { createSpanCollector, createTracedFetch, createTracer, dispatchRootSpan } from "../src/context-telemetry";
import { createDatabaseTally, instrumentDatabase } from "../src/database-telemetry";
import { createSensitiveScope, NO_SENSITIVE_SCOPE, SENSITIVE_ARG_MASK, sensitiveValues } from "../src/request-log";

/**
 * A `v.sensitive` value is scrubbed by what it IS, not what the attribute is called:
 * the scope is built from the marked values of one invocation and applied to every
 * span write, exception and error message that invocation makes. These tests use the
 * innocuous key `value` throughout, the case a key-name rule can never catch.
 */

const SECRET = "marked-secret-value";
const anchor = { rootSpanId: "root0000root0000", traceId: "trace00000000000000000000000000" };
const ids = { spanId: "span0000span0000", traceId: "trace00000000000000000000000000" };

/** A chain of `depth` single-key objects ending in `leaf`, to reach past the scrub's depth limit. */
const nest = (depth: number, leaf: Record<string, unknown>): Record<string, unknown> => {
    let node: Record<string, unknown> = leaf;

    for (let level = 0; level < depth; level += 1) {
        node = { next: node };
    }

    return node;
};

const setupTracer = (overrides: Partial<TracerDeps> = {}) => {
    const recorded: SpanEvent[] = [];

    const trace = createTracer({
        anchor,
        functionPath: "vault:store",
        record: (span) => {
            recorded.push(span);
        },
        shardKey: "shard-1",
        userId: () => undefined,
        ...overrides,
    });

    return { recorded, trace };
};

describe("createSensitiveScope", () => {
    it("masks the marked value in free text and keeps the rest of the text", () => {
        expect.assertions(1);

        expect(createSensitiveScope([SECRET]).text(`charged with ${SECRET} ok`)).toBe(`charged with ${SENSITIVE_ARG_MASK} ok`);
    });

    it("masks a value shorter than the substring threshold only when it is the whole text", () => {
        expect.assertions(3);

        // Three characters: inside other text it is left alone, so `ok!` inside `look!` survives.
        const scope = createSensitiveScope(["ok!"]);

        expect(scope.text("look!")).toBe("look!");
        expect(scope.text("ok!")).toBe(SENSITIVE_ARG_MASK);
        expect(scope.text("the ok! flag")).toBe("the ok! flag");
    });

    it("masks a value of exactly the substring threshold inside other text", () => {
        expect.assertions(2);

        const scope = createSensitiveScope(["abcd"]);

        expect(scope.text("x abcd y")).toBe(`x ${SENSITIVE_ARG_MASK} y`);
        expect(scope.text("abcd")).toBe(SENSITIVE_ARG_MASK);
    });

    it("masks a numeric value as a whole field value, whatever its length", () => {
        expect.assertions(2);

        const scope = createSensitiveScope(["42"]);

        expect(scope.fields({ value: 42, label: 42 })).toEqual({ label: SENSITIVE_ARG_MASK, value: SENSITIVE_ARG_MASK });
        expect(scope.fields({ value: 43 })).toEqual({ value: 43 });
    });

    it("returns the same reference for a bag it did not change", () => {
        expect.assertions(2);

        const bag = { label: "primary", nested: { a: 1 } };
        const scope = createSensitiveScope([SECRET]);

        expect(scope.fields(bag)).toBe(bag);
        expect(scope.value(bag)).toBe(bag);
    });

    it("scrubs a secret nested in a structured value", () => {
        expect.assertions(1);

        expect(createSensitiveScope([SECRET]).value({ rows: [{ value: `prefix ${SECRET}` }] })).toEqual({
            rows: [{ value: `prefix ${SENSITIVE_ARG_MASK}` }],
        });
    });

    it("masks a secret nested past the depth limit, and leaves a shallow sibling alone", () => {
        expect.assertions(4);

        const bag = { deep: nest(10, { value: `prefix ${SECRET}` }), label: "primary" };
        const scope = createSensitiveScope([SECRET]);

        const scrubbedFields = scope.fields(bag);
        const scrubbedValue = scope.value(bag);

        expect(scrubbedFields.label).toBe("primary");
        expect(scrubbedValue.label).toBe("primary");
        expect(JSON.stringify(scrubbedFields)).not.toContain(SECRET);
        expect(JSON.stringify(scrubbedValue)).not.toContain(SECRET);
    });

    it("masks a back-reference to an object still being scrubbed", () => {
        expect.assertions(3);

        const node: Record<string, unknown> = { label: "primary", value: SECRET };

        node.self = node;

        const scrubbed = createSensitiveScope([SECRET]).value(node);

        expect(scrubbed.self).toBe(SENSITIVE_ARG_MASK);
        expect(scrubbed.label).toBe("primary");
        expect(scrubbed.value).toBe(SENSITIVE_ARG_MASK);
    });

    it("scrubs nothing once cleared, so a later record that repeats the text is untouched", () => {
        expect.assertions(2);

        const scope = createSensitiveScope([SECRET]);

        scope.clear();

        expect(scope.text(SECRET)).toBe(SECRET);
        expect(scope.fields({ value: SECRET })).toEqual({ value: SECRET });
    });

    it("admits a composed call's values into the same scope, and admits nothing once cleared", () => {
        expect.assertions(3);

        const scope = createSensitiveScope([SECRET]);

        scope.add(["child-secret-value"]);

        expect(scope.text(`child-secret-value and ${SECRET}`)).toBe(`${SENSITIVE_ARG_MASK} and ${SENSITIVE_ARG_MASK}`);

        scope.clear();
        scope.add(["late-secret-value"]);

        expect(scope.text("late-secret-value")).toBe("late-secret-value");
        expect(scope.text(SECRET)).toBe(SECRET);
    });

    it("never lets an admitted value reach the shared scope of an unmarked invocation", () => {
        expect.assertions(1);

        NO_SENSITIVE_SCOPE.add(["shared-secret-value"]);

        expect(NO_SENSITIVE_SCOPE.text("shared-secret-value")).toBe("shared-secret-value");
    });

    it("keeps two concurrent invocations' values apart", () => {
        expect.assertions(4);

        const first = createSensitiveScope(["first-secret-value"]);
        const second = createSensitiveScope(["second-secret-value"]);

        expect(first.text("first-secret-value and second-secret-value")).toBe(`${SENSITIVE_ARG_MASK} and second-secret-value`);
        expect(second.text("first-secret-value and second-secret-value")).toBe(`first-secret-value and ${SENSITIVE_ARG_MASK}`);

        first.clear();

        expect(second.text("second-secret-value")).toBe(SENSITIVE_ARG_MASK);
        expect(NO_SENSITIVE_SCOPE.text(SECRET)).toBe(SECRET);
    });
});

describe("sensitiveValues", () => {
    it("collects only the marked arguments, in their string, number and JSON forms", () => {
        expect.assertions(2);

        const args = { label: "primary", value: { token: SECRET, count: 3 }, amount: 7 };

        expect(sensitiveValues(args, new Set(["value"]))).toEqual(expect.arrayContaining([SECRET, "3", JSON.stringify({ token: SECRET, count: 3 })]));
        expect(sensitiveValues(args, new Set(["value"]))).not.toContain("primary");
    });

    it("collects a marked value nested past the depth limit", () => {
        expect.assertions(1);

        expect(sensitiveValues({ value: nest(10, { token: SECRET }) }, new Set(["value"]))).toContain(SECRET);
    });
});

describe("span writes under a sensitive scope", () => {
    it("scrubs a span attribute set through the handle and keeps an unmarked sibling", () => {
        expect.assertions(2);

        const { collected, handle } = createSpanCollector(ids, false, createSensitiveScope([SECRET]));

        handle.setAttributes({ label: "primary", value: SECRET });

        expect(collected.attributes).toEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
        expect(handle.spanContext().traceId).toBe(ids.traceId);
    });

    it("scrubs a span event's attributes and name", () => {
        expect.assertions(1);

        const { collected, handle } = createSpanCollector(ids, false, createSensitiveScope([SECRET]));

        handle.addEvent(`sent ${SECRET}`, { value: SECRET, label: "kept" });

        expect(collected.events[0]).toEqual(
            expect.objectContaining({ attributes: { label: "kept", value: SENSITIVE_ARG_MASK }, name: `sent ${SENSITIVE_ARG_MASK}` }),
        );
    });

    it("scrubs an exception's message, and its stack when captureRaw is on", () => {
        expect.assertions(3);

        const error = new Error(`card ${SECRET} declined`);

        const plain = createSpanCollector(ids, false, createSensitiveScope([SECRET]));

        plain.handle.recordException(error);

        expect(plain.collected.events[0]?.attributes?.["exception.message"]).toBe(`card ${SENSITIVE_ARG_MASK} declined`);

        // Dev escape hatch: the stack carries the message, so it must be scrubbed too.
        const raw = createSpanCollector(ids, true, createSensitiveScope([SECRET]));

        raw.handle.recordException(error);

        const stack = raw.collected.events[0]?.attributes?.["exception.stacktrace"];

        expect(stack).toBeTypeOf("string");
        expect(stack as string).not.toContain(SECRET);
    });

    it("scrubs a recorded evaluation's score label", () => {
        expect.assertions(1);

        const { collected, handle } = createSpanCollector(ids, false, createSensitiveScope([SECRET]));

        handle.recordEvaluation({ label: SECRET, name: "quality", score: 0.5 });

        expect(JSON.stringify(collected.attributes)).not.toContain(SECRET);
    });
});

describe("ctx.trace under a sensitive scope", () => {
    it("scrubs start attributes, post-hoc attributes and the thrown message of a failed body", async () => {
        expect.assertions(5);

        const { recorded, trace } = setupTracer({ scope: createSensitiveScope([SECRET]) });

        await expect(
            trace(
                "charge",
                (_inner, span) => {
                    span.setAttribute("value", SECRET);
                    throw new Error(`rejected ${SECRET}`);
                },
                { label: "primary", value: SECRET },
            ),
        ).rejects.toThrow(`rejected ${SECRET}`);

        const [span] = recorded;

        expect(span?.attributes).toEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
        expect(span?.error?.message).toBe(`rejected ${SENSITIVE_ARG_MASK}`);
        expect(JSON.stringify(recorded)).not.toContain(SECRET);
        expect(span?.name).toBe("charge");
    });

    it("scrubs the span even when captureRaw is on, because the dev escape hatch is for internals only", async () => {
        expect.assertions(2);

        const { recorded, trace } = setupTracer({ captureRaw: true, scope: createSensitiveScope([SECRET]) });

        await trace("charge", () => undefined, { value: SECRET });

        expect(recorded[0]?.attributes).toEqual({ value: SENSITIVE_ARG_MASK });
        expect(JSON.stringify(recorded)).not.toContain(SECRET);
    });

    it("leaves a span untouched when no scope is given", async () => {
        expect.assertions(1);

        const { recorded, trace } = setupTracer();

        await trace("charge", () => undefined, { value: SECRET });

        expect(recorded[0]?.attributes).toEqual({ value: SECRET });
    });
});

describe("outbound fetch and the dispatch root span under a sensitive scope", () => {
    it("scrubs a marked value that a fetch URL path carries and a failed fetch's message", async () => {
        expect.assertions(3);

        const recorded: SpanEvent[] = [];
        const fetch = createTracedFetch(
            {
                anchor,
                functionPath: "vault:store",
                record: (span) => {
                    recorded.push(span);
                },
                scope: createSensitiveScope([SECRET]),
                shardKey: "shard-1",
                userId: () => undefined,
            },
            () => Promise.reject(new TypeError(`fetch failed for https://api.example.test/keys/${SECRET}`)),
        );

        await expect(fetch(`https://api.example.test/keys/${SECRET}`)).rejects.toThrow(TypeError);

        expect(recorded[0]?.attributes?.["url.full"]).toBe(`https://api.example.test/keys/${SENSITIVE_ARG_MASK}`);
        expect(JSON.stringify(recorded)).not.toContain(SECRET);
    });

    it("scrubs the root span's failure message", () => {
        expect.assertions(2);

        const span = dispatchRootSpan({
            anchor,
            durationMs: 1,
            failure: { thrown: new Error(`no such card ${SECRET}`) },
            functionPath: "vault:store",
            scope: createSensitiveScope([SECRET]),
            shardKey: "shard-1",
            startTs: 0,
            userId: undefined,
        });

        expect(span.error?.message).toBe(`no such card ${SENSITIVE_ARG_MASK}`);
        expect(JSON.stringify(span)).not.toContain(SECRET);
    });
});

describe("ctx.db error messages under a sensitive scope", () => {
    // A driver's message quotes the row it rejected (a unique-key violation names the key).
    it.each([false, true])("scrubs a marked value a driver error quotes, with captureRaw=%s", async (captureRaw) => {
        expect.assertions(2);

        const recorded: SpanEvent[] = [];
        const database = {
            insert: vi.fn<(table: string, document: Record<string, unknown>) => Promise<never>>(() =>
                Promise.reject(new Error(`duplicate key (email)=(${SECRET}) already exists`)),
            ),
        };
        const instrumented = instrumentDatabase(database, {
            anchor,
            captureRaw,
            functionPath: "vault:store",
            mode: "spans",
            record: (span) => {
                recorded.push(span);
            },
            scope: createSensitiveScope([SECRET]),
            shardKey: "shard-1",
            tally: createDatabaseTally(),
            userId: () => undefined,
        });

        await expect(instrumented.insert("keys", { value: SECRET })).rejects.toThrow(SECRET);
        expect(JSON.stringify(recorded)).not.toContain(SECRET);
    });
});
