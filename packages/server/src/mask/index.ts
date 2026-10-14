/**
 * Public surface for Dynamic Data Masking — the column-level sibling of
 * Row-Level Security (`../rls`). RLS decides *which rows* a caller sees; masking
 * decides *which column values* are returned in the clear.
 *
 * ```ts
 * import { mask } from "@lunora/server";
 *
 * export const listUsers = query(...)
 *     .use(mask({
 *         users: {
 *             email: "redact",                                    // → null for non-privileged callers
 *             phone: (value, { auth }) => (auth.can("pii:view") ? value : "hash"),
 *         },
 *     }))
 *     .handler(...);
 * ```
 *
 * Opt-in scope is the load-bearing invariant: masking applies only to procedures
 * whose builder chain includes `.use(mask(...))`. A bare `query` (and every
 * internal procedure) sees an unwrapped `ctx.db` and returns raw values. Masking
 * runs on the read/return path only — the stored row is never touched.
 *
 * Masking rewrites the *top-level* rows of the table being read. Rows pulled in
 * as a relation via `with` are hydrated below the `ctx.db` facade and are NOT
 * masked — `posts.findMany({ with: { author: true } })` returns each `author`
 * in the clear even if `users` is masked (the same boundary RLS has). Mask a
 * relation at its own read site if it can surface PII.
 *
 * `aggregate()` / `groupBy()` over a masked column throw a `LunoraError` with
 * code `MASK_UNSUPPORTED` (422): a group key *is* the raw value and an aggregate
 * is computed *from* it, so neither can be served without leaking what the mask
 * hides. The reduction fails closed, mirroring `COUNT_RLS_UNSUPPORTED`.
 *
 * Role-aware masks reuse the same permission machinery as RLS: register the
 * role→permission grants via `mask(policies, { roles })`, then branch a `MaskFn`
 * on `ctx.auth.can(...)`. A privileged class of caller can skip the whole mask
 * via `mask(policies, { bypass: ({ auth }) => auth.can("pii:view") })`.
 *
 * **Shapes (local-first replication) are refused over a masked table.** The
 * `defineShape` sync path runs no procedure, so `.use(mask(...))` never
 * executes for it — a shape would otherwise replicate a masked column's raw
 * value to every subscribed client. Rather than leak it, `@lunora/codegen`
 * fails the build (`MASK_UNSUPPORTED`) when a `defineShape` targets a table
 * any registered function masks a column on. This is Phase 1 (fail closed);
 * masking a shape's replicated rows is Phase 2, not yet built. Until then,
 * remove the shape, unmask the column(s), or wait for shape-masking support.
 */
export { mask } from "./middleware";
export type { MaskRegistry } from "./policy-tag";
export { buildMaskRegistry } from "./policy-tag";
export type { MaskColumns, MaskContext, MaskFn, MaskOptions, MaskPolicies, MaskStrategy } from "./types";
