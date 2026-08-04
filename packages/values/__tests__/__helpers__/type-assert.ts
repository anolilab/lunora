/**
 * Type-level assertion helpers shared by this package's compile-time tests.
 *
 * Extracted because the third copy arrived: each one dragged its own
 * `no-unnecessary-type-parameters` suppression, so the suppression was spreading
 * with the duplication rather than sitting in the one place the idiom lives.
 *
 * Not a test file — no `.test.ts` suffix, so vitest does not collect it. It is
 * compiled by `tsc --noEmit` through the package tsconfig's `__tests__/**`
 * include, exactly like its consumers.
 */

/** Fails compilation unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/**
 * Exact type equality. The two single-use function type parameters are
 * load-bearing — they force a structural comparison rather than mutual
 * assignability, which is what distinguishes `unknown` from `any`, and a union
 * from one of its members.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** Keys of `T` that may be omitted. */
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/** Keys of `T` that must be supplied. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

export type { Assert, Equal, OptionalKeys, RequiredKeys };
