/**
 * Microbenchmark: interpreted `parseValidatorMap` vs the AOT-compiled fast path,
 * across representative function-args shapes. Run with `vitest bench`.
 *
 * Both paths are exercised on VALID input (the fast path's whole point — invalid
 * input defers to the interpreted parser either way), so the numbers reflect the
 * steady-state dispatch cost a real query/mutation pays on every call.
 */
import { parseValidatorMap } from "@lunora/values";
import { bench, describe } from "vitest";

import { compiledFromSnippet, liveFromSnippet } from "./snippet-helpers";

/** Parse an args snippet into IR, evaluate the live validators, and compile the fast path (shared with the differential test). */
const build = (snippet: string): { compiled: (source: Record<string, unknown>) => unknown; live: ReturnType<typeof liveFromSnippet> } => {
    const compiled = compiledFromSnippet(snippet);

    if (compiled === undefined) {
        throw new Error(`snippet did not compile: ${snippet}`);
    }

    return { compiled, live: liveFromSnippet(snippet) };
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

// eslint-disable-next-line vitest/prefer-each -- benchmark iteration, not a parametrized test
for (const testCase of CASES) {
    const { compiled, live } = build(testCase.snippet);

    describe(testCase.name, () => {
        // eslint-disable-next-line vitest/prefer-expect-assertions -- benchmark, not a test with assertions
        bench("interpreted (parseValidatorMap)", () => {
            parseValidatorMap(live, testCase.input, "args");
        });

        // eslint-disable-next-line vitest/prefer-expect-assertions -- benchmark, not a test with assertions
        bench("compiled (AOT fast path)", () => {
            compiled(testCase.input);
        });
    });
}
