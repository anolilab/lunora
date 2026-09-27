import type { Signal } from "@angular/core";
import { describe, expectTypeOf, it } from "vitest";

import type { hydratePreloaded } from "../src/hydrate-preloaded";

type Post = { title: string };

/**
 * After a sign-out or user switch the preloaded value is dropped and `data`
 * holds `undefined` until the new identity's subscription answers, so the type
 * must force a guard before a field read.
 */
describe("hydratePreloaded types", () => {
    it("types data as possibly undefined, like liveQuery", () => {
        expectTypeOf<ReturnType<typeof hydratePreloaded<Post>>["data"]>().toEqualTypeOf<Signal<Post | undefined>>();
    });

    it("rejects an unguarded field read", () => {
        // @ts-expect-error -- the value is `undefined` after an identity switch; guard first
        const read = (result: ReturnType<typeof hydratePreloaded<Post>>): string => result.data().title;

        expectTypeOf(read).toBeFunction();
    });
});
