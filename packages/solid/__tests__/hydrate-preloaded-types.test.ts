import type { Accessor } from "solid-js";
import { describe, expectTypeOf, it } from "vitest";

import type hydratePreloaded from "../src/hydrate-preloaded";

type Post = { title: string };

/**
 * After a sign-out or user switch the preloaded value is dropped and the
 * accessor returns `undefined` until the new identity's subscription answers,
 * so the type must force a guard before a field read.
 */
describe("hydratePreloaded types", () => {
    it("types the accessor as possibly undefined, like createQuery", () => {
        expectTypeOf<ReturnType<typeof hydratePreloaded<Post>>>().toEqualTypeOf<Accessor<Post | undefined>>();
    });

    it("rejects an unguarded field read", () => {
        // @ts-expect-error -- the value is `undefined` after an identity switch; guard first
        const read = (post: ReturnType<typeof hydratePreloaded<Post>>): string => post().title;

        expectTypeOf(read).toBeFunction();
    });
});
