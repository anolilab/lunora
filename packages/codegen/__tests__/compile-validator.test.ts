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
import { parseValidatorMap, v } from "@lunora/values";
import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import compileArgsValidator from "../src/compile-validator";
import { parseObjectShape } from "../src/parse-validator";

/** Local DEFER sentinel handed to the compiled closure (decoupled from the `@lunora/values` internals). */
const DEFER = Symbol("test.defer");

/** Parse a `{ ... }` args object-literal snippet into the codegen IR via the production AST path. */
const irFromSnippet = (snippet: string): Record<string, unknown> => {
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile("snippet.ts", `const args = ${snippet};`);
    const initializer = file.getVariableDeclarationOrThrow("args").getInitializerOrThrow();

    if (!Node.isObjectLiteralExpression(initializer)) {
        throw new Error("snippet must be an object literal");
    }

    return parseObjectShape(initializer);
};

/** Build a live `v.*` validators map by evaluating the same snippet with `v` in scope. */
const liveFromSnippet = (snippet: string): Record<string, ReturnType<typeof v.string>> =>
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- test-only: evaluating a trusted literal snippet in Node to mirror the AST path against the runtime validators
    new Function("v", `return (${snippet});`)(v) as Record<string, ReturnType<typeof v.string>>;

/** Compile an args IR into a live fast-path function closing over the test DEFER sentinel, or undefined when not compilable. */
const compiledFromIr = (ir: Record<string, unknown>): ((source: Record<string, unknown>) => unknown) | undefined => {
    const source = compileArgsValidator(ir as never);

    if (source === undefined) {
        return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- test-only: instantiating the emitted source in Node; the Worker bundles it statically (no runtime eval)
    return new Function("DEFER", `return (${source});`)(DEFER) as (source: Record<string, unknown>) => unknown;
};

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
    { tags: [] },
    { tags: ["a", "b"] },
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
        "{ name: v.string(), nested: v.object({ x: v.number() }), tags: v.array(v.number()) }",
    ];

    for (const snippet of SNIPPETS) {
        // eslint-disable-next-line vitest/expect-expect -- assertions live in the shared assertParity() helper (compiled-vs-oracle parity)
        it(`matches the oracle for ${snippet}`, () => {
            assertParity(snippet);
        });
    }
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
});
