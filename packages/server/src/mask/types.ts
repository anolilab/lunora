/**
 * Public types for Dynamic Data Masking — the column-level analogue of
 * Row-Level Security (`../rls`). Where RLS decides *which rows* a caller sees,
 * masking decides *which column values* are returned in the clear.
 *
 * A mask policy is a pure declaration: per table, a map of column → strategy.
 * The middleware (`mask(policies)`) installs into a builder via `.use()`, so —
 * exactly like `rls()` — masking is opt-in per procedure, never global. A
 * procedure without `.use(mask(...))` sees the unwrapped `ctx.db` and returns
 * raw values.
 *
 * Masking transforms values on the **read/return path only**; it never changes
 * what is stored. It rewrites the *top-level* rows of the table being read —
 * rows hydrated as a `with` relation are NOT masked (the same boundary RLS has);
 * mask such a relation at its own read site if it can surface PII.
 */
import type { Permission, Role } from "../rls/types";

/**
 * Context handed to a {@link MaskFn} (and to {@link MaskOptions.bypass}). The
 * `auth` shape mirrors RLS's `PolicyContext.auth` one-for-one — same identity
 * resolver, same `can(...)` permission check — so an author can branch a mask
 * on the caller's role/permission. `row` is the full pre-mask row the column
 * belongs to; `column` is the column currently being masked. Both are absent
 * when the context is used for the procedure-wide `bypass` check (no specific
 * cell is in play yet).
 */
export interface MaskContext<Context = unknown> {
    readonly auth: {
        /** `true` when any of the request's `roles` grants `permission` (see {@link MaskOptions.roles}). Fails closed for unregistered roles. */
        readonly can: (permission: Permission | string) => boolean;
        readonly identity?: Record<string, unknown> | null;
        readonly roles: ReadonlyArray<string>;
        readonly userId: null | string;
    };
    /** The column currently being masked. Present only inside a per-cell {@link MaskFn}. */
    readonly column?: string;
    readonly ctx: Context;
    /** The full pre-mask row the masked cell belongs to. Present only inside a per-cell {@link MaskFn}. */
    readonly row?: Record<string, unknown>;
}

/**
 * A custom masking function. Receives the raw cell value and the
 * {@link MaskContext}, returns the value to surface. Use it for partial masks
 * (`maskMiddle(phone)`), role-aware reveals (`ctx.auth.can(...) ? value : null`),
 * or format-preserving tokens. A function that **throws** fails closed — the
 * cell is redacted to `null`, never leaked raw.
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- `MaskFn` is the public API name (mirrors the ecosystem's `*Fn` convention); renaming churns the exported surface
export type MaskFn<Context = unknown> = (value: unknown, context: MaskContext<Context>) => unknown;

/**
 * How a column is masked:
 *
 * - `"redact"` — drop the value to `null`. The simplest, safest strategy.
 * - `"hash"` — replace with a stable, non-reversible token (FNV-1a hex) so the
 * same input always yields the same token (joinable/groupable client-side)
 * without revealing the value. **Not** a cryptographic hash — it's a masking
 * token, not a security primitive.
 * - a {@link MaskFn} — author-defined transform (partial mask, role-aware reveal).
 */
export type MaskStrategy<Context = unknown> = "hash" | "redact" | MaskFn<Context>;

/** Per-column strategy map for one table: `{ email: "redact", phone: maskMiddle }`. */
export type MaskColumns<Context = unknown> = Record<string, MaskStrategy<Context>>;

/**
 * The mask declaration passed to `mask(...)`: a table → column → strategy map.
 * Deliberately a plain object literal so the codegen feeder can statically read
 * which columns a procedure masks (powering the `mask_uncovered_pii_column`
 * advisor lint), exactly as the RLS feeder reads policy tables.
 */
export type MaskPolicies<Context = unknown> = Record<string, MaskColumns<Context>>;

/**
 * Options for `mask(policies, options)`.
 *
 * - `roles` registers the role→permission grants that back `ctx.auth.can(...)`
 * inside a {@link MaskFn} — identical to `rls(policies, { roles })`. A role
 * not listed grants no permissions (fails closed for unknown roles).
 * - `bypass` is a procedure-wide escape hatch: when it returns `true` the whole
 * mask is skipped (the caller sees raw values). Use it for a privileged
 * viewer — `bypass: ({ auth }) => auth.can("pii:view")`. Prefer this over
 * branching every column when an entire class of caller should see clear data.
 */
export interface MaskOptions<Context = unknown> {
    readonly bypass?: (context: MaskContext<Context>) => boolean;
    readonly roles?: ReadonlyArray<Role>;
}

export type { Permission, Role } from "../rls/types";
