import { describe, expect, expectTypeOf, it } from "vitest";

import type { AiSearch, AiSearchInstance } from "../../src/ai-search";

/**
 * `@lunora/bindings/ai-search` mirrors Cloudflare's AI Search binding
 * structurally instead of aliasing `@cloudflare/workers-types`. These pin that
 * the real binding classes (ambient here via the package tsconfig's `types`)
 * still satisfy the mirror, so a workers-types change that drifts from it fails
 * `lint:types` in this package rather than at a consumer's `ctx.aiSearch`.
 * Compile-time only: `expectTypeOf` asserts nothing at runtime, hence the
 * `expect.assertions(0)`.
 */
describe("@lunora/bindings/ai-search types", () => {
    it("accepts the real ai_search_namespaces binding as AiSearch", () => {
        expect.assertions(0);

        expectTypeOf<AiSearchNamespace>().toExtend<AiSearch>();
    });

    it("accepts the real instance (also the single-instance ai_search binding) as AiSearchInstance", () => {
        expect.assertions(0);

        expectTypeOf<globalThis.AiSearchInstance>().toExtend<AiSearchInstance>();
        expectTypeOf<ReturnType<AiSearch["get"]>>().toEqualTypeOf<AiSearchInstance>();
    });
});
