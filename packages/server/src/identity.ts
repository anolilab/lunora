/**
 * Identity contract authoring API — a **declared**, validated, typed claim
 * contract for `ctx.auth.identity`.
 *
 * Identity in Lunora is not coupled to any one auth scheme: the runtime seam is
 * `resolveIdentity(request, env)`, and whatever it returns becomes `ctx.auth`.
 * Beyond `userId`, those claims are otherwise an untyped bag, so every RLS
 * predicate and authorize hook reads custom claims (`tenantId`, `scopes`,
 * `kind`, …) through unchecked casts.
 *
 * `defineIdentity({ ... })` declares the claim contract once — the single source
 * of truth for the app's identity claim **type** *and* a **runtime validator** at
 * the trust boundary (the worker validates a resolver's returned claims against
 * the contract before they become `ctx.auth`). The `__lunoraIdentity` brand lets
 * `@lunora/codegen` discover the declaration statically (like
 * `defineSchema`/`defineShape`), and that emission is now wired end-to-end: the
 * generated `_generated/server.ts` auto-narrows `ctx.auth.getIdentity()`, the RLS
 * policy `ctx.auth.identity`, and the `authorizeShard`/`authorizeFanOut` identity
 * to the declared shape (recovered by the `InferIdentity` helper over the
 * contract's `typeof`), and `_generated/app.ts`
 * imports the contract as a value and wires it onto the worker's `options.identity`
 * so the runtime validation actually fires. You can still bind the type by hand
 * with the `InferIdentity` helper (e.g. as the identity type parameter of a
 * hand-written `createPolicyDsl`), but with codegen it happens for you.
 *
 * The contract is built on `@lunora/values` validators — the same codec/
 * validation machinery every `v.*` arg map uses — rather than the replication
 * `defineShape` API (which describes a table+predicate, not a claim record).
 *
 * The claim map must declare a required string `userId`; the inferred type is
 * constrained to extend `{ userId: string }`, so an app that forgets it fails to
 * typecheck. Every other claim should be `v.optional(...)` unless the boundary
 * validation truly guarantees it — a required-but-absent claim read inside an
 * RLS predicate is a runtime footgun the validation is here to close.
 *
 * Declare exactly one `defineIdentity(...)` co-located with the app config
 * (alongside `defineSchema` / `.auth()`). Zero declarations keeps the identity
 * an untyped bag — fully backward compatible.
 */

import type { InferValidatorMap, ValidatorMap } from "@lunora/values";
import { parseValidatorMap, ValidationError } from "@lunora/values";

/**
 * Validator kinds whose inferred type is concretely NOT a string — a `userId`
 * declared with any of these violates the `{ userId: string }` contract. Denied
 * (rather than allow-listing "string") so every string-typed kind — `string`,
 * `storage`, branded `id`, and string `literal`/`union` — still passes.
 * `optional` is included because a required claim cannot be absent.
 */
const NON_STRING_USER_ID_KINDS = new Set<string>([
    "array",
    "bigint",
    "boolean",
    "bytes",
    "date",
    "null",
    "number",
    "object",
    "optional",
    "record",
    "timestamp",
]);

/**
 * What the worker does with a resolver's identity when it fails contract
 * validation (a forged / malformed claim set arriving from an untrusted token).
 * `"anonymous"` (default, safe) treats the request as anonymous, so the bad
 * identity never reaches a policy as a valid identity (`ctx.auth.userId`
 * becomes `undefined`). `"reject"` fails the request closed (a `401`) — use
 * when a malformed credential should be a hard error, not a silent downgrade.
 */
export type IdentityRejectMode = "anonymous" | "reject";

/** Options for {@link defineIdentity}. */
export interface DefineIdentityOptions {
    /**
     * How to handle a resolver identity that violates the contract at the trust
     * boundary. Defaults to `"anonymous"` (a forged claim set is downgraded to
     * anonymous rather than flowing in as an unchecked cast).
     */
    readonly onInvalid?: IdentityRejectMode;
}

/** Result of validating a candidate identity against the contract. */
export type IdentityValidation = { ok: true } | { error: string; ok: false };

/**
 * A declared identity claim contract. Carries the codegen discovery brand, the
 * declared claim validators, the reject policy, and a runtime `validate`. The
 * `TClaims` type parameter is the inferred claim shape (always extending
 * `{ userId: string }`); it is phantom (no runtime field) and exists so
 * `@lunora/codegen` and {@link InferIdentity} can recover the type.
 */
export interface IdentityContract<TClaims extends { userId: string } = { userId: string }> {
    /**
     * Phantom carrier for the inferred claim type. Never populated at runtime
     * (`undefined`); present only so the type flows to codegen / {@link InferIdentity}.
     */
    readonly __claimType?: TClaims;

    readonly __lunoraIdentity: true;

    /** The declared claim validators (a `@lunora/values` validator map). */
    readonly claims: ValidatorMap;

    /** Reject policy applied at the trust boundary. See {@link IdentityRejectMode}. */
    readonly onInvalid: IdentityRejectMode;

    /**
     * Validate a resolver's returned identity against the declared claims. On
     * success the caller keeps the original identity untouched (so undeclared
     * claims are forwarded verbatim, preserving today's behaviour); on failure
     * the worker applies the `onInvalid` policy.
     */
    validate: (identity: Record<string, unknown>) => IdentityValidation;
}

/** Recover the declared claim type from a {@link defineIdentity} contract. */
export type InferIdentity<T> = T extends IdentityContract<infer TClaims> ? TClaims : never;

/**
 * Declare the identity claim contract. `claims` is a `@lunora/values` validator
 * map whose inferred type must extend `{ userId: string }` — if it does not
 * (e.g. `userId` is missing or not a required string), the argument type
 * collapses to `never` and the call fails to typecheck.
 * @example
 * export const identity = defineIdentity({ userId: v.string(), tenantId: v.optional(v.string()), scopes: v.optional(v.array(v.string())) });
 */
export const defineIdentity = <A extends ValidatorMap>(
    claims: InferValidatorMap<A> extends { userId: string } ? A : never,
    options: DefineIdentityOptions = {},
): IdentityContract<InferValidatorMap<A> & { userId: string }> => {
    const map = claims as A;

    // The compile-time guard (`InferValidatorMap<A> extends { userId: string }`) already
    // rejects a missing / optional / non-string `userId`, but harden the runtime too: a
    // caller who casts past the type (or builds the map dynamically) must still declare a
    // required string — reject any concretely non-string validator kind (see
    // {@link NON_STRING_USER_ID_KINDS}).
    const userIdValidator = map["userId"];

    if (userIdValidator === undefined || NON_STRING_USER_ID_KINDS.has(userIdValidator.kind)) {
        throw new Error("defineIdentity: the claim map must declare a required string `userId` validator (e.g. `v.string()` or `v.id(...)`)");
    }

    const onInvalid: IdentityRejectMode = options.onInvalid ?? "anonymous";

    // Validation is an allow-list over the *declared* claims: each declared validator must
    // pass, but undeclared claims are passed through untouched (parseValidatorMap only
    // iterates the map). So `ctx.auth.identity` is narrowed and validated for declared
    // fields, but bracket-access consumers reading an undeclared claim
    // (`identity["x"]`, `authorizeShard`) should treat those as still-untrusted.
    const validate = (identity: Record<string, unknown>): IdentityValidation => {
        try {
            parseValidatorMap(map, identity, "identity");

            return { ok: true };
        } catch (error: unknown) {
            return { error: error instanceof ValidationError ? error.message : String(error), ok: false };
        }
    };

    return { __lunoraIdentity: true, claims: map, onInvalid, validate };
};
