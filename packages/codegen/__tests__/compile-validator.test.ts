/**
 * Differential + unit tests for the AOT args-validator compiler.
 *
 * The differential suite is the real safety net: for each `v.*` args snippet it
 * (1) parses the snippet through the production AST→IR path (`parseObjectShape`),
 * (2) evaluates the *same* snippet to live `v.*` validators, then (3) compiles
 * the IR and compares the compiled fast path against the interpreted oracle
 * (`parseValidatorMap`) over a broad input corpus. The invariant under test is
 * the soundness contract: the compiled parser may DEFER freely, but whenever it
 * returns a record the oracle must agree (no throw) and the records must be
 * deep-equal. A compiled "success" the oracle would reject is a hard failure.
 */
import { parseValidatorMap } from "@lunora/values";
import { describe, expect, it } from "vitest";

import compileArgsValidator from "../src/compile-validator";
import { compiledFromIr, DEFER, irFromSnippet, liveFromSnippet } from "./snippet-helpers";

/** A wide input corpus exercising valid, type-mismatched, missing, extra-key, and nested shapes. */
const CORPUS: ReadonlyArray<Record<string, unknown>> = [
    {},
    { name: "ada" },
    { name: 123 },
    { name: "ada", age: 7 },
    { name: "ada", age: "7" },
    { name: "ada", age: Number.NaN },
    { name: "ada", age: Number.POSITIVE_INFINITY },
    { name: "ada", extra: "dropped" },
    { name: null },
    { name: undefined },
    // Over/under a declared length bound: the bounded snippets below are the
    // only reason these are here, and without them their parity check would
    // pass vacuously (every short input is inside every bound).
    { name: "x".repeat(65) },
    { name: "" },
    { tags: [] },
    { tags: ["a", "b"] },
    { tags: ["a", "b", "c", "d"] },
    { tags: ["a", 2] },
    { tags: "nope" },
    { flag: true },
    { flag: "true" },
    { nested: { x: 1, y: "z" } },
    { nested: { x: "1", y: "z" } },
    { nested: null },
    { nested: [] },
    { kind: "a" },
    { kind: "b" },
    { items: [{ id: "x" }, { id: "y" }] },
    { items: [{ id: 1 }] },
    // A declared field carried by the PROTOTYPE, not as an own property: the
    // oracle reads own keys only (`Object.hasOwn`), so `name` must read as
    // absent — a compiled path that sees the inherited value is unsound.
    Object.assign(Object.create({ name: "inherited" }) as Record<string, unknown>, {}),
    // An own property under a prototype-member name must still parse normally.
    { toString: "x" },
    // A null-prototype source: the prototype guard admits it (bare reads are
    // own-only on it), so it must stay on the fast path and agree with the oracle.
    Object.assign(Object.create(null) as Record<string, unknown>, { name: "ada" }),
    // `JSON.parse` puts a wire `"__proto__"` key on as an OWN data property and
    // leaves the prototype plain — the fast path must serve it like any other
    // undeclared key (dropped), not treat the object as exotic.
    JSON.parse('{"name":"ada","__proto__":{"injected":true}}') as Record<string, unknown>,
    [] as unknown as Record<string, unknown>,
    null as unknown as Record<string, unknown>,
];

const assertParity = (snippet: string): void => {
    const compiled = compiledFromIr(irFromSnippet(snippet));

    if (compiled === undefined) {
        // Not compilable — the function keeps the interpreted path; nothing to compare.
        return;
    }

    const live = liveFromSnippet(snippet);

    for (const input of CORPUS) {
        const fast = compiled(input);

        if (fast === DEFER) {
            // Deferral is always safe — the interpreted parser owns the outcome.
            continue;
        }

        // The fast path committed to a success: the oracle must agree and match.
        let oracle: unknown;
        let threw = false;

        try {
            oracle = parseValidatorMap(live, input, "args");
        } catch {
            threw = true;
        }

        expect(threw, `compiled accepted input the oracle rejected for ${snippet}: ${JSON.stringify(input)}`).toBe(false);
        expect(fast, `compiled output diverged from oracle for ${snippet}: ${JSON.stringify(input)}`).toStrictEqual(oracle);
    }
};

describe("compileArgsValidator — differential parity vs interpreted oracle", () => {
    const SNIPPETS = [
        "{ name: v.string() }",
        "{ name: v.string(), age: v.optional(v.number()) }",
        "{ age: v.number() }",
        "{ flag: v.boolean() }",
        "{ tags: v.array(v.string()) }",
        "{ nested: v.object({ x: v.number(), y: v.string() }) }",
        "{ items: v.array(v.object({ id: v.string() })) }",
        "{ kind: v.literal('a') }",
        "{ id: v.id('users') }",
        "{ anything: v.any() }",
        // `v.any()` under a prototype-member name: on a plain `{}` source the
        // own key is absent, so the oracle yields `undefined` — a bare index
        // read would commit the inherited `Object.prototype.toString` instead.
        "{ toString: v.any() }",
        "{ name: v.string(), nested: v.object({ x: v.number() }), tags: v.array(v.number()) }",
        // Length bounds — the one refinement family the compiler reproduces.
        "{ name: v.string().max(64) }",
        "{ name: v.string().min(1).max(64) }",
        "{ name: v.string().length(3) }",
        "{ tags: v.array(v.string()).max(3) }",
        "{ name: v.optional(v.string().max(64)) }",
        // Chains it must still decline: a non-length predicate alongside the
        // bound, and a bound whose argument isn't a literal.
        "{ name: v.string().max(64).email() }",
        "{ age: v.number().min(1).max(64) }",
    ];

    // eslint-disable-next-line vitest/expect-expect, vitest/prefer-expect-assertions -- assertions live in the shared assertParity() helper; some snippets legitimately defer to the interpreted path with zero assertions
    it.each(SNIPPETS)("matches the oracle for %s", (snippet) => {
        assertParity(snippet);
    });
});

describe("compileArgsValidator — modelled behaviour", () => {
    it("drops unknown source keys and rebuilds with declared keys only", () => {
        expect.assertions(1);

        const compiled = compiledFromIr(irFromSnippet("{ name: v.string() }"));

        expect(compiled?.({ name: "ada", extra: "x" })).toStrictEqual({ name: "ada" });
    });

    it("omits an absent optional field rather than setting it undefined", () => {
        expect.assertions(2);

        const compiled = compiledFromIr(irFromSnippet("{ nick: v.optional(v.string()) }"));

        expect(compiled?.({})).toStrictEqual({});
        expect(compiled?.({ nick: "ada" })).toStrictEqual({ nick: "ada" });
    });

    it("keeps a null-prototype source on the fast path, and defers an exotic-prototype one", () => {
        expect.assertions(2);

        const compiled = compiledFromIr(irFromSnippet("{ name: v.string() }"));

        // Bare reads are own-only on a null-prototype object, so the prototype
        // guard admits it — parity alone can't prove this, since DEFER is always
        // parity-safe and would silently cost the fast path instead.
        expect(compiled?.(Object.assign(Object.create(null) as Record<string, unknown>, { name: "ada" }))).toStrictEqual({ name: "ada" });
        // Anything else may carry inherited data properties: hand it to the oracle.
        expect(compiled?.(Object.create({ name: "inherited" }) as Record<string, unknown>)).toBe(DEFER);
    });

    it("defers (returns the sentinel) on a type mismatch instead of throwing", () => {
        expect.assertions(1);

        const compiled = compiledFromIr(irFromSnippet("{ age: v.number() }"));

        expect(compiled?.({ age: "not-a-number" })).toBe(DEFER);
    });

    it("declines to compile unions (returns undefined source)", () => {
        expect.assertions(1);

        expect(compileArgsValidator(irFromSnippet("{ u: v.union(v.string(), v.number()) }") as never)).toBeUndefined();
    });

    it("declines to compile records (returns undefined source)", () => {
        expect.assertions(1);

        expect(compileArgsValidator(irFromSnippet("{ r: v.record(v.string(), v.number()) }") as never)).toBeUndefined();
    });

    it("declines a referenced-validator arg (IR `any` with sourceText) instead of bypassing it", () => {
        expect.assertions(2);

        // `args: { name: sharedV }` lowers to `{ kind: "any", sourceText: "sharedV" }`.
        // The real runtime validator is unknown to codegen, so compiling it as an
        // unconditional pass-through would silently skip validation — must decline.
        expect(compileArgsValidator(irFromSnippet("{ name: sharedV }") as never)).toBeUndefined();
        // Genuine `v.any()` (no sourceText) still compiles to a pass-through.
        expect(compileArgsValidator(irFromSnippet("{ x: v.any() }") as never)).toBeDefined();
    });

    it("declines a `.check(...)` refinement (IR refinements) so the predicate is never skipped", () => {
        expect.assertions(2);

        // `.check(...)` lowers to the base kind + `refinements: ["check"]`; compiling it
        // would silently drop the predicate, so the node must decline. `.meta(...)`
        // has no parse effect and still compiles.
        expect(compileArgsValidator(irFromSnippet("{ name: v.string().check((s) => s.length > 0) }") as never)).toBeUndefined();
        expect(compileArgsValidator(irFromSnippet("{ name: v.string().meta({ schema: { maxLength: 4 } }) }") as never)).toBeDefined();
    });

    it("compiles a `.max(n)` length bound into the fast path and defers anything outside it", () => {
        expect.assertions(5);

        const source = compileArgsValidator(irFromSnippet("{ name: v.string().max(64) }") as never);

        // The bound is emitted, not dropped: a compiled validator that skipped it
        // would accept the 65-char string the interpreted parser rejects.
        expect(source).toContain(".length > 64");

        const compiled = compiledFromIr(irFromSnippet("{ name: v.string().max(64) }"));

        expect(compiled?.({ name: "x".repeat(64) })).toStrictEqual({ name: "x".repeat(64) });
        expect(compiled?.({ name: "x".repeat(65) })).toBe(DEFER);

        // …and deferring is what keeps the error contract exact: the interpreted
        // parser owns the message, so the compiled path can never drift from it.
        expect(() => parseValidatorMap(liveFromSnippet("{ name: v.string().max(64) }"), { name: "x".repeat(65) }, "args")).toThrow(
            "expected string length <= 64",
        );
        expect(parseValidatorMap(liveFromSnippet("{ name: v.string().max(64) }"), { name: "x".repeat(64) }, "args")).toStrictEqual({
            name: "x".repeat(64),
        });
    });

    it("declines a length bound it cannot reproduce exactly", () => {
        expect.assertions(4);

        // A non-length predicate alongside the bound: the chain is all-or-nothing.
        expect(compileArgsValidator(irFromSnippet("{ name: v.string().max(64).email() }") as never)).toBeUndefined();
        // `.min`/`.max` on a NUMBER bound the value, not a `.length` — declined
        // rather than compiled into the wrong comparison.
        expect(compileArgsValidator(irFromSnippet("{ age: v.number().max(64) }") as never)).toBeUndefined();
        // A non-literal bound leaves no `refinementArgs` entry to emit.
        expect(compileArgsValidator(irFromSnippet("{ name: v.string().max(LIMIT) }") as never)).toBeUndefined();
        // A repeated bound: keyed by name, one entry cannot represent both, so
        // the parser records neither and the compiler declines.
        expect(compileArgsValidator(irFromSnippet("{ name: v.string().max(3).max(5) }") as never)).toBeUndefined();
    });

    it("declines a `.check(...)` refinement on an OPTIONAL field so the predicate is never skipped", () => {
        expect.assertions(3);

        // `v.optional(v.string()).check(...)` lowers to an `optional` node carrying
        // `refinements: ["check"]`. The optional field branch must consult the wrapper's
        // own flags (not just `inner`), else it compiles a bare string guard and the
        // hot path accepts input the interpreted parser rejects — a validation bypass.
        expect(compileArgsValidator(irFromSnippet("{ nick: v.optional(v.string()).check((s) => s.length > 0) }") as never)).toBeUndefined();
        expect(compileArgsValidator(irFromSnippet("{ limit: v.optional(v.number()).check((n) => n <= 100) }") as never)).toBeUndefined();
        // A plain optional with no refinement still compiles.
        expect(compileArgsValidator(irFromSnippet("{ nick: v.optional(v.string()) }") as never)).toBeDefined();
    });
});
