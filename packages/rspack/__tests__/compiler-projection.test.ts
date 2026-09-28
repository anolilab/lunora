import type { Compilation, Compiler } from "@rspack/core";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { CompilationLike, CompilerLike } from "../src/compiler";

/**
 * The structural projection in `src/compiler.ts` exists so `@rspack/core` never
 * reaches this package's published `.d.ts`. That only works while the projection
 * stays a real subset of what it projects: a hook renamed upstream, or a
 * dependency set that stops exposing `add`, would leave this package compiling
 * happily and failing at the first `rspack build` in a user's project.
 *
 * These are compile-time assertions — they fail `lint:types` and this suite,
 * which run under the same tsconfig, the moment a real compiler stops fitting.
 */
describe("compiler projection", () => {
    it("accepts a real @rspack/core Compiler", () => {
        expect.assertions(0);

        expectTypeOf<Compiler>().toExtend<CompilerLike>();
    });

    it("accepts a real @rspack/core Compilation", () => {
        expect.assertions(0);

        expectTypeOf<Compilation>().toExtend<CompilationLike>();
    });
});
