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
 * what is stored. It rewrites the rows of the table being read AND the rows
 * hydrated for each `with` relation hop, by that hop's own policy, at every
 * nesting depth — the same boundary `rls()` enforces with `relationBaseWhere`.
 * The one exception is a nested `with` across the cross-shard relation hop,
 * which is refused (`MASK_UNSUPPORTED`) because the mask cannot travel there.
 */
import type { Permission, Role } from "../rls/types";
import type { IndexFieldsByTable } from "../schema";

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
        /** Role labels from the identity's `roles` claim (see `PolicyContext.auth.roles`). */
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
 * - `"redact"` — drop the value to `null`. The simplest, safest strategy, and
 * the right choice for any value that must actually be kept secret.
 * - `"hash"` — replace with a stable token (unsalted 32-bit FNV-1a hex) so the
 * same input always yields the same token (joinable/groupable client-side).
 * **This is NOT a confidentiality control.** It is a non-cryptographic,
 * unsalted, deterministic, narrow (~2^32) digest: low-entropy values (emails,
 * phone numbers, SSNs) are brute-force-recoverable by the very caller you are
 * masking from, and identical values always produce identical tokens across
 * rows/columns/tenants (enabling correlation). Use `"hash"` ONLY when you want a
 * stable pseudonym for grouping/joining and leaking the value is acceptable —
 * never to hide sensitive PII. For PII that must stay hidden, use `"redact"`.
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
 * - `bypass` is a procedure-wide escape hatch: when it returns exactly `true` the
 * whole mask is skipped (the caller sees raw values). Use it for a privileged
 * viewer — `bypass: ({ auth }) => auth.can("pii:view")`. Prefer this over
 * branching every column when an entire class of caller should see clear data.
 * The verdict is compared to `true`, never evaluated for truthiness: returning
 * a claim (`auth.identity?.role`) rather than a decision is a DENIAL here, not
 * an unmasked read.
 * - `indexFields` closes the bare-index-scan / rank / geo position oracle (see
 * the `mask/middleware` module docblock's "Residual read-position oracles" section).
 */
export interface MaskOptions<Context = unknown> {
    readonly bypass?: (context: MaskContext<Context>) => boolean;

    /**
     * Per-table, per-KIND index→declared-fields map (regular index `fields`
     * under `index`; rank index `sortBy` ∪ `partitionBy` under `rank`; geo
     * index `field` under `geo`). Supplied to close the bare-index-scan /
     * rank / geo position oracle: a `withIndex(name)` with no range callback,
     * a `rank`/`rankPage`/`rankBefore` read, or a `withGeoIndex` read, over an
     * index whose DECLARED fields (for that read's own kind) intersect a
     * masked column, is rejected. Kept per kind — rather than one flat
     * name→fields map — because the engine resolves `withIndex` /
     * `withGeoIndex` / rank reads in three separate namespaces, so the same
     * index name can legally denote a different index per kind; a flat map
     * would let one kind's fields shadow another's for a colliding name.
     * OPTIONAL and additive — omit it and behaviour is unchanged (the oracle
     * stays open, exactly as before this option existed). Build it with
     * `indexFieldsFromSchema` (exported from `@lunora/server`):
     * `mask(policies, { indexFields: indexFieldsFromSchema(schema) })`.
     */
    readonly indexFields?: IndexFieldsByTable;
    readonly roles?: ReadonlyArray<Role>;
}

export type { Permission, Role } from "../rls/types";
