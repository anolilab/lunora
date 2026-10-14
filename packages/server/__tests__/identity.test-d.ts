import type { InferIdentity } from "../src/index";
import { defineIdentity, v } from "../src/index";

/**
 * Type-level proof that `defineIdentity` yields a claim type extending
 * `{ userId: string }`, that `InferIdentity` recovers it, that optional claims
 * are optional and required claims required, and that reading an undeclared
 * claim fails compilation. The `@ts-expect-error` lines fail the build if the
 * contract's typing regresses.
 */

// Assert a value has an exact type via a parameter position (no `void` operator,
// no unused locals) — the argument fails to typecheck if the type regresses.
const expectString = (_value: string): void => undefined;
const expectOptionalString = (_value: string | undefined): void => undefined;
const expectOptionalStringArray = (_value: string[] | undefined): void => undefined;
const expectNever = (_value: never): void => undefined;

// Everything under test lives inside the function body so the inferred `identity`
// contract and the recovered `Identity` type stay function-local (not part of the
// module's declaration output) — keeping the file `--isolatedDeclarations`-clean
// without hand-writing the inferred contract type.
const check = (): void => {
    const identity = defineIdentity({
        kind: v.optional(v.union(v.literal("user"), v.literal("service"))),
        scopes: v.optional(v.array(v.string())),
        tenantId: v.optional(v.string()),
        userId: v.string(),
    });

    type Identity = InferIdentity<typeof identity>;

    const claims = null as unknown as Identity;

    // Declared claims are readable at their declared types.
    const { scopes, tenantId, userId } = claims;

    expectString(userId);
    expectOptionalString(tenantId);
    expectOptionalStringArray(scopes);

    // Reading an undeclared claim must not typecheck. Passed to a helper (not a
    // bare expression) so the statement has effect; the access itself is the
    // error `@ts-expect-error` expects.
    // @ts-expect-error — `role` is not a declared claim on this identity contract.
    expectNever(claims.role);

    // A claim map without a required string `userId` collapses the argument to
    // `never`, so the call fails to typecheck.
    // @ts-expect-error — the claim map must declare a required string `userId`.
    defineIdentity({ tenantId: v.string() });

    // A `userId` typed as something other than `string` is likewise rejected.
    // @ts-expect-error — `userId` must infer to `string`.
    defineIdentity({ userId: v.number() });
};

export default check;
