/**
 * Declared security and access policy: RLS, masking, storage rules, and ratelimit key selectors.
 */
import type { CallSiteScope } from "./call-sites";

/**
 * Per-procedure RLS usage snapshot, produced by `discoverRlsProcedures` for the
 * `rls_uncovered_table` advisor lint. Structurally identical to
 * `AdvisorRlsProcedure` (they share the same field set) so values pass straight
 * through to the advisor without conversion, exactly as `AuthApiCallIR` does for
 * `AdvisorAuthApiCall`.
 */
export interface RlsProcedureIR {
    /** Export binding name of the procedure (e.g. `listDocuments`). */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;

    /**
     * Table names extracted from the `rls(policies)` array literal. Empty when the
     * policies argument is not a statically-readable array literal.
     */
    rlsTables: string[];
    /** Tables read by the procedure via `ctx.db.query/findMany/findFirst/…`. */
    tablesRead: string[];
    /** Tables written by the procedure via `ctx.db.insert/patch/replace/delete`. */
    tablesWritten: string[];
    /** `true` when the procedure's builder chain includes `.use(rls(...))`. */
    usesRls: boolean;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}

/**
 * One procedure reduced to the facts the `mask_uncovered_pii_column` lint needs:
 * whether its builder chain includes `.use(mask(...))`, which `(table, column)`
 * pairs that mask declares, and which tables the procedure reads/writes. The
 * column-level analogue of {@link RlsProcedureIR}. Structurally identical to
 * `AdvisorMaskProcedure` so values pass straight through without conversion.
 */
export interface MaskProcedureIR {
    /** Export binding name of the procedure (e.g. `listUsers`). */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;

    /**
     * `(table, column)` pairs this procedure's `mask(policies)` object literal
     * declares. Empty when the policies argument is not a statically-readable
     * object literal (conservative: `usesMask` is still `true`).
     */
    maskColumns: { column: string; table: string }[];
    /** Tables read by the procedure via `ctx.db.query/findMany/findFirst/get`. */
    tablesRead: string[];
    /** Tables written by the procedure via `ctx.db.insert/patch/replace/delete`. */
    tablesWritten: string[];
    /** `true` when the procedure's builder chain includes `.use(mask(...))`. */
    usesMask: boolean;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}

/**
 * One masked column surfaced to the studio's data-browser mask preview: a
 * `(table, column)` pair plus the declared {@link MaskProcedureIR} strategy so
 * the preview can pick redact-vs-hash-vs-custom rendering. Aggregated across the
 * project's `.use(mask(...))` chains by `discoverMaskMetadata`; the descriptive
 * twin of {@link RlsPolicyIR}. `"custom"` covers any non-string strategy (a
 * `(value, ctx) => …` function) — its logic is an opaque closure, never read by
 * the UI; the preview renders a fixed sentinel for it.
 */
export interface MaskColumnMetadataIR {
    /** Column the mask policy redacts. */
    column: string;
    /** Declared masking strategy: `"redact"`/`"hash"` string literals, else `"custom"` for a `MaskFn`. */
    strategy: "custom" | "hash" | "redact";
    /** Logical table the masked column belongs to. */
    table: string;
}

/**
 * Schema-wide masking metadata the codegen emits into the generated ShardDO so
 * the studio's data-browser mask toggle can preview what a non-privileged caller
 * would see. Aggregated across every `.use(mask(...))` chain in the project —
 * purely descriptive (table + column + strategy), never the masking closure. The
 * column-level analogue of {@link RlsMetadataIR}.
 */
export interface MaskMetadataIR {
    /** Every statically-discovered masked column, deduped by `(table, column)` (first declaration wins). */
    columns: MaskColumnMetadataIR[];
}

/**
 * One masked column whose `mask(policies)` strategy is a statically-known
 * literal (`"hash"` or `"redact"`) — the `mask_weak_hash_strategy_on_pii` lint
 * input. Unlike {@link MaskColumnMetadataIR} (app-wide, deduped by `(table,
 * column)`, studio-preview evidence), this is per declaration site (file + line
 * + enclosing export), undeduped, so the lint can point at the exact
 * `mask(...)` call that applies a weak strategy. A `MaskFn` (custom, non-literal)
 * strategy carries no lint-relevant signal and is never recorded here.
 * Structurally identical to `AdvisorMaskStrategy`.
 */
export interface MaskStrategyIR {
    /** Masked column name. */
    column: string;
    /** Export binding name of the procedure whose `.use(mask(...))` chain declared this column, or `"<module>"` when declared at file scope. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the masked column's strategy property. */
    line: number;
    /** The statically-known strategy literal: `"hash"` or `"redact"`. */
    strategy: string;
    /** Logical table the masked column belongs to. */
    table: string;
}

/**
 * One statically-readable policy entry from an `rls([...])` array literal,
 * surfaced to the studio's read-only RLS inspector via the generated
 * `rlsPolicies()` hook. Captures the policy's `table` + `on` operation and the
 * procedure it guards — never the `when` predicate, which is an opaque JS
 * closure (its logic stays in code, not the UI). Produced by
 * `discoverRlsProcedures` alongside the lint IR.
 */
export interface RlsPolicyIR {
    /** Source file (relative to `lunora/`, without extension) the policy is declared in. */
    file: string;
    /** Operation the policy gates: `read` covers get/query/findMany, the rest are writes. */
    on: "delete" | "insert" | "read" | "update";
    /** Export name of the procedure whose `.use(rls(...))` chain declared this policy. */
    procedure: string;
    /** Logical table the policy applies to. Empty when not a string literal. */
    table: string;
}

/**
 * One statically-readable role entry from an `rls(policies, { roles: [...] })`
 * call, surfaced to the studio's RLS inspector. Captures the role's `name`,
 * optional `description`, and the names of the permissions it grants (string
 * literals or `definePermission("name")` calls). Produced by
 * `discoverRlsProcedures`.
 */
export interface RlsRoleIR {
    /** Optional human-readable description from `defineRole(name, { description })`. */
    description?: string;
    /** Role label attached to the request identity (e.g. `"admin"`). */
    name: string;
    /** Permission names this role grants, deduped and in declared order. */
    permissions: string[];
}

/**
 * Schema-wide RLS metadata the codegen emits into the generated ShardDO so the
 * studio's read-only inspector can list, per table, which policies guard it and
 * what roles are defined. Aggregated across every `.use(rls(...))` chain in the
 * project — purely descriptive, never the predicate logic.
 */
export interface RlsMetadataIR {
    /** Every statically-discovered policy `(table, on, procedure)` entry. */
    policies: RlsPolicyIR[];
    /** Every statically-discovered role, deduped by name (first declaration wins). */
    roles: RlsRoleIR[];
}

/** One statically-discovered `defineStorageRule({ bucket, on, prefix })` entry from a `.use(storageRules(...))` chain. */
export interface StorageRuleIR {
    bucket: string;
    /** Relative to `lunora/`. */
    file: string;
    on: "delete" | "list" | "read" | "write";
    /** Optional key-prefix scope; absent ⇒ the whole bucket. */
    prefix?: string;
    /** The exported procedure that installed the rule. */
    procedure: string;
}

/**
 * Schema-wide storage-access-rule metadata emitted into the generated ShardDO so
 * the studio's read-only inspector can list, per bucket, which operations are
 * gated and under what key prefix. Aggregated across every
 * `.use(storageRules(...))` chain — descriptive only, never the predicate logic.
 */
export interface StorageRulesMetadataIR {
    rules: StorageRuleIR[];
}

/**
 * One `rateLimit`/`dbRateLimit` middleware call (`@lunora/ratelimit`) whose
 * `key` selector — the per-caller rate-limit sub-key, `(ctx) => string |
 * undefined` — is derived from the handler's `args` with no server-side
 * scoping (no reference to the trusted `ctx` binding anywhere in the selector)
 * — the `ratelimit_key_spoofable_or_global` lint input. A key an attacker
 * controls lets them rotate it per request and bypass the limit entirely,
 * defeating its purpose. A selector scoped by `ctx` (e.g. `ctx.auth.userId`,
 * `ctx.ip`), or one with no `args` reference at all (a fixed/global bucket —
 * the "no key" case this lint deliberately does not flag, to keep it low-FP),
 * is not recorded. Structurally identical to `AdvisorRatelimitKeySelector`.
 */
export interface RatelimitKeySelectorIR {
    /** The `rateLimit`/`dbRateLimit` callee invoked. */
    callee: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The rate limit's `name` argument (the second positional argument), or `""` when not a string literal. */
    limitName: string;
    /** 1-based line of the `rateLimit`/`dbRateLimit` call, or `0` when unknown. */
    line: number;
    /** Who the site runs on behalf of — see {@link CallSiteScope}. */
    scope: CallSiteScope;
}
