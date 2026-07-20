/**
 * Shared harness for the AOT args-validator test and benchmark: parse a `v.*`
 * args snippet through the production AST→IR path, evaluate the same snippet to
 * live validators, and instantiate the compiled fast path. Kept in one place so
 * the differential test and the benchmark exercise byte-for-byte the same
 * construction (a drift between them would silently undermine the bench's claim
 * to measure what the test verifies).
 *
 * Not a `*.test.ts` file, so vitest does not collect it as a suite.
 */
import { v } from "@lunora/values";
import { Node, Project } from "ts-morph";

import compileArgsValidator from "../src/compile-validator";
import { parseObjectShape } from "../src/parse-validator";

/** Shared DEFER sentinel the compiled closures defer with. */
const DEFER: symbol = Symbol("snippet.defer");

/** Parse a `{ ... }` args object-literal snippet into the codegen IR via the production AST path. */
const irFromSnippet = (snippet: string): Record<string, unknown> => {
    const file = new Project({ useInMemoryFileSystem: true }).createSourceFile("snippet.ts", `const args = ${snippet};`);
    const initializer = file.getVariableDeclarationOrThrow("args").getInitializerOrThrow();

    if (!Node.isObjectLiteralExpression(initializer)) {
        throw new Error("snippet must be an object literal");
    }

    return parseObjectShape(initializer);
};

/** Build a live `v.*` validators map by evaluating the same snippet with `v` in scope. */
const liveFromSnippet = (snippet: string): Record<string, ReturnType<typeof v.string>> =>
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- test/bench-only: evaluating a trusted literal snippet in Node to mirror the AST path against the runtime validators
    new Function("v", `return (${snippet});`)(v) as Record<string, ReturnType<typeof v.string>>;

/** Compile an args IR into a live fast-path function closing over the shared DEFER sentinel, or undefined when not compilable. */
const compiledFromIr = (ir: Record<string, unknown>): ((source: Record<string, unknown>) => unknown) | undefined => {
    const source = compileArgsValidator(ir as never);

    if (source === undefined) {
        return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- test/bench-only: instantiating the emitted source in Node; the Worker bundles it statically (no runtime eval)
    return new Function("DEFER", `return (${source});`)(DEFER) as (source: Record<string, unknown>) => unknown;
};

/** Convenience: compile a snippet's args straight to a live fast-path function (or undefined). */
const compiledFromSnippet = (snippet: string): ((source: Record<string, unknown>) => unknown) | undefined => compiledFromIr(irFromSnippet(snippet));

export { compiledFromIr, compiledFromSnippet, DEFER, irFromSnippet, liveFromSnippet };
