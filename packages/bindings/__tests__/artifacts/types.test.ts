import { describe, expect, expectTypeOf, it } from "vitest";

import type { ArtifactsBindingLike, ArtifactsRepoLike } from "../../src/artifacts";

/**
 * `@lunora/bindings/artifacts` mirrors Cloudflare's Artifacts binding
 * structurally instead of aliasing `@cloudflare/workers-types`. These pin that
 * the real binding (ambient here via the package tsconfig's `types`) still
 * satisfies the mirror, so a workers-types change that drifts from it fails
 * `lint:types` in this package rather than at a consumer's `ctx.artifacts`.
 * Compile-time only: `expectTypeOf` asserts nothing at runtime, hence the
 * `expect.assertions(0)`.
 */
describe("@lunora/bindings/artifacts types", () => {
    it("accepts the real artifacts binding as ArtifactsBindingLike", () => {
        expect.assertions(0);

        expectTypeOf<Artifacts>().toExtend<ArtifactsBindingLike>();
    });

    it("accepts the real repo handle as ArtifactsRepoLike", () => {
        expect.assertions(0);

        expectTypeOf<ArtifactsRepo>().toExtend<ArtifactsRepoLike>();
        expectTypeOf<ReturnType<ArtifactsBindingLike["get"]>>().toEqualTypeOf<Promise<ArtifactsRepoLike>>();
    });
});
