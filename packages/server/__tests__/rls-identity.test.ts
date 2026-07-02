/*
 * createPolicyDsl's optional third type parameter binds the app's identity
 * claim contract (from defineIdentity) into the RLS policy context, so a
 * policy's `when` reads `ctx.auth.identity` at the declared claim type instead
 * of the untyped bag. Today an app binds it by hand with
 * `createPolicyDsl<DataModel, Relations, InferIdentity<typeof identity>>()`; a
 * later codegen phase will emit that binding automatically from a
 * `defineIdentity(...)` declaration.
 *
 * The type-level expectation is asserted with `expectTypeOf` + `@ts-expect-error`
 * so a regression that widens `ctx.auth.identity` fails the type check.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { createPolicyDsl } from "../src/index";

interface DataModel {
    posts: { _id: string; authorId: string; tenantId: string };
}

interface Relations {
    posts: object;
}

/** A declared identity claim contract's inferred type. */
interface Identity {
    tenantId?: string;
    userId: string;
}

const definePolicy = createPolicyDsl<DataModel, Relations, Identity>();

describe("createPolicyDsl — identity-bound policy context", () => {
    it("types ctx.auth.identity to the bound Identity contract", () => {
        expect.assertions(1);

        const policy = definePolicy({
            on: "read",
            table: "posts",
            when: ({ auth }) => {
                expectTypeOf(auth.identity).toEqualTypeOf<Identity | null | undefined>();

                // Reading an undeclared claim off the typed identity must not compile.
                // Wrapped in `expectTypeOf` (a call, not a bare member access) so the
                // statement has effect; the access itself is the error `@ts-expect-error`
                // expects (the errored access resolves to `any`).
                // @ts-expect-error — `role` is not a claim on the bound Identity.
                expectTypeOf(auth.identity?.role).toBeAny();

                return auth.identity?.tenantId === undefined ? false : { tenantId: auth.identity.tenantId };
            },
        });

        expect(policy.table).toBe("posts");
    });

    it("still defaults to the untyped claim bag when no Identity is bound", () => {
        expect.assertions(1);

        const untyped = createPolicyDsl<DataModel, Relations>();
        const policy = untyped({
            on: "read",
            table: "posts",
            when: ({ auth }) => {
                // Default identity is the open Record — any claim key is readable.
                expectTypeOf(auth.identity).toEqualTypeOf<Record<string, unknown> | null | undefined>();

                return auth.identity?.["anything"] !== undefined;
            },
        });

        expect(policy.on).toBe("read");
    });
});
