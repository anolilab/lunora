import type { RsbuildPluginAPI } from "@rsbuild/core";
import type { Compilation, Compiler } from "@rspack/core";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { CompilationLike, CompilerLike } from "../src/compiler";
import type { RsbuildApiLike } from "../src/rsbuild";

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

    /**
     * The Rsbuild projection cannot be asserted with `toExtend` the way the Rspack
     * one is. Making it a true structural subset would mean restating
     * `ProxyConfig`, `Plugins` and friends — i.e. reproducing `@rsbuild/core`'s
     * types in a package that declares it an OPTIONAL peer precisely so they never
     * reach the published `.d.ts`.
     *
     * What CAN drift silently is a renamed hook: `RsbuildPlugins` is built on
     * `LooseRsbuildPlugin`, whose `setup: (api: any) => …` swallows any mismatch,
     * so a rename upstream would compile clean here and simply never fire. These
     * pin the six names this plugin taps.
     *
     * The shapes themselves are covered behaviourally instead — `proxy.test.ts`
     * drives a real `createRsbuild()` dev server and reads what comes back, which
     * is what caught the array-form `server.proxy` bug a shape assertion missed.
     */
    it("taps hooks that @rsbuild/core actually has", () => {
        expect.assertions(0);

        expectTypeOf<RsbuildPluginAPI>().toHaveProperty("getRsbuildConfig");
        expectTypeOf<RsbuildPluginAPI>().toHaveProperty("modifyRsbuildConfig");
        expectTypeOf<RsbuildPluginAPI>().toHaveProperty("modifyRspackConfig");
        expectTypeOf<RsbuildPluginAPI>().toHaveProperty("onAfterStartDevServer");
        expectTypeOf<RsbuildPluginAPI>().toHaveProperty("onBeforeStartDevServer");
        expectTypeOf<RsbuildPluginAPI>().toHaveProperty("onCloseDevServer");
    });

    it("declares exactly the hooks it taps, and no more", () => {
        expect.assertions(1);

        // A member added here without a corresponding `toHaveProperty` above would
        // be unpinned — this keeps the two lists in step.
        expectTypeOf<keyof RsbuildApiLike>().toEqualTypeOf<
            "getRsbuildConfig" | "modifyRsbuildConfig" | "modifyRspackConfig" | "onAfterStartDevServer" | "onBeforeStartDevServer" | "onCloseDevServer"
        >();

        expect(true).toBe(true);
    });
});
