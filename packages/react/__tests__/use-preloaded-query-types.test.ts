import { describe, expect, expectTypeOf, it } from "vitest";

import type usePreloadedQuery from "../src/use-preloaded-query";
import type { hydratePreloaded } from "../src/use-preloaded-query";

type Post = { title: string };

/**
 * After a sign-out or user switch the preloaded value is dropped and the hook
 * returns `undefined` until the new identity's subscription answers, so the
 * type must force a guard before a field read.
 */
describe("usePreloadedQuery types", () => {
    it("types the value as possibly undefined, like useQuery", () => {
        // Type-level only: `expectTypeOf` is checked by `tsc`, not at runtime.
        expect.assertions(0);

        expectTypeOf<ReturnType<typeof usePreloadedQuery<Post>>>().toEqualTypeOf<Post | undefined>();
        expectTypeOf<ReturnType<typeof hydratePreloaded<Post>>>().toEqualTypeOf<Post | undefined>();
    });

    it("rejects an unguarded field read", () => {
        expect.assertions(0);

        // @ts-expect-error -- the value is `undefined` after an identity switch; guard first
        const read = (post: ReturnType<typeof usePreloadedQuery<Post>>): string => post.title;

        expectTypeOf(read).toBeFunction();
    });
});
