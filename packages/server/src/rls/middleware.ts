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
 * The middleware is signature-compatible with the builder's `Middleware<>`,
 * so `.use(rls(policies))` slots in like any other middleware.
 */
import { LunoraError } from "@lunora/errors";

import { isRelationPredicate } from "../../../../shared/relation-operators";
// `isPlainObject` comes from the wire codec rather than being re-declared here.
// The prototype check it carries is load-bearing: a local `typeof === "object"`
// variant counted a `Date`, a `Uint8Array` or a `Map` as a plain object, so
// `isOperatorBag` saw zero own enumerable keys, its `every` was vacuously true,
// and `matchesOperators` returned true having checked nothing — making
// `where: { createdAt: someDate }` match EVERY row on the write-decision paths
// and the JS reader instead of comparing by equality. The codec needs the exact
// same predicate for the same reason (a class instance has no own enumerable
// keys and would silently encode to `{}`). `Array.isArray` is subsumed: an
// array's prototype is `Array.prototype`, not `Object.prototype`.
import { isPlainObject } from "../../../../shared/wire-codec";
import type { Middleware } from "../builder/types";
import type { FacadeEntry } from "../facade";
import { bindOrm, bindTableFacade } from "../facade";
import { optionalWriterOverride } from "../optional-writer-override";
import type { ShardRankPageResultLike } from "../rank-page-rows-shape";
import { tagRlsMiddleware } from "./policy-tag";
import { deny } from "./predicates";
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
    withGeoIndex: (indexName: string, build: (q: unknown) => unknown) => TableReaderLike;
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
    delete: (id: string, expectedTable?: string, options?: { hard?: boolean }) => Promise<void>;

    /** Uncapped, chunked erase of a whole table. The RLS wrapper gates each row like a single delete. */
    deleteAll?: (tableName: string, options?: { chunkSize?: number; hard?: boolean }) => Promise<{ deleted: number }>;
    deleteMany: (ids: ReadonlyArray<string>, options?: { limit?: number }, expectedTable?: string) => Promise<{ deleted: number }>;
    deleteWhere?: (tableName: string, where: WhereInput, options?: { limit?: number }) => Promise<{ deleted: number }>;
    findFirst: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown> | null>;
    findFirstOrThrow: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown>>;
    findMany: (tableName: string, args?: QueryArgs) => Promise<QueryPage>;
    get: (id: string, expectedTable?: string) => Promise<Record<string, unknown> | null>;

    /**
     * Group + reduce. Same `baseWhere` injection as `aggregate`: the per-group
     * reduction is scoped to policy-visible rows, so a group count tallies only
     * rows the caller may read. Required for the same reason as `aggregate`.
     */
    groupBy: (tableName: string, options: GroupByArgs) => Promise<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    insertMany: (
        tableName: string,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: { limit?: number; skipDuplicates?: boolean },
    ) => Promise<(string | null)[]>;
    insertManyUnsafe: (
        tableName: string,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: { allowExplicitId?: boolean; limit?: number },
    ) => Promise<string[]>;

    /**
     * Optional table-aware lookup. The underlying writer (e.g. `@lunora/do`)
     * already knows the owning table of an id internally, so it can return
     * `{ row, tableName }` in a single round-trip. When present, the RLS wrapper
     * uses it to collapse the per-call membership-probe fan-out (1 `get` + N
     * `findFirst` across every policy table) down to one lookup. Writers that
     * don't implement it fall back to the probe path.
     */
    lookupById?: (id: string, expectedTable?: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;
    patch: (id: string, patch: Record<string, unknown>, expectedTable?: string) => Promise<void>;
    patchMany: (
        patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>,
        options?: { limit?: number },
        expectedTable?: string,
    ) => Promise<{ patched: number }>;
    patchWhere?: (tableName: string, args: { patch: Record<string, unknown>; where: WhereInput }, options?: { limit?: number }) => Promise<{ patched: number }>;
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

    /**
     * Cross-shard companion to `rankPage`: same ranked slice, but each row
     * keeps its rank-key tuple for the query coordinator's k-way merge. Same
     * count-of-partition RLS hazard as `rankPage` — failed closed under a read
     * policy for the identical reason (see `rankPage` above).
     */
    rankPageRows?: (tableName: string, indexName: string, options?: RankPageArgs) => Promise<ShardRankPageResultLike>;
    replace: (id: string, document: Record<string, unknown>, expectedTable?: string) => Promise<void>;
    restore?: (id: string, expectedTable?: string) => Promise<void>;

    /**
     * Whole-shard erase. The RLS wrapper deliberately **fails this closed** rather
     * than wrapping it — see the wrapper's `wipeShard`.
     */
    wipeShard?: (options?: { chunkSize?: number; exclude?: ReadonlyArray<string>; tables?: ReadonlyArray<string> }) => Promise<{
        deleted: number;
        tables: Record<string, number>;
    }>;
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

/**
 * Mirror of `@lunora/do`'s batch-write cap. The middleware's `deleteMany` /
 * `patchMany` loop per-id (locating + policy-checking each row routes some ids
 * through `raw` and others through `base`), so they never delegate to the
 * underlying writer's batch method — meaning that writer's own cap check never
 * runs. We re-enforce it here so the limit holds on the RLS path too. Keep this
 * value in sync with `DEFAULT_BATCH_LIMIT` in `@lunora/do`'s `ctx-db.ts`
 * (the two packages share no code, so the constant is duplicated by necessity).
 */
const DEFAULT_BATCH_LIMIT = 500;

const assertBatchLimit = (count: number, limit: number | undefined, op: string): void => {
    const cap = limit ?? DEFAULT_BATCH_LIMIT;

    if (count > cap) {
        // `BATCH_LIMIT_EXCEEDED`, matching the writer's own cap in
        // `@lunora/shard-engine`'s `ctx-db.ts`. This threw `BAD_REQUEST` while the
        // message and the cap were byte-identical, so a client catching
        // `err.code === "BATCH_LIMIT_EXCEEDED"` to chunk-and-retry worked against
        // a plain table and silently failed to match under a `.rls("required")`
        // schema — same status, same text, different code. `@lunora/server`'s own
        // types document that code as the one a caller reasons about.
        throw new LunoraError(
            "BATCH_LIMIT_EXCEEDED",
            `${op}: batch of ${String(count)} exceeds the limit of ${String(cap)} (raise options.limit or chunk the call)`,
            { status: 400 },
        );
    }
};

/**
 * The slice of `ctx.auth` the policy middlewares read.
 *
 * `roles` has TWO sources and the effective list is their union, because the two
 * answer different questions and neither subsumes the other.
 *
 * The `roles` CLAIM on the resolved identity ({@link readIdentityRoles}) is what
 * the identity provider asserted about the caller. `ctx.auth.roles`, set by an
 * upstream middleware, is what a request-time mapping derived.
 *
 * Reading only the claim silently drops the second, which does not fail loudly —
 * a role-gated ALLOW branch stops firing and users lose access, and a role-gated
 * DENY branch stops firing and rows LEAK. A middleware declares its own context
 * type, so there is no compile-time signal either way.
 *
 * The middleware source reaches THIS path only. A live shape runs no procedure,
 * so `composeShapeReadWhere` sees the claim and nothing else — which is why the
 * shipped Access mapping mints its roles onto the identity
 * (`createAccessResolver({ roles })`) instead of into `ctx.auth.roles`. Anything
 * deriving roles in middleware must accept that shapes will not see them; see
 * the KNOWN DIVERGENCE note in `./shape-read-base`.
 *
 * What is deliberately absent is the same field on the TEST harness: see
 * `TestIdentity` in `./testing`. A middleware setting `ctx.auth.roles` is a real
 * request-path producer; a test setting it directly is a world with no producer
 * at all, which is how role-gated policies passed their tests while evaluating
 * against an empty list in production.
 */
type AuthLike = {
    getIdentity?: () => Promise<Record<string, unknown> | null>;
    /** Role labels contributed by an upstream middleware, unioned with the identity's `roles` claim. */
    roles?: ReadonlyArray<string>;
    userId?: null | string;
};

/** Minimal shape the middleware needs on the incoming ctx. */
interface RlsContextIn {
    auth?: AuthLike;
    db: RlsDatabase;
}

/** Sentinel `WhereInput` that compiles to a vacuously-false predicate. See `./predicates`. */
const FALSE_PREDICATE: WhereInput = deny();

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
 * SQL NULL, as a document sees it: an explicit `null` and an absent column are
 * the same missing value (what the `isNull` operator has always treated them as).
 */
const isSqlNull = (value: unknown): boolean => value === null || value === undefined;

/**
 * Read an `in`/`notIn` operand as a list, refusing anything else.
 *
 * Mirrors the SQL compiler's `compileInList`, which throws for exactly this
 * reason: a scalar there compiled to `1 = 1` and dropped the restriction. The JS
 * evaluator's `notIn` used to do the same silently — a policy written to keep
 * `admin` rows out admitted one on WRITE — while the same predicate on a SQL
 * read raised `BAD_REQUEST`. Refused rather than widened to a one-element list,
 * so a caller never gets a predicate whose meaning depends on a coercion they
 * did not ask for.
 */
const operandList = (field: string, operator: "in" | "notIn", value: unknown): ReadonlyArray<unknown> => {
    if (!Array.isArray(value)) {
        throw new LunoraError("BAD_REQUEST", `\`${operator}\` on "${field}" expects an array of values, received ${value === null ? "null" : typeof value}`);
    }

    return value as ReadonlyArray<unknown>;
};

/**
 * Evaluate the membership + text comparators (`in`/`notIn`/`contains`/`isNull`)
 * of an operator bag. Returns `true` when the value satisfies all present ones.
 */
const matchesMembershipOperators = (field: string, documentValue: unknown, operators: Record<string, unknown>): boolean => {
    if ("in" in operators && !operandList(field, "in", operators["in"]).includes(documentValue)) {
        return false;
    }

    if ("notIn" in operators) {
        const list = operandList(field, "notIn", operators["notIn"]);

        // Three-valued logic, verified against SQLite: `x NOT IN (…)` is UNKNOWN
        // — so the row is excluded — whenever `x` is NULL or the list holds a
        // NULL and `x` matched nothing. An EMPTY list is the exception: it
        // compiles to `1 = 1`, which admits a NULL cell like any other.
        if (list.length > 0 && (isSqlNull(documentValue) || list.includes(documentValue) || list.some((item) => isSqlNull(item)))) {
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

        if (expectsNull !== isSqlNull(documentValue)) {
            return false;
        }
    }

    return true;
};

/**
 * Evaluate the equality comparators (`eq`/`ne`) of an operator bag under SQL's
 * three-valued logic, which the SQL compiler's `compileComparator` renders
 * directly.
 *
 * A `null` operand folds to `IS NULL` / `IS NOT NULL` — the only shape that
 * matches (or excludes) a NULL cell at all. Against any other operand a NULL
 * cell yields UNKNOWN and is therefore EXCLUDED; a plain `!==` admitted it
 * instead, which on a write policy meant a row whose column was NULL passed a
 * check the same predicate failed as SQL.
 */
const matchesEqualityOperators = (documentValue: unknown, operators: Record<string, unknown>): boolean => {
    if ("eq" in operators) {
        const operand = operators["eq"];

        if (operand === null ? !isSqlNull(documentValue) : documentValue !== operand) {
            return false;
        }
    }

    if ("ne" in operators) {
        const operand = operators["ne"];

        if (operand === null ? isSqlNull(documentValue) : isSqlNull(documentValue) || documentValue === operand) {
            return false;
        }
    }

    return true;
};

/**
 * Evaluate an operator bag (`{ eq, ne, in, … }`) against a single document
 * value. Mirrors the SQL compiler's operator set, including its NULL semantics:
 * the ordered comparators are gated by {@link isOrderable}, `eq`/`ne` by
 * {@link matchesEqualityOperators}, `in`/`notIn` by
 * {@link matchesMembershipOperators}. `field` is carried only to name the column
 * in the error a malformed `in`/`notIn` operand raises. Returns `true` when the
 * value satisfies every operator in the bag.
 */
const matchesOperators = (field: string, documentValue: unknown, operators: Record<string, unknown>): boolean =>
    matchesEqualityOperators(documentValue, operators) &&
    matchesMembershipOperators(field, documentValue, operators) &&
    matchesOrderedOperators(documentValue, operators);

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

        return isRelationPredicate(value);
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
            if (!matchesOperators(key, documentValue, value)) {
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
 * WITH-CHECK pass for a single policy whose USING (pre-image) decision already
 * passed: re-run `policy.when` with the post-image row substituted for
 * `context.row` and report whether the resulting row still qualifies. This
 * lifts the post-image guard the `WhereInput` branch already performs to the
 * boolean / relation-decision cases, where the pre-image verdict says nothing
 * about a column the patch reassigns.
 *
 * - `undefined` / `true` → the post-image qualifies (policy opts out / allows).
 * - `false` → the post-image is rejected.
 * - relation predicate → unsupported in write policies (loud, mirrors USING).
 * - `WhereInput` → the post-image must match the predicate.
 */
const satisfiesPostImage = <Context>(policy: Policy<Context>, context: PolicyContext<Context>, nextRow: Record<string, unknown>): boolean => {
    const postDecision = policy.when({ ...context, row: nextRow });

    if (postDecision === undefined || postDecision === true) {
        return true;
    }

    if (postDecision === false) {
        return false;
    }

    if (containsRelationPredicate(postDecision)) {
        throw new LunoraError(
            "RELATION_PREDICATE_UNSUPPORTED",
            "relation predicates are not supported in write policies; use a read policy or a flat column check",
        );
    }

    return matchesWhere(nextRow, postDecision);
};

/**
 * Evaluate a single write policy's USING (pre-image) decision plus, when a
 * post-image is supplied, its WITH-CHECK. Returns `true` to allow this policy,
 * `false` to deny; throws on a relation predicate (unsupported in write
 * policies). Pulled out of {@link evaluateWrite}'s loop so each branch stays
 * flat.
 */
const evaluateWritePolicy = <Context>(policy: Policy<Context>, context: PolicyContext<Context>, nextRow?: Record<string, unknown>): boolean => {
    const decision = policy.when(context);

    if (decision === undefined || decision === true) {
        // USING passed (or opted out). For updates we still enforce the
        // WITH-CHECK post-image: a boolean policy (e.g. `row.ownerId ===
        // userId`) reads the PRE-image, so an `undefined`/`true` here only says
        // the old row qualified — it can't catch a patch that reassigns the
        // very column the policy depends on. Re-evaluate the same policy against
        // the post-image and deny if the resulting row no longer qualifies,
        // matching the `WhereInput` branch's semantics below.
        return nextRow === undefined || satisfiesPostImage(policy, context, nextRow);
    }

    if (decision === false) {
        return false;
    }

    // Relation-crossing predicates need a child fetch the in-memory evaluator
    // can't perform — reject loudly instead of silently denying.
    if (containsRelationPredicate(decision)) {
        throw new LunoraError(
            "RELATION_PREDICATE_UNSUPPORTED",
            "relation predicates are not supported in write policies; use a read policy or a flat column check",
        );
    }

    // WhereInput predicate — the row qualifies only if it matches. Without a
    // row to evaluate against we deny (safer default; in practice the wrapper
    // always supplies the candidate or pre-write row, so this is defensive).
    if (!context.row || !matchesWhere(context.row, decision)) {
        return false;
    }

    // WITH CHECK: the resulting row must also satisfy the policy, so an update
    // cannot reassign the row out of the caller's tenant.
    return nextRow === undefined || matchesWhere(nextRow, decision);
};

/**
 * Evaluate write policies for a `(table, op)` pair. Returns `true` to allow
 * the write, `false` to deny. The convention is "every matching write policy
 * must allow" — the most restrictive policy wins, mirroring SQL RLS.
 *
 * Decision semantics (per policy, see {@link evaluateWritePolicy}):
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
 * WITH CHECK: for update ops the policy is evaluated against BOTH the pre-write
 * row (USING) and, when supplied, the post-image `nextRow` (WITH CHECK) so it
 * cannot be satisfied by the old row while the patch reassigns the row to
 * another tenant. This holds for `WhereInput` predicates AND boolean policies
 * (e.g. `row.ownerId === userId`) — the boolean is re-derived from the
 * post-image, not just the pre-image, via {@link satisfiesPostImage}.
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

        if (!evaluateWritePolicy(policy, context, nextRow)) {
            return false;
        }
    }

    // Participating table, no matching write policy for this op → deny.
    return sawWritePolicy;
};

/** The complete set of own keys a `CountArgs` options bag may carry. */
const COUNT_ARGS_KEYS = new Set(["baseWhere", "relationBaseWhere", "restrictsCounts", "where"]);

/**
 * Whether `value` carries the options type expected for `CountArgs` key `key`:
 * `restrictsCounts` is a boolean, `relationBaseWhere` a function, and
 * `where`/`baseWhere` a `WhereInput` object. `undefined` always passes (an
 * explicitly-undefined option is still an option). A scalar/operator-bag value
 * under a reserved-looking key means the caller named a column, not an option.
 */
const isCountArgsValue = (key: string, value: unknown): boolean => {
    if (value === undefined) {
        return true;
    }

    if (key === "restrictsCounts") {
        return typeof value === "boolean";
    }

    if (key === "relationBaseWhere") {
        return typeof value === "function";
    }

    // `where` / `baseWhere` carry a `WhereInput` tree — an object.
    return isPlainObject(value);
};

/**
 * Distinguish a `CountArgs` options bag from a legacy `count(table, where)`
 * `WhereInput` whose predicate happens to name a column `where` / `baseWhere` /
 * `restrictsCounts`. A real options bag is shaped like options, not like a
 * field predicate: it is non-empty, every own key is a known `CountArgs` key,
 * AND every value carries the options type (see {@link isCountArgsValue}). A
 * `WhereInput` such as `{ where: "draft" }` (scalar value) or
 * `{ restrictsCounts: { gt: 3 } }` (column named `restrictsCounts` with an
 * operator bag) fails the shape check and is treated as the predicate it is.
 */
const looksLikeCountArgs = (argument: Record<string, unknown>): boolean => {
    const keys = Object.keys(argument);

    if (keys.length === 0) {
        return false;
    }

    return keys.every((key) => COUNT_ARGS_KEYS.has(key) && isCountArgsValue(key, argument[key]));
};

/**
 * Tolerantly read the count argument: either a `WhereInput` (legacy) or a
 * `CountArgs` options bag. We never strip caller-supplied `baseWhere`; we
 * AND-merge the RLS one on top.
 */
const intoCountArgs = (argument: CountArgs | undefined | WhereInput): CountArgs => {
    if (argument === undefined) {
        return {};
    }

    if (isPlainObject(argument) && looksLikeCountArgs(argument)) {
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
     * Route a READ to the writer that should service it. Uses `raw` (bypassing the
     * secure-by-default guard) only when the table has an active `on:"read"` policy
     * — i.e. `readBase(table).restricts` is true — because that read is authorized
     * and filtered by the policy `baseWhere`. Otherwise it routes to the guarded
     * `base`: a protected table that appears in the bundle only via a WRITE policy
     * has no read policy, so it must fail closed under `.rls("required")` rather
     * than returning every row unfiltered, while a `.public()` table passes
     * through. This keeps read routing in fail-closed parity with `guardWriter` and
     * `shape-read-base.ts`; writes route via `gateById`/insert, not this router.
     */
    const route = (tableName: string): RlsDatabase => (readBase(tableName).restricts ? raw : base);

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
     * - **Fast path** — when the writer implements the optional `lookupById`
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
        if (raw.lookupById) {
            // Pin the lookup to the bound table when the by-id facade forwards
            // one, so a foreign id resolves to "absent" rather than another
            // table's row (IDOR). Read through the UNGUARDED `raw` writer: this
            // is a policy-evaluation probe, not caller-visible data, so it must
            // not be denied by the secure-by-default guard.
            const located = await raw.lookupById(id, expectedTable);

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
                // Reject the denied write with FORBIDDEN — the intended, tested
                // contract for an authorized-but-policy-denied mutation. SECURITY:
                // do NOT interpolate the owning table name into the message (it was
                // formerly `${op} on "${located.tableName}" denied by policy`) — an
                // attacker holding a candidate id could otherwise learn which table
                // a hidden record lives in. The generic message is table-agnostic.
                throw new LunoraError("FORBIDDEN", `${op} denied by policy`);
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

    // `rankBefore`/`rankPageRows` are the two analytical methods that may be
    // absent (the D1/sql-store twin omits both) — captured here so
    // `optionalWriterOverride` below can narrow each without a non-null assertion.
    const baseRankBefore = base.rankBefore;
    const baseRankPageRows = base.rankPageRows;

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

        delete: (id, expectedTable, options) => gateById(id, "delete", (writer) => writer.delete(id, expectedTable, options), undefined, expectedTable),

        async deleteAll(tableName, options) {
            // Chunked erase, RLS-honest: rows are resolved through the read-filtered
            // reader (so a row a policy hides is never touched) and each id is gated
            // exactly like a single `delete()`. Delegating to the underlying writer's
            // `deleteAll` would bypass both — it loops its OWN raw `delete`, not this
            // wrapper's — so this override is load-bearing, not a convenience.
            const chunkSize = Math.max(1, options?.chunkSize ?? DEFAULT_BATCH_LIMIT);
            const { baseWhere } = readBase(tableName);
            let deleted = 0;

            for (;;) {
                // eslint-disable-next-line no-await-in-loop -- chunked by design: one policy-visible page at a time
                const resolved = await route(tableName).findMany(tableName, {
                    baseWhere,
                    limit: chunkSize,
                    relationBaseWhere: relationReadFilter,
                });
                const ids = resolved.page.map((row) => String(row["_id"]));

                if (ids.length === 0) {
                    break;
                }

                for (const id of ids) {
                    // `expectedTable` is deliberately NOT pinned. Pinning it would block
                    // the writer's global fallback, so every delete on a `.global()`
                    // table would be a silent no-op — inflating the count while the rows
                    // survive. It costs nothing here: these ids came from this table's
                    // own policy-filtered read, so they are provably its rows, and
                    // `gateById` still resolves each row's real table and applies that
                    // table's delete policy. Same reasoning as `deleteWhere`, which hands
                    // its ids to `deleteMany` unpinned.
                    // eslint-disable-next-line no-await-in-loop -- sequential per-row policy gate, mirrors looped single deletes
                    await gateById(id, "delete", (writer) => writer.delete(id, undefined, options?.hard === undefined ? undefined : { hard: options.hard }));
                    deleted += 1;
                }

                if (ids.length < chunkSize) {
                    break;
                }
            }

            return { deleted };
        },

        async deleteMany(ids, options, expectedTable) {
            assertBatchLimit(ids.length, options?.limit, "deleteMany");

            // Per-id gate: each id is located + policy-checked and routed to the
            // writer that should service it (raw for a policy table, base for a
            // guarded/public one). A denial throws; in a mutation the DO's
            // BEGIN/COMMIT span rolls the whole batch back, in an action
            // (no span) prior deletes persist. Sequential to match the per-row
            // semantics of N `delete()` calls; `expectedTable` (the facade's bound
            // table) scopes each id.
            for (const id of ids) {
                // eslint-disable-next-line no-await-in-loop -- sequential per-row policy gate, mirrors looped single deletes
                await gateById(id, "delete", (writer) => writer.delete(id, expectedTable), undefined, expectedTable);
            }

            return { deleted: ids.length };
        },

        async deleteWhere(tableName, where, options) {
            // Where-based delete: resolve matching rows through the RLS-filtered
            // reader so hidden rows are excluded, then gate each id like a single
            // delete. The read + writes share the mutation-span (if any).
            const { baseWhere } = readBase(tableName);
            const resolved = await route(tableName).findMany(tableName, {
                baseWhere: mergeBaseWhere(where, baseWhere),
                relationBaseWhere: relationReadFilter,
            });
            const ids = resolved.page.map((row) => String(row["_id"]));

            assertBatchLimit(ids.length, options?.limit, "deleteWhere");

            return wrapped.deleteMany(ids, options);
        },

        async findFirst(tableName, args) {
            const { baseWhere } = readBase(tableName);

            return route(tableName).findFirst(tableName, {
                ...args,
                baseWhere: mergeBaseWhere(args?.baseWhere, baseWhere),
                relationBaseWhere: relationReadFilter,
            });
        },

        async findFirstOrThrow(tableName, args) {
            const { baseWhere } = readBase(tableName);

            return route(tableName).findFirstOrThrow(tableName, {
                ...args,
                baseWhere: mergeBaseWhere(args?.baseWhere, baseWhere),
                relationBaseWhere: relationReadFilter,
            });
        },

        async findMany(tableName, args) {
            const { baseWhere } = readBase(tableName);

            return route(tableName).findMany(tableName, {
                ...args,
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

            // The owning table participates in the bundle but has NO active read
            // policy (e.g. it only carries a write/insert policy). `located.row` was
            // read through the UNGUARDED `raw` writer, so returning it here would
            // bypass the secure-by-default guard and leak every row of a protected
            // table. Defer to the GUARDED `base.get` instead: a protected table
            // fails closed under `.rls("required")` and a `.public()` one returns
            // the row. Mirrors the `route`/`readRoute` fail-closed parity.
            if (!restricts) {
                return base.get(id, expectedTable);
            }

            // The owning table participates in RLS and the read policy grants
            // unconditionally (`true` predicate → no `baseWhere`) → return the row.
            if (!baseWhere) {
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

        // Same locate + readBase shape as `get` above, but returns the seam's
        // `{ row, tableName }` pair rather than a bare row — this is the fast
        // path `locateRow` itself probes via `raw.lookupById`, so the wrapped
        // writer must apply the identical policy check before handing a row
        // back, not just pass the raw seam through (the `...base` spread would
        // otherwise expose `base.lookupById` unfiltered by any read policy).
        async lookupById(id, expectedTable) {
            const located = await locateRow(id, expectedTable);

            if (!located.row) {
                // eslint-disable-next-line unicorn/no-null -- mirrors get()'s absent-row null
                return null;
            }

            // Row exists but isn't in any policy-gated table, or the owning
            // table has no active read policy: defer to the GUARDED
            // `base.lookupById` (secure-by-default for a protected table,
            // pass-through for `.public()`), exactly like `get` defers to
            // `base.get` in the same two cases.
            if (located.tableName === undefined || !readBase(located.tableName).restricts) {
                // eslint-disable-next-line unicorn/no-null -- mirrors the seam's own `null`-for-absent contract
                return (await base.lookupById?.(id, expectedTable)) ?? null;
            }

            const { baseWhere } = readBase(located.tableName);

            // Read policy grants unconditionally (`true` predicate, no baseWhere).
            if (!baseWhere) {
                return { row: located.row, tableName: located.tableName };
            }

            // Policy check: re-fetch WITH baseWhere on the owning table, through
            // the UNGUARDED `raw` writer (a policy table — the guard would deny
            // it). `null` here is the policy verdict ("denied"), not a fall
            // through to the unguarded row.
            const allowed = await raw.findFirst(located.tableName, { baseWhere, limit: 1, where: { _id: id } });

            // eslint-disable-next-line unicorn/no-null -- null is the deliberate "denied" verdict, mirroring get()
            return allowed?.["_id"] === id ? { row: allowed, tableName: located.tableName } : null;
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

        async insertMany(tableName, documents, options) {
            // Enforced up-front for parity with deleteMany/patchMany (and so the
            // cap survives if this path is ever refactored away from delegating to
            // the writer's own batch method, which re-checks it today).
            assertBatchLimit(documents.length, options?.limit, "insertMany");

            const policies = perTable.get(tableName);

            if (policies) {
                // Evaluate the insert policy against each candidate row, then
                // delegate the whole batch to the UNGUARDED `raw` writer (whose
                // batch method re-checks the payload cap). A single denial throws;
                // in a mutation the DO's BEGIN/COMMIT span rolls the whole batch
                // back, in an action (no span) prior inserts persist.
                for (const document of documents) {
                    const writeOk = evaluateWrite(policies, "insert", { ...context, row: document });

                    if (!writeOk) {
                        throw new LunoraError("FORBIDDEN", `insert on "${tableName}" denied by policy`);
                    }
                }

                return raw.insertMany(tableName, documents, options);
            }

            // Non-policy table → GUARDED `base` enforces secure-by-default.
            return base.insertMany(tableName, documents, options);
        },

        async insertManyUnsafe(tableName, documents, options) {
            assertBatchLimit(documents.length, options?.limit, "insertManyUnsafe");

            const policies = perTable.get(tableName);

            if (policies) {
                // "Unsafe" skips per-row validators/triggers at the writer, NOT the
                // insert policy: each candidate row is still authorized here before
                // the batch routes to the UNGUARDED `raw` writer. (Overriding this is
                // mandatory — the `...base` spread would otherwise expose the guard's
                // version, which checks only the table, skipping the row policy.)
                for (const document of documents) {
                    const writeOk = evaluateWrite(policies, "insert", { ...context, row: document });

                    if (!writeOk) {
                        throw new LunoraError("FORBIDDEN", `insert on "${tableName}" denied by policy`);
                    }
                }

                return raw.insertManyUnsafe(tableName, documents, options);
            }

            // Non-policy table → GUARDED `base` enforces secure-by-default.
            return base.insertManyUnsafe(tableName, documents, options);
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

        async patchMany(patches, options, expectedTable) {
            assertBatchLimit(patches.length, options?.limit, "patchMany");

            // Per-id update gate, same WITH-CHECK post-image semantics as the
            // single patch. Sequential; in a mutation the DO's BEGIN/COMMIT span
            // rolls the whole batch back on a denial, in an action (no
            // span) prior patches persist. `expectedTable` scopes each id.
            for (const entry of patches) {
                // eslint-disable-next-line no-await-in-loop -- sequential per-row policy gate, mirrors looped single patches
                await gateById(
                    entry.id,
                    "update",
                    (writer) => writer.patch(entry.id, entry.patch, expectedTable),
                    (preRow) => {
                        return { ...preRow, ...entry.patch };
                    },
                    expectedTable,
                );
            }

            return { patched: patches.length };
        },

        async patchWhere(tableName, args, options) {
            // Where-based patch: resolve matching rows through the RLS-filtered
            // reader so hidden rows are excluded, then gate each id like a single
            // patch. The read + writes share the mutation-span (if any).
            const { baseWhere } = readBase(tableName);
            const resolved = await route(tableName).findMany(tableName, {
                baseWhere: mergeBaseWhere(args.where, baseWhere),
                relationBaseWhere: relationReadFilter,
            });
            const patches = resolved.page.map((row) => {
                return { id: String(row["_id"]), patch: args.patch };
            });

            assertBatchLimit(patches.length, options?.limit, "patchWhere");

            return wrapped.patchMany(patches, options);
        },

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

        // Restore clears the soft-delete marker — a by-id un-delete, gated as an
        // "update" (the policy that governs patch). No post-image check: the
        // writer owns the marker field, so we only enforce the pre-image USING.
        restore: (id, expectedTable) =>
            gateById(
                id,
                "update",
                async (writer) => {
                    const perform = writer.restore ?? raw.restore;

                    if (!perform) {
                        throw new LunoraError("BAD_REQUEST", "restore is not supported by this writer");
                    }

                    await perform(id, expectedTable);
                },
                undefined,
                expectedTable,
            ),

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

        wipeShard() {
            // Fails closed on purpose. `wipeShard` enumerates the schema's tables,
            // which this module deliberately cannot see (it matches the writer
            // structurally, not through `@lunora/do`), so it cannot gate the sweep
            // per row. And "erase everything I'm allowed to see" is not a meaningful
            // erasure contract — a read policy hiding rows would silently leave them
            // behind, which is precisely the guarantee the caller wanted.
            //
            // Account deletion is a privileged operation: run it from an
            // `internalMutation` (no RLS middleware), or erase the specific tables
            // with `ctx.db.deleteAll(table)`, which IS gated per row.
            throw new LunoraError(
                "FORBIDDEN",
                "ctx.db.wipeShard() is unavailable under rls(): a whole-shard erase can't be policy-gated per row, and erasing only policy-visible rows would silently leave data behind. Run it from an internalMutation, or use ctx.db.deleteAll(table) per table.",
                { status: 403 },
            );
        },

        // `rankBefore`/`rankPageRows` are the two optional methods (the D1/sql-store
        // twin omits both) — see `optionalWriterOverride`. `rankPageRows` fails
        // closed for the same reason `rankPage` does: its rows carry partition
        // rank keys that cannot be reduced under a row policy.
        ...optionalWriterOverride("rankBefore", baseRankBefore, (rankBefore) => (tableName: string, indexName: string, options: RankBeforeArgs) => {
            requireUnrestrictedReadBase(tableName, "rankBefore");

            // Route to the policy/non-policy writer; both carry `rankBefore` when `base` does (the guard spreads `raw`).
            const target = route(tableName);

            return (target.rankBefore ?? rankBefore)(tableName, indexName, options);
        }),
        ...optionalWriterOverride("rankPageRows", baseRankPageRows, (rankPageRows) => (tableName: string, indexName: string, options?: RankPageArgs) => {
            const baseWhere = requireUnrestrictedReadBase(tableName, "rankPageRows");

            // Route to the policy/non-policy writer; both carry `rankPageRows` when `base` does (the guard spreads `raw`).
            const target = route(tableName);

            return (target.rankPageRows ?? rankPageRows)(tableName, indexName, {
                ...options,
                baseWhere: mergeBaseWhere(options?.baseWhere, baseWhere),
            });
        }),
    };

    // SECURITY: the generated runtime glues a per-table facade
    // (`ctx.db.messages.findMany(...)`, codegen's `bindTableFacade`) onto
    // `ctx.db`, bound to the UNWRAPPED writer. The `...base` spread above copies
    // those raw-bound accessors verbatim, so without this loop a policy table's
    // facade would read around RLS (and around the `count`/rank fail-closed
    // guards). Re-bind the policy tables to route through the wrapped writer,
    // using the SAME `bindTableFacade` codegen emits so the two can't drift.
    //
    // EVERY facade entry is re-bound, not just the policy tables'.
    //
    // A non-policy table needs no RLS of its OWN, but every wrapped read threads
    // `relationBaseWhere` — which is what applies a policy to `with`-hydrated
    // CHILDREN. Left on its raw binding, `ctx.db.<nonPolicyTable>.findMany({
    // with: { <policyTable>: true } })` reached the unwrapped writer with no
    // relation filter and returned child rows the policy exists to hide. The
    // flat `ctx.db.findMany("<nonPolicyTable>", …)` form was guarded the whole
    // time, so only the idiomatic form leaked.
    //
    // The old exemption was justified on the grounds that a `.global()` table's
    // entry is bound to the D1 `globalDb` writer and re-binding it would query
    // the wrong backend. That premise is false: `packages/codegen/src/emit.ts`
    // binds every table's facade through the one shard ctx-db, `.global()`
    // included, precisely because `createShardCtxDb` routes global ops to D1
    // internally and stamps the subscription hooks — binding a global facade
    // straight to `globalDb` would skip both. There is no wrong backend here.
    //
    // Gated on there being any policy at all, so an `rls([])` chain still leaves
    // the runtime's own bindings untouched.
    const writableFacade = wrapped as unknown as Record<string, unknown>;

    if (perTable.size > 0) {
        for (const [tableName, entry] of Object.entries(base as unknown as Record<string, unknown>)) {
            if (isFacadeEntry(entry)) {
                writableFacade[tableName] = bindTableFacade(wrapped, tableName);
            }
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

/**
 * Build the `can(...)` lookup for a request: union the permissions granted by
 * every role the request carries, once per protected procedure, so `can(...)`
 * inside policies is a Set lookup.
 */
const resolveCan = (
    roles: ReadonlyArray<string>,
    rolePermissions: ReadonlyMap<string, ReadonlySet<string>>,
): ((permission: Permission | string) => boolean) => {
    const granted = new Set<string>();

    for (const roleName of roles) {
        for (const name of rolePermissions.get(roleName) ?? []) {
            granted.add(name);
        }
    }

    return (permission) => granted.has(permissionName(permission));
};

/**
 * The identity claim that carries a request's role labels.
 *
 * Roles have exactly ONE source: the `roles` claim on the identity that
 * `WorkerOptions.resolveIdentity` returned (`@lunora/runtime`'s
 * `ResolvedIdentity` forwards every non-`userId` key verbatim, and
 * `defineIdentity(...)` validates them at the worker's trust boundary before
 * they become `ctx.auth`). There is no second, context-level `roles` field to
 * disagree with it — see {@link AuthLike}.
 */

/**
 * The identity claims that carry role labels, in precedence order.
 *
 * Both, not just `roles`. `@lunora/auth` mirrors better-auth's `admin()` plugin,
 * which stores a multi-role value comma-joined in a SINGULAR `role` column
 * (`serializeRole`) — so an app forwarding its user record verbatim produces a
 * `role` claim and no `roles` claim at all. Reading only the plural name meant
 * the framework's own auth stack resolved to no roles, which is the shape of
 * "documented feature nothing can reach".
 */
const IDENTITY_ROLES_CLAIMS = ["roles", "role"] as const;

/**
 * Read the request's role labels off the resolved identity claims.
 *
 * Reads {@link IDENTITY_ROLES_CLAIMS}, accepting the two shapes a resolver
 * realistically produces: a string array, or a comma-separated string (the form
 * better-auth's `admin()` plugin stores a multi-role value in — see
 * `serializeRole` in `@lunora/auth`). Anything else — including an absent claim
 * — is no roles, so `auth.can(...)` fails closed.
 *
 * SECURITY: this trusts the identity a resolver returns. Under `composeResolvers`
 * that identity may have been minted by an adapter this app did not write, and
 * `defineIdentity` forwards undeclared claims verbatim — so a resolver must not
 * forward a `role`/`roles` field the END USER can edit (a profile column, say).
 * That is privilege escalation, and it is the same hazard
 * `@lunora/cloudflare-access` documents for the `groups` claim. Roles belong to
 * a field only an administrator can write.
 *
 * Shared by the request path ({@link resolvePolicyAuth}), the shape path
 * (`shape-read-base.ts`) and the test harness (`./testing`), so all three can
 * only ever express a role set the runtime can actually produce.
 */
const readIdentityRoles = (identity: Record<string, unknown> | null | undefined): ReadonlyArray<string> => {
    for (const name of IDENTITY_ROLES_CLAIMS) {
        const claim = identity?.[name];

        if (typeof claim === "string") {
            const roles = claim
                .split(",")
                .map((role) => role.trim())
                .filter((role) => role.length > 0);

            if (roles.length > 0) {
                return roles;
            }
        }

        if (Array.isArray(claim)) {
            const roles = claim.filter((role): role is string => typeof role === "string" && role.length > 0);

            if (roles.length > 0) {
                return roles;
            }
        }
    }

    return [];
};

/**
 * Resolve the request's `auth` view for a policy/mask/storage-rule context.
 * Identity is resolved once per protected procedure so policies can branch on
 * claims (`ctx.auth.identity.email` etc.) without each policy paying for its
 * own `getIdentity()` call; `null` covers both the anonymous case and the
 * no-resolver case (older auth states). `roles` is the UNION of the identity's
 * `roles` claim ({@link readIdentityRoles}) and any `ctx.auth.roles` an upstream
 * middleware contributed — see {@link AuthLike} for why both are needed. Shared
 * verbatim by the rls, mask and storage-rules middlewares so the three resolve
 * identity and grants identically.
 */
const resolvePolicyAuth = async (
    auth: AuthLike,
    rolePermissions: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<{
    can: (permission: Permission | string) => boolean;
    identity: Record<string, unknown> | null;
    roles: ReadonlyArray<string>;
    userId: null | string;
}> => {
    // eslint-disable-next-line unicorn/no-null -- the public auth contexts carry `null` for the anonymous/no-resolver case
    const identity = (await auth.getIdentity?.()) ?? null;
    // Union, not either/or — see `AuthLike`. A Set dedups while preserving
    // first-seen order.
    const roles: ReadonlyArray<string> = [...new Set<string>([...readIdentityRoles(identity), ...(auth.roles ?? [])])];

    return {
        can: resolveCan(roles, rolePermissions),
        identity,
        roles,
        // eslint-disable-next-line unicorn/no-null -- the public auth contexts type userId as `null | string`
        userId: auth.userId ?? null,
    };
};

const rls = <Context extends RlsContextIn = RlsContextIn>(policies: ReadonlyArray<Policy<Context>>, options: RlsOptions = {}): Middleware<Context, Context> => {
    const perTable = indexByTable(policies);
    const rolePermissions = indexRolePermissions(options.roles);

    const middleware: Middleware<Context, Context> = async ({ ctx, next }) => {
        const policyContext: PolicyContext<Context> = { auth: await resolvePolicyAuth(ctx.auth ?? {}, rolePermissions), ctx };

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

    // Surface the policies + roles on the middleware so the procedure builder
    // can hoist them onto the registered function — the local-first shape path
    // composes a `defineShape` predicate with the table's read base-where from
    // these (see `shape-read-base.ts`). Cast to the erased `Policy<unknown>`
    // the tag stores; the closures are evaluated against a structurally-built
    // PolicyContext, exactly like this middleware does at request time.
    return tagRlsMiddleware(middleware, [{ policies: policies as ReadonlyArray<Policy>, roles: options.roles ?? [] }]);
};

export { rls };

export type { RlsDatabase };

/**
 * Internal policy-evaluation primitives, exported for the in-process RLS test
 * harness (`@lunora/server/rls/testing`) and the sibling mask/storage-rules
 * middlewares so they evaluate policies and resolve identity through the exact
 * same logic this middleware uses at request time — never a parallel
 * re-implementation that could drift. Not part of the package's public API; the
 * package root does not re-export them.
 * @internal
 */
export {
    computeReadBaseWhere,
    evaluateWrite,
    indexRolePermissions,
    isFacadeEntry,
    matchesWhere,
    permissionName,
    readIdentityRoles,
    resolveCan,
    resolvePolicyAuth,
};
export type { AuthLike };
