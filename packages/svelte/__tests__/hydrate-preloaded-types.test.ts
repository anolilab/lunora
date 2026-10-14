import type { Readable } from "svelte/store";
import { get } from "svelte/store";
import { describe, expectTypeOf, it } from "vitest";

import type { hydratePreloaded } from "../src/hydrate-preloaded";

type Post = { title: string };

/**
 * After a sign-out or user switch the preloaded value is dropped and the store
 * holds `undefined` until the new identity's subscription answers, so the type
 * must force a guard before a field read.
 */
describe("hydratePreloaded types", () => {
    it("types the store as possibly undefined, like query", () => {
        expectTypeOf<ReturnType<typeof hydratePreloaded<Post>>>().toEqualTypeOf<Readable<Post | undefined>>();
    });

    it("rejects an unguarded field read", () => {
        // @ts-expect-error -- the value is `undefined` after an identity switch; guard first
        const read = (posts: ReturnType<typeof hydratePreloaded<Post>>): string => get(posts).title;

        expectTypeOf(read).toBeFunction();
    });
});
