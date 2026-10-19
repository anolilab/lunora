import { describe, expect, it, vi } from "vitest";

import type { MetricEvent } from "../../../shared/metric-event";
import type { SpanEvent } from "../../../shared/span-event";
import type { TracerDeps } from "../src/context-telemetry";
import { createMetrics, createSpanCollector, createTracedFetch, createTracer, dispatchRootSpan } from "../src/context-telemetry";
import { createDatabaseTally, instrumentDatabase } from "../src/database-telemetry";
import { createSensitiveScope, NO_SENSITIVE_SCOPE, SENSITIVE_ARG_MASK, sensitiveNames, sensitiveValues } from "../src/request-log";

/**
 * A `v.sensitive` value is scrubbed by what it IS, not what the attribute is called:
 * the scope is built from the marked values of one invocation and applied to every
 * span write, exception and error message that invocation makes. These tests use the
 * innocuous key `value` throughout, the case a key-name rule can never catch.
 */

const SECRET = "marked-secret-value";
/** A marked value with a newline, a quote, a backslash and a tab: each one changes under JSON. */
const TRICKY = 'line one\n"quoted"\tand \\ back';
const TRICKY_ESCAPED = JSON.stringify(TRICKY).slice(1, -1);
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

    it("masks a short value as a whole token in free text, and leaves it inside a longer token alone", () => {
        expect.assertions(4);

        const scope = createSensitiveScope(["123"]);

        expect(scope.text("invalid code 123")).toBe(`invalid code ${SENSITIVE_ARG_MASK}`);
        expect(scope.text("invalid code 1234")).toBe("invalid code 1234");
        expect(scope.text("ref a123b")).toBe("ref a123b");
        expect(scope.text("ok!")).toBe("ok!");
    });

    it("masks a short value of one or two characters only when it is the whole text", () => {
        expect.assertions(2);

        // A numeric leaf of a marked object (`{ count: 3 }` collects "3") must not erase every standalone digit.
        const scope = createSensitiveScope(["3", "42"]);

        expect(scope.text("retry 3 of 42")).toBe("retry 3 of 42");
        expect(scope.text("42")).toBe(SENSITIVE_ARG_MASK);
    });

    it("masks a short value embedded in an error message, a log line and a span attribute", async () => {
        expect.assertions(4);

        const scope = createSensitiveScope(["123"]);
        const { recorded, trace } = setupTracer({ scope });

        await expect(
            trace("charge", () => {
                throw new Error("invalid code 123");
            }),
        ).rejects.toThrow("invalid code 123");

        expect(recorded[0]?.error?.message).toBe(`invalid code ${SENSITIVE_ARG_MASK}`);
        expect(scope.text("charged 123 units")).toBe(`charged ${SENSITIVE_ARG_MASK} units`);

        const { collected, handle } = createSpanCollector(ids, false, scope);

        handle.setAttribute("note", "code 123 rejected");

        expect(collected.attributes).toEqual({ note: `code ${SENSITIVE_ARG_MASK} rejected` });
    });

    it("masks a one- or two-character value inside a JSON-serialized log, and leaves its bare prose occurrence alone", () => {
        expect.assertions(2);

        // `ab` is below every text threshold, so only its JSON string form (`"ab"`) can be
        // masked, and only where a serializer quoted it.
        const scope = createSensitiveScope(sensitiveValues({ value: { token: "ab", note: "n" } }, new Set(["value"])));
        const logged = JSON.stringify({ label: "primary", value: { token: "ab" } });

        expect(scope.text(logged)).toBe(JSON.stringify({ label: "primary", value: { token: SENSITIVE_ARG_MASK } }));
        expect(scope.text("the ab side of the ledger")).toBe("the ab side of the ledger");
    });

    it("masks a value of exactly the substring threshold inside other text", () => {
        expect.assertions(2);

        const scope = createSensitiveScope(["abcd"]);

        expect(scope.text("x abcd y")).toBe(`x ${SENSITIVE_ARG_MASK} y`);
        expect(scope.text("abcd")).toBe(SENSITIVE_ARG_MASK);
    });

    it("masks a numeric value of three digits or more as a whole field value, and leaves a shorter one alone", () => {
        expect.assertions(3);

        const scope = createSensitiveScope(["421", "42", "0"]);

        expect(scope.fields({ value: 421, label: 421 })).toEqual({ label: SENSITIVE_ARG_MASK, value: SENSITIVE_ARG_MASK });
        expect(scope.fields({ value: 422 })).toEqual({ value: 422 });
        // A short numeric leaf must not blank the retry counts and status fields of the same invocation.
        expect(scope.fields({ retries: 0, rows: 42 })).toEqual({ retries: 0, rows: 42 });
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

describe("field names under a sensitive scope", () => {
    it("masks a marked string used as a log field name, and keeps an unmarked sibling key", () => {
        expect.assertions(1);

        expect(createSensitiveScope([SECRET]).fields({ [SECRET]: "a", label: "primary" })).toEqual({
            [SENSITIVE_ARG_MASK]: "a",
            label: "primary",
        });
    });

    it("masks a marked string used as a span attribute name, and keeps an unmarked sibling key", () => {
        expect.assertions(1);

        const { collected, handle } = createSpanCollector(ids, false, createSensitiveScope([SECRET]));

        handle.setAttributes({ [SECRET]: "a", label: "primary" });

        expect(collected.attributes).toEqual({ [SENSITIVE_ARG_MASK]: "a", label: "primary" });
    });

    it("gives two keys that both mask to the placeholder distinct names, and loses neither", () => {
        expect.assertions(2);

        const scrubbed = createSensitiveScope(["first-secret-value", "second-secret-value"]).fields({
            "first-secret-value": 1,
            "second-secret-value": 2,
        });

        expect(Object.keys(scrubbed)).toEqual([SENSITIVE_ARG_MASK, `${SENSITIVE_ARG_MASK}#2`]);
        expect(Object.values(scrubbed)).toEqual([1, 2]);
    });

    it("masks a property name of a marked object as a whole field name, and leaves free text alone", () => {
        expect.assertions(3);

        const names = sensitiveNames({ creds: { "ops-mailbox": 1, nested: { value: 2 } } }, new Set(["creds"]));
        const scope = createSensitiveScope([], names);

        expect(scope.fields({ "ops-mailbox": 1, "x-ops-mailbox-y": 2, label: "primary" })).toEqual({
            [SENSITIVE_ARG_MASK]: 1,
            "x-ops-mailbox-y": 2,
            label: "primary",
        });
        expect(scope.text("ops-mailbox rejected")).toBe("ops-mailbox rejected");
        expect(names).not.toContain("creds");
    });

    it("masks a marked property name used as a telemetry name, and leaves prose that contains it alone", () => {
        expect.assertions(4);

        const names = sensitiveNames({ creds: { "ops-mailbox": 1 } }, new Set(["creds"]));
        const scope = createSensitiveScope([], names);
        const { collected, handle } = createSpanCollector(ids, false, scope);

        handle.addEvent("ops-mailbox", {});

        expect(scope.name("ops-mailbox")).toBe(SENSITIVE_ARG_MASK);
        expect(scope.name("ops-mailbox rejected")).toBe("ops-mailbox rejected");
        expect(collected.events[0]?.name).toBe(SENSITIVE_ARG_MASK);
        expect(collected.events).toHaveLength(1);
    });
});

describe("escaped spellings under a sensitive scope", () => {
    const scopeFor = (value: unknown, label = "value") => createSensitiveScope(sensitiveValues({ [label]: value }, new Set([label])));

    it("masks a marked string's JSON-escaped spelling inside serialized arguments", () => {
        expect.assertions(1);

        // The marked object carries one more key, so the logged JSON is not its whole JSON:
        // only the escaped leaf can match.
        const logged = JSON.stringify({ label: "primary", value: { token: TRICKY } });

        expect(scopeFor({ token: TRICKY, note: "n" }).text(logged)).toBe(JSON.stringify({ label: "primary", value: { token: SENSITIVE_ARG_MASK } }));
    });

    it("masks the escaped spelling of a marked top-level string", () => {
        expect.assertions(1);

        expect(scopeFor(TRICKY).text(`got "${TRICKY_ESCAPED}" from the caller`)).toBe(`got "${SENSITIVE_ARG_MASK}" from the caller`);
    });

    it("leaves an unmarked sibling that JSON also escapes untouched", () => {
        expect.assertions(1);

        const logged = JSON.stringify({ label: 'a "quoted"\n label', value: { token: TRICKY } });

        expect(scopeFor({ token: TRICKY, note: "n" }).text(logged)).toBe(JSON.stringify({ label: 'a "quoted"\n label', value: { token: SENSITIVE_ARG_MASK } }));
    });

    it("masks the escaped spelling of a marked value past the depth limit", () => {
        expect.assertions(1);

        const logged = JSON.stringify(nest(10, { token: TRICKY }));

        expect(scopeFor(nest(10, { token: TRICKY, note: "n" })).text(logged)).toBe(JSON.stringify(nest(10, { token: SENSITIVE_ARG_MASK })));
    });

    it("masks the escaped spelling in a structured field value", () => {
        expect.assertions(1);

        expect(scopeFor(TRICKY).fields({ label: "primary", payload: `sent ${TRICKY_ESCAPED}` })).toStrictEqual({
            label: "primary",
            payload: `sent ${SENSITIVE_ARG_MASK}`,
        });
    });

    it("does not search ordinary text for a short value's escaped spelling", () => {
        expect.assertions(2);

        // `""` is two characters, so the raw value is never searched for inside text. Its
        // escaped spelling `\"\"` is four characters: registering it would mask an unmarked
        // sibling that quotes the same sequence, so a short value gets no escaped spelling.
        const scope = scopeFor('""');
        const sibling = JSON.stringify({ label: 'say "" twice', value: "x" });

        expect(scope.text(sibling)).toBe(sibling);
        expect(sensitiveValues({ value: '""' }, new Set(["value"]))).toStrictEqual(['""']);
    });

    it("does not mask ordinary text that only resembles a short value's escaped spelling", () => {
        expect.assertions(1);

        // A newline escapes to `\n`, two characters: below both substring thresholds, so
        // prose that quotes the literal sequence is kept, as it would be for any short value.
        expect(scopeFor("\n").text(String.raw`use \n to break a line`)).toBe(String.raw`use \n to break a line`);
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

    it("collects the JSON-escaped spelling of a string leaf that JSON escapes", () => {
        expect.assertions(2);

        expect(sensitiveValues({ value: { token: TRICKY } }, new Set(["value"]))).toEqual(expect.arrayContaining([TRICKY, TRICKY_ESCAPED]));
        expect(sensitiveValues({ value: TRICKY }, new Set(["value"]))).toEqual(expect.arrayContaining([TRICKY, TRICKY_ESCAPED]));
    });

    it("registers a second spelling only when JSON actually changes the value", () => {
        expect.assertions(2);

        const found = sensitiveValues({ value: { token: SECRET } }, new Set(["value"]));

        expect(found).toHaveLength(2);
        expect(found).toEqual(expect.arrayContaining([SECRET, JSON.stringify({ token: SECRET })]));
    });

    it("collects the JSON-escaped spelling of a marked value nested past the depth limit", () => {
        expect.assertions(1);

        expect(sensitiveValues({ value: nest(10, { token: TRICKY }) }, new Set(["value"]))).toContain(TRICKY_ESCAPED);
    });
});

describe("telemetry names under a sensitive scope, beyond the event and span handle", () => {
    const names = sensitiveNames({ creds: { "ops-mailbox": 1 } }, new Set(["creds"]));

    it("masks a marked property name used as a Cloudflare span name, on the recorded span and the mirrored trace", async () => {
        expect.assertions(3);

        // A span body that accepts any call, so the bridge can run without a real tracing object.
        const span = new Proxy({}, { get: () => () => undefined });
        const enterSpan = vi.fn<(name: string, body: (value: unknown) => unknown) => Promise<unknown>>(async (_name, body) => body(span));
        const recorded: SpanEvent[] = [];
        const tracer = createTracer({
            anchor,
            fuseHostSpans: true,
            functionPath: "vault:trace",
            record: (event) => {
                recorded.push(event);
            },
            resolveHostTracing: async () => ({ enterSpan }) as never,
            scope: createSensitiveScope([], names),
            shardKey: "shard-1",
            userId: () => undefined,
        });

        await tracer("ops-mailbox", () => "ok");

        expect(enterSpan).toHaveBeenCalledWith(SENSITIVE_ARG_MASK, expect.any(Function));
        expect(recorded[0]?.name).toBe(SENSITIVE_ARG_MASK);
        expect(JSON.stringify(recorded)).not.toContain("ops-mailbox");
    });

    it("masks the decoded text of a marked byte argument, and registers no bare JSON form of its buffer", () => {
        expect.assertions(2);

        // A handler that decodes the bytes and logs the text: the text is what must be masked.
        const bytes = new TextEncoder().encode(SECRET).buffer;
        const scope = createSensitiveScope(sensitiveValues({ value: bytes }, new Set(["value"])));

        expect(scope.text(`decoded ${SECRET}`)).toBe(`decoded ${SENSITIVE_ARG_MASK}`);
        expect(scope.text("an ordinary {} stays")).toBe("an ordinary {} stays");
    });

    it("registers nothing for a marked byte argument that is not UTF-8", () => {
        expect.assertions(1);

        const scope = createSensitiveScope(sensitiveValues({ value: new Uint8Array([0xff, 0xfe, 0xfd]).buffer }, new Set(["value"])));

        // A lenient decode of these bytes is three U+FFFD; registered as text, it would mask this line.
        expect(scope.text("\uFFFD\uFFFD\uFFFD")).toBe("\uFFFD\uFFFD\uFFFD");
    });

    it("masks a marked property name used as a metric name", () => {
        expect.assertions(2);

        const recorded: MetricEvent[] = [];
        const metrics = createMetrics({
            functionPath: "vault:metric",
            record: (event) => {
                recorded.push(event);
            },
            scope: createSensitiveScope([], names),
            shardKey: "shard-1",
        });

        metrics.count("ops-mailbox");

        expect(recorded[0]?.name).toBe(SENSITIVE_ARG_MASK);
        expect(JSON.stringify(recorded)).not.toContain("ops-mailbox");
    });

    it("masks a marked value in the host that names an outbound fetch span", async () => {
        expect.assertions(2);

        const recorded: SpanEvent[] = [];
        const fetch = createTracedFetch(
            {
                anchor,
                functionPath: "vault:send",
                record: (span) => {
                    recorded.push(span);
                },
                scope: createSensitiveScope([SECRET]),
                shardKey: "shard-1",
                userId: () => undefined,
            },
            async () => new Response("ok"),
        );

        await fetch(`https://${SECRET}.example.test/x`);

        expect(recorded[0]?.name).toBe(`GET ${SENSITIVE_ARG_MASK}.example.test`);
        expect(JSON.stringify(recorded)).not.toContain(SECRET);
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

    it("leaves a boolean out of the free-text secrets, so a marked flag does not rewrite every `true` in the logs", () => {
        expect.assertions(3);

        const scope = createSensitiveScope(sensitiveValues({ flag: true, other: "visible", token: SECRET }, new Set(["flag", "token"])));

        expect(scope.text('{"ok":true,"retry":false} will construe it')).toBe('{"ok":true,"retry":false} will construe it');
        // A marked string beside it is still masked, so the scope is not simply empty.
        expect(scope.text(`charged with ${SECRET}`)).toBe(`charged with ${SENSITIVE_ARG_MASK}`);
        expect(sensitiveValues({ flag: true }, new Set(["flag"]))).toStrictEqual([]);
    });

    it("scrubs a span that is still open when the invocation settles, and releases the values once it is recorded", async () => {
        expect.assertions(5);

        const scope = createSensitiveScope([SECRET]);
        const { recorded, trace } = setupTracer({ scope });

        let open!: () => void;
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });

        const pending = trace(
            "charge",
            async (_inner, span) => {
                await gate;
                span.setAttribute("value", SECRET);
                span.addEvent(`sent ${SECRET}`, { value: SECRET });
                throw new Error(`rejected ${SECRET}`);
            },
            { label: "primary" },
        );

        // The dispatch settles while the handler's span is still open.
        scope.clear();
        open();

        await expect(pending).rejects.toThrow(`rejected ${SECRET}`);

        const [span] = recorded;

        expect(span?.attributes).toEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
        expect(span?.error?.message).toBe(`rejected ${SENSITIVE_ARG_MASK}`);
        expect(JSON.stringify(recorded)).not.toContain(SECRET);
        expect(scope.text(SECRET)).toBe(SECRET);
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

    it("scrubs a fetch span that completes after the invocation settled", async () => {
        expect.assertions(2);

        const scope = createSensitiveScope([SECRET]);
        const recorded: SpanEvent[] = [];
        let respond!: () => void;
        const response = new Promise<Response>((resolve) => {
            respond = () => {
                resolve(new Response(null, { status: 204 }));
            };
        });
        const fetch = createTracedFetch(
            {
                anchor,
                functionPath: "vault:store",
                record: (span) => {
                    recorded.push(span);
                },
                scope,
                shardKey: "shard-1",
                userId: () => undefined,
            },
            () => response,
        );

        const pending = fetch(`https://api.example.test/keys/${SECRET}`);

        scope.clear();
        respond();
        await pending;

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
    it("scrubs a call that fails after the invocation settled", async () => {
        expect.assertions(2);

        const scope = createSensitiveScope([SECRET]);
        const recorded: SpanEvent[] = [];
        let fail!: (error: Error) => void;
        const database = {
            insert: vi.fn<(table: string, document: Record<string, unknown>) => Promise<never>>(
                () =>
                    new Promise<never>((_resolve, reject) => {
                        fail = reject;
                    }),
            ),
        };
        const instrumented = instrumentDatabase(database, {
            anchor,
            captureRaw: false,
            functionPath: "vault:store",
            mode: "spans",
            record: (span) => {
                recorded.push(span);
            },
            scope,
            shardKey: "shard-1",
            tally: createDatabaseTally(),
            userId: () => undefined,
        });

        const pending = instrumented.insert("keys", { value: SECRET });

        scope.clear();
        fail(new Error(`duplicate key (email)=(${SECRET}) already exists`));

        await expect(pending).rejects.toThrow(SECRET);
        expect(JSON.stringify(recorded)).not.toContain(SECRET);
    });

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
