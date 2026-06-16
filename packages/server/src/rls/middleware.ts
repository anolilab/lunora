/**
 * `rls(policies)` — the procedure-builder middleware that activates
 * Row-Level Security for the downstream handler.
 *
 * What it does, at runtime:
 *
 * 1. **Reads** — wraps `ctx.db.findMany`/`findFirst`/`findFirstOrThrow`/
 * `query`/`count`/`get` plus the analytical reads
 * `aggregate`/`groupBy`/`rank`/`rankBefore`/`rankPage`. Per table with a `read`
 * policy, builds the effective `baseWhere` (intersection of role-applicable
 * predicates) and threads it through the underlying ORM via the public
 * `QueryArgs.baseWhere` seam (see `@lunora/do/src/query-args.ts`).
 * `aggregate`/`groupBy` are scoped to `where`, so the `baseWhere` is AND-merged
 * and the reduction only sees policy-visible rows. `count` and the rank family
 * (`rank`/`rankBefore`/`rankPage`) are counts-of-partition that can't be safely
 * narrowed, so they fail closed with `COUNT_RLS_UNSUPPORTED` (kitcn's
 * documented constraint). Every method the wrapper doesn't override (e.g.
 * `normalizeId`, `system`) passes through untouched.
 *
 * 2. **Writes** — wraps `insert`/`patch`/`replace`/`delete`. For an
 * `update`/`delete` it fetches the pre-write row through the *unwrapped* writer
 * (RLS doesn't apply to the policy evaluator itself, only to the caller-visible
 * reader) and runs the matching write policy with `row` set; for `insert` it
 * runs the policy against the candidate document. A policy returning `false`
 * aborts the write with `LunoraError("FORBIDDEN")`.
 *
 * 3. **Opt-in scope** — a policy applies only inside procedures whose builder
 * chain includes this middleware. The `rls()` call site is the boundary;
 * procedures without it see the unwrapped `ctx.db` and ignore every policy in
 * the list. This is by design (PLAN2 §3.2).
 *
 * What it deliberately does **not** touch:
 *
 * - The `{ kind, args, handler }` dispatch contract.
 * - Triggers — cross-row trigger logic by design has the full row already
 * (`event.before`/`event.after`), so RLS gates the user-facing DB methods
 * inside trigger handlers but never the trigger payload itself. The wrapper is
 * installed on `ctx.db`; trigger internals use the underlying writer.
 * - `count()` is intercepted only on tables with an active read policy —
 * unrelated tables count freely.
 *
 * The middleware is signature-compatible with the builder's `Middleware&lt;>`,
 * so `.use(rls(policies))` slots in like any other middleware.
 */
import type { Middleware } from "../builder/types";
import { LunoraError } from "../error";
import type { FacadeEntry } from "../facade";
import { bindOrm, bindTableFacade } from "../facade";
import type { Permission, Policy, PolicyContext, RlsOptions, Role, WhereInput } from "./types";

/**
 * Structural mirror of `@lunora/do`'s `QueryArgs` and `CountArgs`. The
 * runtime ORM in `@lunora/do`/`@lunora/d1` reads `baseWhere` /
 * `restrictsCounts` straight off these option objects, so as long as the
 * fields here stay name-compatible the wrapper is portable across the two
 * dialects without an inter-package dependency.
 */
interface QueryArgs {
    baseWhere?: WhereInput;
    cursor?: null | string;
    limit?: number;
    orderBy?: ReadonlyArray<unknown>;

    /**
     * Per-target-table read filter the RLS wrapper attaches so a `with` relation
     * is policy-filtered on its own hop (see `@lunora/do`'s `QueryArgs`). Mirrors
     * the top-level read: `(table) => readBase(table).baseWhere`.
     */
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    restrictsCounts?: boolean;
    where?: WhereInput;
    with?: Record<string, unknown>;
}

interface CountArgs {
    baseWhere?: WhereInput;
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    restrictsCounts?: boolean;
    where?: WhereInput;
}

/** Structural mirror of `@lunora/do`'s `AggregateOptions` — only the fields the wrapper touches. */
interface AggregateArgs {
    baseWhere?: WhereInput;
    field?: string;
    op: string;
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    restrictsCounts?: boolean;
    where?: WhereInput;
}

/** Structural mirror of `@lunora/do`'s `GroupByOptions`. */
interface GroupByArgs {
    agg?: { field?: string; op: string };
    baseWhere?: WhereInput;
    by: ReadonlyArray<string>;
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    restrictsCounts?: boolean;
    where?: WhereInput;
}

/** Structural mirror of `@lunora/do`'s `RankOptions`. */
interface RankArgs {
    baseWhere?: WhereInput;
    restrictsCounts?: boolean;
    row: Record<string, unknown> | string;
    where?: WhereInput;
}

/** Structural mirror of `@lunora/do`'s `RankBeforeOptions`. */
interface RankBeforeArgs {
    partitionKey: string;
    restrictsCounts?: boolean;
    rowId: string;
    sortValues: ReadonlyArray<unknown>;
}

/** Structural mirror of `@lunora/do`'s `RankPageOptions`. */
interface RankPageArgs {
    baseWhere?: WhereInput;
    cursor?: null | string;
    restrictsCounts?: boolean;
    take?: number;
    where?: WhereInput;
}

interface QueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
}

interface TableReaderLike {
    collect: () => Promise<Record<string, unknown>[]>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReaderLike;
    first: () => Promise<Record<string, unknown> | null>;
    paginate: (options: { cursor?: null | string; numItems: number }) => Promise<QueryPage>;
    take: (limit: number) => Promise<Record<string, unknown>[]>;
    withIndex: (indexName: string, range?: (q: unknown) => unknown) => TableReaderLike;
    withSearchIndex: (indexName: string, search: (q: unknown) => unknown) => TableReaderLike;
}

/**
 * Structural projection of the runtime ORM writer. The wrapper relies only
 * on these fields, so it's interchangeable between `@lunora/do`'s
 * `DatabaseWriterLike` and `@lunora/d1`'s `DatabaseWriterLike`.
 */
interface DatabaseWriterLike {
    /**
     * Reduce matching rows to a scalar. The RLS wrapper AND-merges the read
     * `baseWhere` into `options` so the reduction only sees policy-visible rows
     * (safe: an aggregate scoped to `where` never reveals a hidden row — see
     * `@lunora/do`'s `RestrictableQueryOptions`). Required: the only writer ever
     * wrapped is `@lunora/do`'s `createShardCtxDb`, which always implements it.
     */
    aggregate: (tableName: string, options: AggregateArgs) => Promise<null | number>;
    count: (tableName: string, whereOrArgs?: CountArgs | WhereInput) => Promise<number>;
    delete: (id: string, expectedTable?: string) => Promise<void>;
    findFirst: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown> | null>;
    findFirstOrThrow: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown>>;
    findMany: (tableName: string, args?: QueryArgs) => Promise<QueryPage>;
    get: (id: string, expectedTable?: string) => Promise<Record<string, unknown> | null>;

    /**
     * Optional table-aware lookup. The underlying writer (e.g. `@lunora/do`)
     * already knows the owning table of an id internally (`lookupById`), so it
     * can return `{ row, tableName }` in a single round-trip. When present, the
     * RLS wrapper uses it to collapse the per-call membership-probe fan-out
     * (1 `get` + N `findFirst` across every policy table) down to one lookup.
     * Writers that don't implement it fall back to the probe path.
     */
    getWithTable?: (id: string, expectedTable?: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;

    /**
     * Group + reduce. Same `baseWhere` injection as `aggregate`: the per-group
     * reduction is scoped to policy-visible rows, so a group count tallies only
     * rows the caller may read. Required for the same reason as `aggregate`.
     */
    groupBy: (tableName: string, options: GroupByArgs) => Promise<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>, expectedTable?: string) => Promise<void>;
    query: (tableName: string) => TableReaderLike;

    /**
     * Rank a row within its partition. A position is a count-of-rows-before, so
     * — exactly like `count()` — it can't be trusted in an RLS-restricted
     * reader: the wrapper fails it closed with `COUNT_RLS_UNSUPPORTED`. Required
     * for the same reason as `aggregate`.
     */
    rank: (tableName: string, indexName: string, options: RankArgs) => Promise<null | { position: number; total: number }>;

    /** Cross-shard rank primitive — same count-of-before RLS hazard as `rank`; failed closed under a read policy. */
    rankBefore?: (tableName: string, indexName: string, options: RankBeforeArgs) => Promise<{ before: number; total: number }>;

    /**
     * Sorted pagination over a rank companion. The companion stores only the
     * partition + sort keys + id, so an arbitrary read `baseWhere` can't be
     * enforced against it (and re-filtering the fetched rows would break page
     * sizing). RLS therefore fails it closed rather than leak hidden rows.
     * Required for the same reason as `aggregate`.
     */
    rankPage: (tableName: string, indexName: string, options?: RankPageArgs) => Promise<QueryPage>;
    replace: (id: string, document: Record<string, unknown>, expectedTable?: string) => Promise<void>;
}

/**
 * What a procedure's `ctx.db` must structurally satisfy for the middleware
 * to wrap it. We deliberately mirror `@lunora/do`'s `DatabaseWriterLike`
 * rather than `@lunora/server`'s nominal `DatabaseWriter`/`DatabaseReader`:
 * the runtime adapter that flows in is the `DatabaseWriterLike`-shaped one,
 * and structural matching keeps this module free of an `@lunora/do`-typed
 * `ctx`.
 */
type RlsDatabase = DatabaseWriterLike;

/** Roles list source on the context. Tolerant of older auth states. */
type AuthLike = {
    getIdentity?: () => Promise<Record<string, unknown> | null>;
    roles?: ReadonlyArray<string>;
    userId?: null | string;
};

/** Minimal shape the middleware needs on the incoming ctx. */
interface RlsContextIn {
    auth?: AuthLike;
    db: RlsDatabase;
}

/** Sentinel `WhereInput` that compiles to a vacuously-false predicate. */
const FALSE_PREDICATE: WhereInput = { OR: [] };

/**
 * Well-known key the secure-by-default guard (`@lunora/do`'s `guardWriter`)
 * hangs the UNWRAPPED writer off of. Under a `.rls("required")` schema the
 * generated `ctx.db` is GUARDED — every read/write against a non-`.public()`
 * table throws unless RLS was engaged. This middleware recovers the raw writer
 * through the same `Symbol.for` registry key (no `server → do` import) so it can
 * read/write the policy tables it authorizes without tripping the guard.
 * Non-guarded writers (non-`required` schemas) don't carry it, so the lookup
 * falls back to the writer itself and behavior is unchanged.
 */
const RLS_UNWRAP_SYMBOL = Symbol.for("lunora.ctxdb.rls-unwrap");

/**
 * Collect a per-table map from a flat policy list. Order within each table
 * is preserved so the merge below honors author-declared precedence.
 */
const indexByTable = <Context>(policies: ReadonlyArray<Policy<Context>>): Map<string, Policy<Context>[]> => {
    const map = new Map<string, Policy<Context>[]>();

    for (const policy of policies) {
        const existing = map.get(policy.table) ?? [];

        existing.push(policy);
        map.set(policy.table, existing);
    }

    return map;
};

/**
 * Decide the effective read `baseWhere` for a table given the request's
 * applicable read policies:
 *
 * - any `true` → unrestricted (return `undefined`).
 * - any `WhereInput` → OR them (multiple policies broaden access).
 * - all `false`/empty → deny (return the FALSE sentinel).
 * - all `undefined` → deny (the table is read-guarded but every policy
 * abstained — fail CLOSED, never reveal every row).
 *
 * The Convex / kitcn convention is "any matching policy reveals the row";
 * we mirror that by OR-ing the predicates. This function is only ever reached
 * when the table has at least one read policy (see `readBase`), so abstention
 * by every policy must DENY rather than fall through unrestricted.
 */
const computeReadBaseWhere = <Context>(policies: ReadonlyArray<Policy<Context>>, context: PolicyContext<Context>): undefined | WhereInput => {
    const predicates: WhereInput[] = [];
    let sawTrue = false;

    for (const policy of policies) {
        if (policy.on !== "read") {
            continue;
        }

        const decision = policy.when(context);

        if (decision === undefined) {
            continue;
        }

        if (decision === true) {
            sawTrue = true;
            break;
        }

        if (decision === false) {
            continue;
        }

        predicates.push(decision);
    }

    if (sawTrue) {
        return undefined;
    }

    // No granting decision (every policy abstained or denied): fail closed.
    if (predicates.length === 0) {
        return FALSE_PREDICATE;
    }

    return predicates.length === 1 ? predicates[0] : { OR: predicates };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Operator keys the JS evaluator recognises. Mirrors `FieldOperators` from the SQL compiler. */
const OPERATOR_KEYS = ["contains", "eq", "gt", "gte", "in", "isNull", "lt", "lte", "ne", "notIn"] as const;

/**
 * SQL NULL semantics for ordered comparators: `null`/`undefined` never
 * compares as less-than/greater-than/contains anything. Without this guard JS
 * would silently coerce `null` to `0` and let `null < 5` evaluate truthy —
 * surprising and at odds with the SQL compiler the predicate flows through on
 * reads.
 */
const isOrderable = (value: unknown): value is bigint | number | string => {
    const type = typeof value;

    return type === "number" || type === "string" || type === "bigint";
};

/**
 * Evaluate the ordered comparators (`lt`/`lte`/`gt`/`gte`) of an operator bag.
 * SQL NULL semantics gate every comparison via {@link isOrderable}, so a
 * non-orderable operand (null/undefined/object) fails rather than coercing.
 * Returns `true` when the value satisfies all present ordered comparators.
 */
const matchesOrderedOperators = (documentValue: unknown, operators: Record<string, unknown>): boolean => {
    if ("lt" in operators && (!isOrderable(documentValue) || !isOrderable(operators["lt"]) || (documentValue as number) >= (operators["lt"] as number))) {
        return false;
    }

    if ("lte" in operators && (!isOrderable(documentValue) || !isOrderable(operators["lte"]) || (documentValue as number) > (operators["lte"] as number))) {
        return false;
    }

    if ("gt" in operators && (!isOrderable(documentValue) || !isOrderable(operators["gt"]) || (documentValue as number) <= (operators["gt"] as number))) {
        return false;
    }

    if ("gte" in operators && (!isOrderable(documentValue) || !isOrderable(operators["gte"]) || (documentValue as number) < (operators["gte"] as number))) {
        return false;
    }

    return true;
};

/**
 * Evaluate the membership + text comparators (`in`/`notIn`/`contains`/`isNull`)
 * of an operator bag. Returns `true` when the value satisfies all present ones.
 */
const matchesMembershipOperators = (documentValue: unknown, operators: Record<string, unknown>): boolean => {
    if ("in" in operators) {
        const list = operators["in"];

        if (!Array.isArray(list) || !list.includes(documentValue)) {
            return false;
        }
    }

    if ("notIn" in operators) {
        const list = operators["notIn"];

        if (Array.isArray(list) && list.includes(documentValue)) {
            return false;
        }
    }

    if ("contains" in operators) {
        const needle = operators["contains"];

        if (typeof documentValue !== "string" || typeof needle !== "string" || !documentValue.includes(needle)) {
            return false;
        }
    }

    if ("isNull" in operators) {
        const expectsNull = operators["isNull"] === true;

        if (expectsNull !== (documentValue === null || documentValue === undefined)) {
            return false;
        }
    }

    return true;
};

/**
 * Evaluate an operator bag (`{ eq, ne, in, … }`) against a single document
 * value. Mirrors the SQL compiler's operator set; SQL NULL semantics gate the
 * ordered comparators via {@link isOrderable}. Returns `true` when the value
 * satisfies every operator in the bag.
 */
const matchesOperators = (documentValue: unknown, operators: Record<string, unknown>): boolean => {
    if ("eq" in operators && documentValue !== operators["eq"]) {
        return false;
    }

    if ("ne" in operators && documentValue === operators["ne"]) {
        return false;
    }

    return matchesMembershipOperators(documentValue, operators) && matchesOrderedOperators(documentValue, operators);
};

/**
 * Evaluate one `AND`/`OR`/`NOT` combinator clause. `recurse` is the top-level
 * {@link matchesWhere} (injected to dodge the mutual-reference ordering), so
 * each branch is itself a full `WhereInput`.
 */
const matchesCombinator = (
    document: Record<string, unknown>,
    key: "AND" | "NOT" | "OR",
    value: unknown,
    recurse: (document: Record<string, unknown>, where: WhereInput) => boolean,
): boolean => {
    if (key === "AND") {
        return Array.isArray(value) && value.every((branch) => recurse(document, branch as WhereInput));
    }

    if (key === "OR") {
        return Array.isArray(value) && value.some((branch) => recurse(document, branch as WhereInput));
    }

    return !recurse(document, (value ?? {}) as WhereInput);
};

const isCombinatorKey = (key: string): key is "AND" | "NOT" | "OR" => key === "AND" || key === "OR" || key === "NOT";

const isOperatorBag = (value: unknown): value is Record<string, unknown> =>
    isPlainObject(value) && Object.keys(value).every((k) => (OPERATOR_KEYS as ReadonlyArray<string>).includes(k));

/** Prisma-style relation operators (mirrors `relation-predicates.ts` in `@lunora/do`). */
const RELATION_OPERATOR_KEYS = ["every", "is", "isNot", "none", "some"] as const;

/**
 * A value is a relation predicate when it is a plain object whose every key is a
 * known relation operator — the same "all keys known" disambiguation the
 * pre-resolver uses. Structural (no schema needed): the middleware closure has
 * no relation map, but a relation node is recognizable by shape alone.
 */
const isRelationPredicateValue = (value: unknown): boolean =>
    isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((k) => (RELATION_OPERATOR_KEYS as ReadonlyArray<string>).includes(k));

/**
 * Does `where` contain a relation-crossing predicate anywhere? The in-memory
 * {@link matchesWhere} evaluator has no `fetcher` and cannot resolve a relation
 * node, so a write policy carrying one must be rejected with a clear error
 * rather than silently denied (a non-relation key holding such a value can't be
 * distinguished from a real relation here, so we treat any relation-shaped node
 * as one — relation operator names don't collide with column-operator names).
 */
const containsRelationPredicate = (where: WhereInput): boolean =>
    Object.keys(where).some((key) => {
        const value = where[key];

        if (isCombinatorKey(key)) {
            if (key === "NOT") {
                return containsRelationPredicate((value ?? {}) as WhereInput);
            }

            return Array.isArray(value) && value.some((branch) => containsRelationPredicate((branch ?? {}) as WhereInput));
        }

        return isRelationPredicateValue(value);
    });

/**
 * JS-side `WhereInput` evaluator. Used by the legacy `query()` wrapper to
 * push read predicates down as `.filter()`, and by {@link evaluateWrite} to
 * gate write policies whose `when` returns a `WhereInput` against the
 * candidate row (insert) or pre-write row (update/delete). Supports the same
 * operator set as the SQL compiler (`eq`, `ne`, `in`, `notIn`, `lt`, `lte`,
 * `gt`, `gte`, `isNull`, `contains`) plus `AND`/`OR`/`NOT` composition. The
 * full compiler stays the single source of truth for SQL-bound predicates;
 * this evaluator is a deliberate parallel for the in-memory path.
 */
const matchesWhere = (document: Record<string, unknown>, where: WhereInput): boolean => {
    for (const key of Object.keys(where)) {
        const value = where[key];

        if (isCombinatorKey(key)) {
            if (!matchesCombinator(document, key, value, matchesWhere)) {
                return false;
            }

            continue;
        }

        const documentValue = document[key];

        if (isOperatorBag(value)) {
            if (!matchesOperators(documentValue, value)) {
                return false;
            }

            continue;
        }

        if (documentValue !== value) {
            return false;
        }
    }

    return true;
};

/**
 * Evaluate write policies for a `(table, op)` pair. Returns `true` to allow
 * the write, `false` to deny. The convention is "every matching write policy
 * must allow" — the most restrictive policy wins, mirroring SQL RLS.
 *
 * Decision semantics:
 *
 * - `true` → allow.
 * - `false` → deny (`LunoraError("FORBIDDEN")` at the call site).
 * - `WhereInput` → allow only when the candidate row (insert) or pre-write row
 * (update/delete) matches the predicate; a mismatch denies the write. Evaluated
 * by {@link matchesWhere} with the same operator set as the SQL compiler
 * (`eq`/`ne`/`in`/`notIn`/`lt`/`lte`/`gt`/`gte`/`isNull`/`contains` +
 * `AND`/`OR`/`NOT`). A predicate without a row to evaluate (defensive case —
 * the wrapper always passes one) denies.
 * - `undefined` → policy opts out; doesn't count as a decision.
 *
 * Default-DENY: once a table participates in RLS (has any policy attached) a
 * write op with NO matching write policy is denied. Read policies do NOT
 * authorize writes — a table that declares only read policies would otherwise
 * allow any caller to patch/delete its rows by id (cross-tenant write).
 * Authors must declare an explicit `insert`/`update`/`delete` policy for every
 * write op they want to permit on a policy-gated table.
 *
 * WITH CHECK: for update ops the predicate is evaluated against BOTH the
 * pre-write row (USING) and, when supplied, the post-image `nextRow` (WITH
 * CHECK) so a policy cannot be satisfied by the old row while the patch
 * reassigns the row to another tenant.
 *
 * SYSTEM-FIELD LIMITATION (insert): on `insert` the candidate `context.row`
 * is the caller's document BEFORE the writer stamps `_id` / `_creationTime`
 * downstream (those are assigned by `@lunora/do`/`@lunora/d1` after the policy
 * runs). So an insert policy whose `when` returns a `WhereInput` referencing
 * `_id` or `_creationTime` cannot match — the field is absent on the candidate
 * — and the insert is DENIED. Author insert policies against user-supplied
 * fields (`ownerId`, `tenantId`, …), not writer-assigned system fields. Update
 * / delete policies do see system fields (the pre-write row is fully stamped).
 */
const evaluateWrite = <Context>(
    policies: ReadonlyArray<Policy<Context>>,
    op: Exclude<Policy["on"], "read">,
    context: PolicyContext<Context>,
    nextRow?: Record<string, unknown>,
): boolean => {
    let sawWritePolicy = false;

    for (const policy of policies) {
        if (policy.on !== op) {
            continue;
        }

        sawWritePolicy = true;

        const decision = policy.when(context);

        if (decision === undefined || decision === true) {
            continue;
        }

        if (decision === false) {
            return false;
        }

        // Relation-crossing predicates need a child fetch the in-memory
        // evaluator can't perform — reject loudly instead of silently denying.
        if (containsRelationPredicate(decision)) {
            throw new LunoraError(
                "RELATION_PREDICATE_UNSUPPORTED",
                "relation predicates are not supported in write policies; use a read policy or a flat column check",
            );
        }

        // WhereInput predicate — the row qualifies only if it matches.
        // Without a row to evaluate against we deny (safer default; in
        // practice the wrapper always supplies the candidate or pre-write
        // row, so this branch is defensive).
        if (!context.row || !matchesWhere(context.row, decision)) {
            return false;
        }

        // WITH CHECK: the resulting row must also satisfy the policy, so an
        // update cannot reassign the row out of the caller's tenant.
        if (nextRow !== undefined && !matchesWhere(nextRow, decision)) {
            return false;
        }
    }

    // Participating table, no matching write policy for this op → deny.
    return sawWritePolicy;
};

/**
 * Coerce `args` into the `QueryArgs` shape. Tolerates `undefined` (no args)
 * and a `WhereInput` (legacy `count(table, where)`).
 */
const intoQueryArgs = (args: QueryArgs | undefined): QueryArgs => args ?? {};

/**
 * Tolerantly read the count argument: either a `WhereInput` (legacy) or a
 * `CountArgs` options bag. We never strip caller-supplied `baseWhere`; we
 * AND-merge the RLS one on top.
 */
const intoCountArgs = (argument: CountArgs | undefined | WhereInput): CountArgs => {
    if (argument === undefined) {
        return {};
    }

    if (isPlainObject(argument) && ("baseWhere" in argument || "restrictsCounts" in argument || "where" in argument)) {
        return argument as CountArgs;
    }

    return { where: argument as WhereInput };
};

const mergeBaseWhere = (caller: undefined | WhereInput, injected: undefined | WhereInput): undefined | WhereInput => {
    if (!injected || Object.keys(injected).length === 0) {
        return caller;
    }

    if (!caller || Object.keys(caller).length === 0) {
        return injected;
    }

    return { AND: [injected, caller] };
};

/**
 * A value glued onto `ctx.db` is a per-table facade entry when it carries the
 * distinctive `findMany` + `withSearchIndex` accessor pair (the `system` reader
 * and other ctx fields don't). Used to find the entries that need re-binding.
 */
const isFacadeEntry = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, unknown>;

    return typeof candidate["findMany"] === "function" && typeof candidate["withSearchIndex"] === "function";
};

/**
 * Build a writer that intercepts table-scoped reads/writes against the
 * underlying `DatabaseWriterLike`, applying the policy evaluator on every
 * call. The wrapper is a fresh closure per request so the evaluator sees the
 * current `ctx`.
 *
 * Two writers flow in to make secure-by-default airtight:
 *
 * - `base` — the writer the procedure was handed as `ctx.db`. Under a
 * `.rls("required")` schema this is the GUARDED writer (denies any non-public
 * table). Its per-table facade entries are glued on here, so the `...base`
 * spread carries them. Every NON-policy table routes through `base`, so a
 * protected table with no policy stays denied even inside an RLS procedure —
 * you must declare a policy to reach it.
 * - `raw` — the unwrapped writer (recovered via {@link RLS_UNWRAP_SYMBOL}, or
 * `base` itself when unguarded). POLICY tables route through `raw` so the
 * middleware's own policy-filtered reads/writes and membership probes don't
 * trip the guard. For a non-guarded (non-`required`) schema `base === raw`, so
 * the routing is a no-op and behavior is identical to before.
 */
const wrapDatabase = <Context>(base: RlsDatabase, raw: RlsDatabase, perTable: Map<string, Policy<Context>[]>, context: PolicyContext<Context>): RlsDatabase => {
    /**
     * Route a table to the writer that should service it: `raw` for a policy
     * table (already authorized here — must bypass the guard), `base` for any
     * other table (so the secure-by-default guard denies a protected,
     * policy-less table and passes a `.public()` one through).
     */
    const route = (tableName: string): RlsDatabase => (perTable.has(tableName) ? raw : base);

    /**
     * Cached effective read `baseWhere` per table. Cached for the lifetime
     * of one wrapped writer — i.e. one request — so a single procedure
     * doesn't re-evaluate the same policy chain on every read.
     */
    const readBaseCache = new Map<string, { baseWhere: undefined | WhereInput; restricts: boolean }>();

    const readBase = (tableName: string): { baseWhere: undefined | WhereInput; restricts: boolean } => {
        const cached = readBaseCache.get(tableName);

        if (cached) {
            return cached;
        }

        const policies = perTable.get(tableName);

        if (!policies || policies.length === 0 || !policies.some((policy) => policy.on === "read")) {
            const result = { baseWhere: undefined, restricts: false };

            readBaseCache.set(tableName, result);

            return result;
        }

        const baseWhere = computeReadBaseWhere(policies, context);
        const result = { baseWhere, restricts: true };

        readBaseCache.set(tableName, result);

        return result;
    };

    /**
     * The read filter for a TARGET table, attached to every read so `@lunora/do`'s
     * `resolveWith` can enforce a child table's read policy when it's loaded as a
     * `with` relation (or `_count`). It returns the SAME `baseWhere` a top-level
     * read of that table would get — so a relation read matches a direct read,
     * closing the RLS bypass where `findMany({ with: { child: true } })` would
     * otherwise return the child's rows unfiltered. `undefined` for tables with
     * no restricting policy.
     */
    const relationReadFilter = (table: string): undefined | WhereInput => readBase(table).baseWhere;

    /**
     * Resolve the raw row for `id` and which policy-gated table (if any) owns
     * it. The single source of truth shared by `get()` and the write gate.
     * Two paths:
     *
     * - **Fast path** — when the writer implements the optional `getWithTable`
     * seam it already knows the owning table from its internal index, so we
     * get `{ row, tableName }` in a single round-trip and only need to check
     * whether that table participates in RLS.
     * - **Fallback** — older writers expose only `get(id)`, so we fetch the
     * row, then probe every policy table with a `findFirst` to discover
     * ownership. The probes run concurrently (latency bounded by the slowest
     * single probe, not their sum). The unwrapped `base.*` is intentionally
     * used so policy enforcement on writes doesn't recurse through itself.
     *
     * `row` is `null` when the id doesn't exist. `tableName` is `undefined` when
     * the row exists but isn't in any policy-gated table (no policy applies →
     * callers fall through unrestricted).
     */
    const locateRow = async (id: string, expectedTable?: string): Promise<{ row: null | Record<string, unknown>; tableName: string | undefined }> => {
        if (raw.getWithTable) {
            // Pin the lookup to the bound table when the by-id facade forwards
            // one, so a foreign id resolves to "absent" rather than another
            // table's row (IDOR). Read through the UNGUARDED `raw` writer: this
            // is a policy-evaluation probe, not caller-visible data, so it must
            // not be denied by the secure-by-default guard.
            const located = await raw.getWithTable(id, expectedTable);

            if (!located) {
                // eslint-disable-next-line unicorn/no-null -- absent row mirrors @lunora/do's writer null sentinel
                return { row: null, tableName: undefined };
            }

            // Owned by a table that isn't policy-gated → tableName undefined.
            return { row: located.row, tableName: perTable.has(located.tableName) ? located.tableName : undefined };
        }

        const row = await raw.get(id, expectedTable);

        if (!row) {
            // eslint-disable-next-line unicorn/no-null -- absent row mirrors @lunora/do's writer null sentinel
            return { row: null, tableName: undefined };
        }

        // Ids are globally unique, so at most one probe hits; settle all of
        // them in parallel and pick the hit instead of serializing the
        // round-trips. When the facade pinned a table, only that table's policy
        // can apply — restrict the probe set to it.
        const pinnedProbe = expectedTable !== undefined && perTable.has(expectedTable) ? [expectedTable] : [];
        const probeTables = expectedTable === undefined ? [...perTable.keys()] : pinnedProbe;
        const probes = await Promise.all(
            probeTables.map(async (tableName) => {
                const probe = await raw.findFirst(tableName, { limit: 1, where: { _id: id } });

                return probe?.["_id"] === id ? tableName : undefined;
            }),
        );

        return { row, tableName: probes.find((entry): entry is string => entry !== undefined) };
    };

    /**
     * Locate the policy-gated table that owns `id` (for the write gate). Thin
     * wrapper over {@link locateRow} that drops the unguarded-row case — a write
     * to a row in no policy-gated table needs no policy check.
     */
    const findRowTable = async (id: string, expectedTable?: string): Promise<undefined | { row: Record<string, unknown>; tableName: string }> => {
        const located = await locateRow(id, expectedTable);

        return located.row && located.tableName !== undefined ? { row: located.row, tableName: located.tableName } : undefined;
    };

    /**
     * Locate the row + table, evaluate the matching write policy against the
     * pre-write row (and the post-image for updates), then perform the
     * underlying mutation. Shared by `delete`/`patch`/`replace` so the three
     * id-keyed write paths agree on deny semantics and on the "no policy →
     * pass through" fast path.
     *
     * `computeNextRow`, when supplied (patch/replace), yields the WITH-CHECK
     * post-image so a policy can't be satisfied by the old row while the write
     * reassigns it to another tenant.
     *
     * TOCTOU note: the locate → policy-check → `perform()` sequence is not
     * atomic — a concurrent write to the same row can land between the policy
     * decision and the mutation. The underlying writer guards the actual data
     * race with optimistic concurrency (raising `ConflictError` on a clobbered
     * row), which bounds this window; the policy verdict itself is still taken
     * against the pre-write snapshot. A fully atomic check requires a storage
     * transaction primitive the generic writer interface does not expose.
     */
    const gateById = async <R>(
        id: string,
        op: Exclude<Policy["on"], "insert" | "read">,
        perform: (writer: RlsDatabase) => Promise<R>,
        computeNextRow?: (preRow: Record<string, unknown>) => Record<string, unknown>,
        expectedTable?: string,
    ): Promise<R> => {
        const located = await findRowTable(id, expectedTable);

        if (!located) {
            // The id is in no policy-gated table (a non-policy table or absent).
            // Route through the GUARDED `base` so a protected, policy-less table
            // is denied (secure-by-default) and a `.public()` / absent one passes
            // through. For a non-guarded schema `base === raw`, so this is a
            // plain write.
            return perform(base);
        }

        const policies = perTable.get(located.tableName);

        if (policies) {
            const nextRow = computeNextRow ? computeNextRow(located.row) : undefined;
            const writeOk = evaluateWrite(policies, op, { ...context, row: located.row }, nextRow);

            if (!writeOk) {
                throw new LunoraError("FORBIDDEN", `${op} on "${located.tableName}" denied by policy`);
            }
        }

        // Policy table, write authorized: perform on the UNGUARDED `raw` writer
        // (the guard would otherwise deny this protected table).
        return perform(raw);
    };

    /**
     * Fail a count-of-partition read (`rank`/`rankBefore`/`rankPage`) closed
     * when the table carries an active read policy. These depend on the full
     * partition — a position or sorted page computed over rows the policy hides
     * would either undercount or leak, so under RLS they're unsupported (the
     * same `COUNT_RLS_UNSUPPORTED` constraint `count()` enforces). Returns the
     * effective read `baseWhere` for the non-restricted pass-through case.
     */
    const requireUnrestrictedReadBase = (tableName: string, method: string): undefined | WhereInput => {
        const { baseWhere, restricts } = readBase(tableName);

        if (restricts) {
            throw new LunoraError("COUNT_RLS_UNSUPPORTED", `${method}() is not supported on "${tableName}" inside an RLS-restricted context`);
        }

        return baseWhere;
    };

    // `rankBefore` is the only analytical method that may be absent (the D1
    // twin omits it); capture it so the truthy check narrows into the wrapper
    // without a non-null assertion.
    const baseRankBefore = base.rankBefore;

    const wrapped: RlsDatabase = {
        ...base,
        async count(tableName, whereOrArgs) {
            const { baseWhere, restricts } = readBase(tableName);
            const args = intoCountArgs(whereOrArgs);

            return route(tableName).count(tableName, {
                ...args,
                baseWhere: mergeBaseWhere(args.baseWhere, baseWhere),
                relationBaseWhere: relationReadFilter,
                restrictsCounts: (args.restrictsCounts ?? false) || restricts,
            });
        },

        delete: (id, expectedTable) => gateById(id, "delete", (writer) => writer.delete(id, expectedTable), undefined, expectedTable),

        async findFirst(tableName, args) {
            const { baseWhere } = readBase(tableName);

            return route(tableName).findFirst(tableName, {
                ...intoQueryArgs(args),
                baseWhere: mergeBaseWhere(args?.baseWhere, baseWhere),
                relationBaseWhere: relationReadFilter,
            });
        },

        async findFirstOrThrow(tableName, args) {
            const { baseWhere } = readBase(tableName);

            return route(tableName).findFirstOrThrow(tableName, {
                ...intoQueryArgs(args),
                baseWhere: mergeBaseWhere(args?.baseWhere, baseWhere),
                relationBaseWhere: relationReadFilter,
            });
        },

        async findMany(tableName, args) {
            const { baseWhere } = readBase(tableName);

            return route(tableName).findMany(tableName, {
                ...intoQueryArgs(args),
                baseWhere: mergeBaseWhere(args?.baseWhere, baseWhere),
                relationBaseWhere: relationReadFilter,
            });
        },

        async get(id, expectedTable) {
            // Step 1 — **membership + raw fetch in one pass**. `locateRow`
            // returns the raw row (so an absent row is `null` and a row in no
            // policy-gated table falls through unrestricted) plus the owning
            // policy-gated `tableName` when one exists. `expectedTable` (when
            // the by-id facade forwards it) pins the lookup to the bound table
            // so a foreign id can't read another table's row.
            const located = await locateRow(id, expectedTable);

            if (!located.row) {
                // eslint-disable-next-line unicorn/no-null -- RlsDatabase.get structurally mirrors @lunora/do's writer, which returns `null` for an absent row
                return null;
            }

            // Row exists but isn't in any policy-gated table. Defer to the
            // GUARDED `base.get` so a protected, policy-less table is denied
            // (secure-by-default) and a `.public()` one returns the row.
            // `locateRow` read through `raw`, so it can't itself be trusted to
            // return a protected row to the caller. For a non-guarded schema
            // `base === raw`, so this is the plain unrestricted read.
            if (located.tableName === undefined) {
                return base.get(id, expectedTable);
            }

            const { baseWhere, restricts } = readBase(located.tableName);

            // The owning table participates in RLS but the read policy doesn't
            // restrict (e.g. policy returned `true`) → return the row as-is.
            if (!restricts || !baseWhere) {
                return located.row;
            }

            // Step 2 — **policy check**: re-fetch WITH `baseWhere` only on the
            // owning table, through the UNGUARDED `raw` writer (a policy table —
            // the guard would deny it). `null` here is the policy verdict
            // ("denied"), NOT a fall-through to the unguarded row — that
            // distinction is what stops a hidden row from leaking.
            const allowed = await raw.findFirst(located.tableName, { baseWhere, limit: 1, where: { _id: id } });

            // eslint-disable-next-line unicorn/no-null -- null is the deliberate "denied" verdict surfaced by get(), mirroring @lunora/do
            return allowed?.["_id"] === id ? allowed : null;
        },

        async insert(tableName, document) {
            const policies = perTable.get(tableName);

            if (policies) {
                const writeOk = evaluateWrite(policies, "insert", { ...context, row: document });

                if (!writeOk) {
                    throw new LunoraError("FORBIDDEN", `insert on "${tableName}" denied by policy`);
                }

                // Policy table, insert authorized: write through the UNGUARDED
                // `raw` writer (the guard would deny this protected table).
                return raw.insert(tableName, document);
            }

            // Non-policy table → GUARDED `base` enforces secure-by-default: a
            // protected, policy-less table is denied; a `.public()` one passes.
            return base.insert(tableName, document);
        },

        patch: (id, patch, expectedTable) =>
            gateById(
                id,
                "update",
                (writer) => writer.patch(id, patch, expectedTable),
                (preRow) => {
                    return { ...preRow, ...patch };
                },
                expectedTable,
            ),

        query(tableName) {
            const { baseWhere } = readBase(tableName);

            const reader = route(tableName).query(tableName);

            if (!baseWhere) {
                return reader;
            }

            // The legacy reader doesn't take a `baseWhere` — push the
            // predicate down as an in-memory `.filter()`. This trades the
            // SQL-side prune for a row-by-row JS check, but the legacy
            // `query()` path is already an iterator-style reader.
            //
            // We compile the predicate once into a JS-side checker.
            return reader.filter((document) => matchesWhere(document, baseWhere));
        },

        replace: (id, document, expectedTable) =>
            gateById(
                id,
                "update",
                (writer) => writer.replace(id, document, expectedTable),
                // Mirror the writer's post-image: `_id` always comes from the
                // existing row; `_creationTime` honors a caller-supplied value
                // (the writer keeps `document._creationTime` when present) and
                // otherwise falls back to the existing row's value.
                (preRow) => {
                    return {
                        ...document,
                        _creationTime: document["_creationTime"] ?? preRow["_creationTime"],
                        _id: preRow["_id"],
                    };
                },
                expectedTable,
            ),

        // Analytical reads — plain methods (the writer always implements them;
        // see the required signatures on `DatabaseWriterLike`). `aggregate` /
        // `groupBy` are scoped to `where`, so the read `baseWhere` is AND-merged
        // and the reduction only sees policy-visible rows. `rank` / `rankPage`
        // are counts-of-partition that can't be safely narrowed, so they fail
        // closed under a read policy (see `requireUnrestrictedReadBase`).
        aggregate(tableName, options) {
            const { baseWhere } = readBase(tableName);

            return route(tableName).aggregate(tableName, {
                ...options,
                baseWhere: mergeBaseWhere(options.baseWhere, baseWhere),
                relationBaseWhere: relationReadFilter,
            });
        },

        groupBy(tableName, options) {
            const { baseWhere } = readBase(tableName);

            return route(tableName).groupBy(tableName, {
                ...options,
                baseWhere: mergeBaseWhere(options.baseWhere, baseWhere),
                relationBaseWhere: relationReadFilter,
            });
        },

        rank(tableName, indexName, options) {
            const baseWhere = requireUnrestrictedReadBase(tableName, "rank");

            return route(tableName).rank(tableName, indexName, { ...options, baseWhere: mergeBaseWhere(options.baseWhere, baseWhere) });
        },

        rankPage(tableName, indexName, options) {
            const baseWhere = requireUnrestrictedReadBase(tableName, "rankPage");

            return route(tableName).rankPage(tableName, indexName, { ...options, baseWhere: mergeBaseWhere(options?.baseWhere, baseWhere) });
        },

        // `rankBefore` is the one optional method (the D1 twin omits it).
        ...(baseRankBefore
            ? {
                  rankBefore: (tableName: string, indexName: string, options: RankBeforeArgs) => {
                      requireUnrestrictedReadBase(tableName, "rankBefore");

                      // Route to the policy/non-policy writer; both carry
                      // `rankBefore` when `base` does (the guard spreads `raw`).
                      const target = route(tableName);

                      return (target.rankBefore ?? baseRankBefore)(tableName, indexName, options);
                  },
              }
            : {}),
    };

    // SECURITY: the generated runtime glues a per-table facade
    // (`ctx.db.messages.findMany(...)`, codegen's `bindTableFacade`) onto
    // `ctx.db`, bound to the UNWRAPPED writer. The `...base` spread above copies
    // those raw-bound accessors verbatim, so without this loop a policy table's
    // facade would read around RLS (and around the `count`/rank fail-closed
    // guards). Re-bind the policy tables to route through the wrapped writer,
    // using the SAME `bindTableFacade` codegen emits so the two can't drift.
    //
    // Only POLICY tables are re-bound: a non-policy table's entry needs no RLS,
    // and (crucially) a `.global()` table's entry is bound to the D1 `globalDb`
    // writer — re-binding it through the local wrapped writer would query the
    // wrong backend. Leaving non-policy entries on their original binding keeps
    // both backends correct. (RLS policies target shard-local tables.)
    const writableFacade = wrapped as unknown as Record<string, unknown>;

    for (const tableName of perTable.keys()) {
        if (isFacadeEntry((base as unknown as Record<string, unknown>)[tableName])) {
            writableFacade[tableName] = bindTableFacade(wrapped, tableName);
        }
    }

    return wrapped;
};

/**
 * Procedure-builder middleware. Apply per-request via `.use(rls(policies))`.
 * Closes over the policy list at builder-construction time; resolves the
 * effective decision per call against the live ctx.
 *
 * IMPORTANT: a policy MUST be in scope only for procedures whose builder
 * chain includes this middleware — opt-in, never global. This is the
 * `PLAN2 §3.2` invariant.
 */
/** Normalize a permission (object or bare name) to its name. */
const permissionName = (permission: Permission | string): string => (typeof permission === "string" ? permission : permission.name);

/**
 * Build a `roleName → granted-permission-names` index from the registered
 * roles, so a request's `auth.roles` resolves to its permissions with one Set
 * per role. An unregistered role contributes nothing — `can(...)` fails closed
 * for roles the author never declared a grant for.
 */
const indexRolePermissions = (roles: ReadonlyArray<Role> | undefined): Map<string, ReadonlySet<string>> => {
    const map = new Map<string, ReadonlySet<string>>();

    for (const role of roles ?? []) {
        map.set(role.name, new Set((role.permissions ?? []).map((permission) => permissionName(permission))));
    }

    return map;
};

const rls = <Context extends RlsContextIn = RlsContextIn>(policies: ReadonlyArray<Policy<Context>>, options: RlsOptions = {}): Middleware<Context, Context> => {
    const perTable = indexByTable(policies);
    const rolePermissions = indexRolePermissions(options.roles);

    return async ({ ctx, next }) => {
        const auth = ctx.auth ?? {};
        // Resolve identity once per RLS-protected procedure so policies can
        // branch on claims (`ctx.auth.identity.email` etc.) without each
        // policy paying for its own `getIdentity()` call. `null` covers both
        // the anonymous case and the no-resolver case (older auth states).
        // eslint-disable-next-line unicorn/no-null -- PolicyContext.auth.identity is a public type carrying `null` for the anonymous/no-resolver case
        const identity = (await auth.getIdentity?.()) ?? null;
        const roles = auth.roles ?? [];

        // Union the permissions granted by every role the request carries, once
        // per protected procedure, so `can(...)` inside policies is a Set lookup.
        const granted = new Set<string>();

        for (const roleName of roles) {
            for (const name of rolePermissions.get(roleName) ?? []) {
                granted.add(name);
            }
        }

        const policyContext: PolicyContext<Context> = {
            auth: {
                can: (permission) => granted.has(permissionName(permission)),
                identity,
                roles,
                // eslint-disable-next-line unicorn/no-null -- PolicyContext.auth.userId is a public `null | string` type
                userId: auth.userId ?? null,
            },
            ctx,
        };

        // Under a `.rls("required")` schema `ctx.db` is the GUARDED writer;
        // recover the unwrapped one so the middleware can read/write the policy
        // tables it authorizes without tripping the guard. A non-guarded writer
        // doesn't carry the symbol, so `raw` falls back to `ctx.db` and the
        // wrapper behaves exactly as before (`base === raw`).
        const guarded = ctx.db;
        const raw = ((guarded as unknown as Record<PropertyKey, unknown>)[RLS_UNWRAP_SYMBOL] as RlsDatabase | undefined) ?? guarded;
        const wrapped = wrapDatabase<Context>(guarded, raw, perTable, policyContext);
        // `next({ ctx: extension })` expects an extension shape. We replace
        // `db` (carrying the re-bound per-table facade), and — when present —
        // `orm`: it's a sibling ctx field (codegen's `bindOrm`) bound to the
        // unwrapped writer, so leaving it untouched would let `ctx.orm.query`
        // and the orm write helpers bypass RLS. The cast routes them through
        // the middleware-extension channel without leaking RLS internals into
        // the builder's typed surface.
        const extension: Record<string, unknown> = { db: wrapped };
        const { orm } = ctx as { orm?: unknown };

        if (orm !== null && typeof orm === "object") {
            // `wrapped` carries the re-bound policy-table facade entries (plus
            // the originals for the rest), so rebuilding the orm over it routes
            // `ctx.orm.query`/writes through the same enforcement. Same shared
            // `bindOrm` codegen uses.
            extension.orm = bindOrm(wrapped as unknown as Record<string, FacadeEntry>);
        }

        return next({ ctx: extension });
    };
};

export { rls };

export type { RlsDatabase };

/**
 * Internal policy-evaluation primitives, exported for the in-process RLS test
 * harness (`@lunora/server/rls/testing`) so it evaluates policies through the
 * exact same logic the middleware uses at request time — never a parallel
 * re-implementation that could drift. Not part of the package's public API; the
 * package root does not re-export them.
 * @internal
 */
export { computeReadBaseWhere, evaluateWrite, indexRolePermissions, matchesWhere, permissionName };
