/**
 * Microbenchmark: interpreted `parseValidatorMap` vs the AOT-compiled fast path,
 * across representative function-args shapes. Run with `vitest bench`.
 *
 * Both paths are exercised on VALID input (the fast path's whole point — invalid
 * input defers to the interpreted parser either way), so the numbers reflect the
 * steady-state dispatch cost a real query/mutation pays on every call.
 */
import { parseValidatorMap, v } from "@lunora/values";
import { Node, Project } from "ts-morph";
import { bench, describe } from "vitest";

import compileArgsValidator from "../src/compile-validator";
import { parseObjectShape } from "../src/parse-validator";

const DEFER = Symbol("bench.defer");

/** Parse an args snippet into IR, evaluate the live validators, and compile the fast path. */
const build = (snippet: string): { compiled: (source: Record<string, unknown>) => unknown; live: Record<string, ReturnType<typeof v.string>> } => {
    const project = new Project({ useInMemoryFileSystem: true });
    const initializer = project.createSourceFile("s.ts", `const a = ${snippet};`).getVariableDeclarationOrThrow("a").getInitializerOrThrow();

    if (!Node.isObjectLiteralExpression(initializer)) {
        throw new Error("snippet must be an object literal");
    }

    const source = compileArgsValidator(parseObjectShape(initializer));

    if (source === undefined) {
        throw new Error(`snippet did not compile: ${snippet}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- bench-only: instantiating emitted source in Node; the Worker bundles it statically (no runtime eval)
    const compiled = new Function("DEFER", `return (${source});`)(DEFER) as (source: Record<string, unknown>) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- bench-only: evaluating a trusted literal snippet to obtain the runtime validators
    const live = new Function("v", `return (${snippet});`)(v) as Record<string, ReturnType<typeof v.string>>;

    return { compiled, live };
};

const CASES: ReadonlyArray<{ input: Record<string, unknown>; name: string; snippet: string }> = [
    {
        input: { channelId: "c_1", limit: 50 },
        name: "scalar args (id + optional number)",
        snippet: "{ channelId: v.id('channels'), limit: v.optional(v.number()) }",
    },
    {
        input: { author: "ada", body: "hello world", tags: ["a", "b", "c"], title: "t" },
        name: "object with array",
        snippet: "{ title: v.string(), body: v.string(), author: v.string(), tags: v.array(v.string()) }",
    },
    {
        input: {
            items: Array.from({ length: 20 }, (_unused, index) => {
                return { price: index, sku: `s${String(index)}` };
            }),
        },
        name: "array of objects (n=20)",
        snippet: "{ items: v.array(v.object({ sku: v.string(), price: v.number() })) }",
    },
];

for (const testCase of CASES) {
    const { compiled, live } = build(testCase.snippet);

    describe(testCase.name, () => {
        bench("interpreted (parseValidatorMap)", () => {
            parseValidatorMap(live, testCase.input, "args");
        });

        bench("compiled (AOT fast path)", () => {
            compiled(testCase.input);
        });
    });
}
