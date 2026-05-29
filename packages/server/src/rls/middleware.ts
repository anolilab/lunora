/**
 * `rls(policies)` — the procedure-builder middleware that activates
 * Row-Level Security for the downstream handler.
 *
 * What it does, at runtime:
 *
 *  1. **Reads** — wraps `ctx.db.findMany`/`findFirst`/`findFirstOrThrow`/
 *     `query`/`count`/`get`. Per table with a `read` policy, builds the
 *     effective `baseWhere` (intersection of role-applicable predicates) and
 *     threads it through the underlying ORM via the public
 *     `QueryArgs.baseWhere` seam (see `@cirrus/do/src/query-args.ts`). Also
 *     sets `restrictsCounts: true` for the same tables, so `count()` throws
 *     `COUNT_RLS_UNSUPPORTED` (kitcn's documented constraint).
 *
 *  2. **Writes** — wraps `insert`/`patch`/`replace`/`delete`. For an
 *     `update`/`delete` it fetches the pre-write row through the *unwrapped*
 *     writer (RLS doesn't apply to the policy evaluator itself, only to the
 *     caller-visible reader) and runs the matching write policy with `row`
 *     set; for `insert` it runs the policy against the candidate document.
 *     A policy returning `false` aborts the write with
 *     `CirrusError("FORBIDDEN")`.
 *
 *  3. **Opt-in scope** — a policy applies only inside procedures whose
 *     builder chain includes this middleware. The `rls()` call site is the
 *     boundary; procedures without it see the unwrapped `ctx.db` and ignore
 *     every policy in the list. This is by design (PLAN2 §3.2).
 *
 * What it deliberately does **not** touch:
 *
 *  - The `{ kind, args, handler }` dispatch contract.
 *  - Triggers — cross-row trigger logic by design has the full row already
 *    (`event.before`/`event.after`), so RLS gates the user-facing DB methods
 *    inside trigger handlers but never the trigger payload itself. The
 *    wrapper is installed on `ctx.db`; trigger internals use the underlying
 *    writer.
 *  - `count()` is intercepted only on tables with an active read policy —
 *    unrelated tables count freely.
 *
 * The middleware is signature-compatible with the builder's `Middleware<>`,
 * so `.use(rls(policies))` slots in like any other middleware.
 */
import type { Middleware } from "../builder/types.js";
import { CirrusError } from "../error.js";
import type { Policy, PolicyContext, WhereInput } from "./types.js";

/**
 * Structural mirror of `@cirrus/do`'s `QueryArgs` and `CountArgs`. The
 * runtime ORM in `@cirrus/do`/`@cirrus/d1` reads `baseWhere` /
 * `restrictsCounts` straight off these option objects, so as long as the
 * fields here stay name-compatible the wrapper is portable across the two
 * dialects without an inter-package dependency.
 */
interface QueryArgs {
    baseWhere?: WhereInput;
    cursor?: null | string;
    limit?: number;
    orderBy?: ReadonlyArray<unknown>;
    restrictsCounts?: boolean;
    where?: WhereInput;
    with?: Record<string, unknown>;
}

interface CountArgs {
    baseWhere?: WhereInput;
    restrictsCounts?: boolean;
    where?: WhereInput;
}

interface QueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Array<Record<string, unknown>>;
}

interface TableReaderLike {
    collect: () => Promise<Array<Record<string, unknown>>>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => TableReaderLike;
    first: () => Promise<Record<string, unknown> | null>;
    paginate: (options: { cursor?: null | string; numItems: number }) => Promise<QueryPage>;
    take: (limit: number) => Promise<Array<Record<string, unknown>>>;
    withIndex: (indexName: string, range?: (q: unknown) => unknown) => TableReaderLike;
    withSearchIndex: (indexName: string, search: (q: unknown) => unknown) => TableReaderLike;
}

/**
 * Structural projection of the runtime ORM writer. The wrapper relies only
 * on these fields, so it's interchangeable between `@cirrus/do`'s
 * `DatabaseWriterLike` and `@cirrus/d1`'s `DatabaseWriterLike`.
 */
interface DatabaseWriterLike {
    count: (tableName: string, whereOrArgs?: CountArgs | WhereInput) => Promise<number>;
    delete: (id: string) => Promise<void>;
    findFirst: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown> | null>;
    findFirstOrThrow: (tableName: string, args?: QueryArgs) => Promise<Record<string, unknown>>;
    findMany: (tableName: string, args?: QueryArgs) => Promise<QueryPage>;
    get: (id: string) => Promise<Record<string, unknown> | null>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
    query: (tableName: string) => TableReaderLike;
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;
}

/**
 * What a procedure's `ctx.db` must structurally satisfy for the middleware
 * to wrap it. We deliberately mirror `@cirrus/do`'s `DatabaseWriterLike`
 * rather than `@cirrus/server`'s nominal `DatabaseWriter`/`DatabaseReader`:
 * the runtime adapter that flows in is the `DatabaseWriterLike`-shaped one,
 * and structural matching keeps this module free of an `@cirrus/do`-typed
 * `ctx`.
 */
export type RlsDatabase = DatabaseWriterLike;

/** Roles list source on the context. Tolerant of older auth states. */
type AuthLike = {
    getIdentity?: () => Promise<Record<string, unknown> | null>;
    roles?: ReadonlyArray<string>;
    userId?: null | string;
};

/** Minimal shape the middleware needs on the incoming ctx. */
interface RlsCtxIn {
    auth?: AuthLike;
    db: RlsDatabase;
}

/** Sentinel `WhereInput` that compiles to a vacuously-false predicate. */
const FALSE_PREDICATE: WhereInput = { OR: [] };

/**
 * Collect a per-table map from a flat policy list. Order within each table
 * is preserved so the merge below honors author-declared precedence.
 */
const indexByTable = <Ctx>(policies: ReadonlyArray<Policy<Ctx>>): Map<string, Array<Policy<Ctx>>> => {
    const map = new Map<string, Array<Policy<Ctx>>>();

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
 *  - any `true`        → unrestricted (return `undefined`).
 *  - any `WhereInput`  → OR them (multiple policies broaden access).
 *  - all `false`/empty → deny (return the FALSE sentinel).
 *
 * The Convex / kitcn convention is "any matching policy reveals the row";
 * we mirror that by OR-ing the predicates.
 */
const computeReadBaseWhere = <Ctx>(policies: ReadonlyArray<Policy<Ctx>>, context: PolicyContext<Ctx>): undefined | WhereInput => {
    const predicates: WhereInput[] = [];
    let sawTrue = false;
    let sawDecision = false;

    for (const policy of policies) {
        if (policy.on !== "read") {
            continue;
        }

        const decision = policy.when(context);

        if (decision === undefined) {
            continue;
        }

        sawDecision = true;

        if (decision === true) {
            sawTrue = true;
            break;
        }

        if (decision === false) {
            continue;
        }

        predicates.push(decision);
    }

    if (!sawDecision) {
        return undefined;
    }

    if (sawTrue) {
        return undefined;
    }

    if (predicates.length === 0) {
        return FALSE_PREDICATE;
    }

    return predicates.length === 1 ? predicates[0] : { OR: predicates };
};

/**
 * Evaluate write policies for a `(table, op)` pair. Returns `true` to allow
 * the write, `false` to deny. The convention is "every matching write policy
 * must allow" — the most restrictive policy wins, mirroring SQL RLS.
 *
 * Decision semantics:
 *
 *  - `true`            → allow.
 *  - `false`           → deny (`CirrusError("FORBIDDEN")` at the call site).
 *  - `WhereInput`      → allow only when the candidate row (insert) or
 *                        pre-write row (update/delete) matches the predicate;
 *                        a mismatch denies the write. Evaluated by
 *                        {@link matchesWhere} with the same operator set as
 *                        the SQL compiler (`eq`/`ne`/`in`/`notIn`/`lt`/`lte`/
 *                        `gt`/`gte`/`isNull`/`contains` + `AND`/`OR`/`NOT`).
 *                        A predicate without a row to evaluate (defensive
 *                        case — the wrapper always passes one) denies.
 *  - `undefined`       → policy opts out; doesn't count as a decision.
 *
 * If no write policy matches the op, the write is *allowed by default* —
 * RLS guards declared reads; unguarded writes flow through. Authors who
 * want every write to be policy-gated should declare a matching write
 * policy explicitly.
 */
const evaluateWrite = <Ctx>(policies: ReadonlyArray<Policy<Ctx>>, op: Exclude<Policy["on"], "read">, context: PolicyContext<Ctx>): boolean => {
    for (const policy of policies) {
        if (policy.on !== op) {
            continue;
        }

        const decision = policy.when(context);

        if (decision === undefined || decision === true) {
            continue;
        }

        if (decision === false) {
            return false;
        }

        // WhereInput predicate — the row qualifies only if it matches.
        // Without a row to evaluate against we deny (safer default; in
        // practice the wrapper always supplies the candidate or pre-write
        // row, so this branch is defensive).
        if (!context.row || !matchesWhere(context.row, decision)) {
            return false;
        }
    }

    return true;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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
const intoCountArgs = (arg: CountArgs | undefined | WhereInput): CountArgs => {
    if (arg === undefined) {
        return {};
    }

    if (isPlainObject(arg) && ("baseWhere" in arg || "restrictsCounts" in arg || "where" in arg)) {
        return arg as CountArgs;
    }

    return { where: arg as WhereInput };
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
 * Build a writer that intercepts table-scoped reads/writes against the
 * underlying `DatabaseWriterLike`, applying the policy evaluator on every
 * call. The wrapper is a fresh closure per request so the evaluator sees the
 * current `ctx`.
 */
const wrapDb = <Ctx>(base: RlsDatabase, perTable: Map<string, Array<Policy<Ctx>>>, context: PolicyContext<Ctx>): RlsDatabase => {
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
     * Resolve the writer's id-to-table lookup by probing each policy table
     * with a direct `get` against the underlying writer. The unwrapped
     * `base.get` is intentionally used so policy enforcement on writes
     * doesn't recurse through itself when we go fetch the pre-write row.
     * Probes run concurrently: id-to-table latency is bounded by the
     * slowest single probe rather than the sum of all probes.
     */
    const findRowTable = async (id: string): Promise<undefined | { row: Record<string, unknown>; tableName: string }> => {
        const row = await base.get(id);

        if (!row) {
            return undefined;
        }

        // Ids are globally unique, so at most one probe hits; settle all of
        // them in parallel and pick the hit instead of serializing the
        // round-trips.
        const probes = await Promise.all(
            [...perTable.keys()].map(async (tableName) => {
                const probe = await base.findFirst(tableName, { where: { _id: id }, limit: 1 });

                return probe?.["_id"] === id ? tableName : null;
            }),
        );

        const tableName = probes.find((entry): entry is string => entry !== null);

        // The row exists but isn't in any policy-gated table — fall through
        // unrestricted by returning `undefined` (no policy applies).
        return tableName === undefined ? undefined : { row, tableName };
    };

    /**
     * Locate the row + table, evaluate the matching write policy against the
     * pre-write row, then perform the underlying mutation. Shared by
     * `delete`/`patch`/`replace` so the three id-keyed write paths agree on
     * deny semantics and on the "no policy → pass through" fast path.
     */
    const gateById = async <R>(id: string, op: Exclude<Policy["on"], "insert" | "read">, perform: () => Promise<R>): Promise<R> => {
        const located = await findRowTable(id);

        if (!located) {
            return perform();
        }

        const policies = perTable.get(located.tableName);

        if (policies) {
            const writeOk = evaluateWrite(policies, op, { ...context, row: located.row });

            if (!writeOk) {
                throw new CirrusError("FORBIDDEN", `${op} on "${located.tableName}" denied by policy`);
            }
        }

        return perform();
    };

    return {
        async count(tableName, whereOrArgs) {
            const { baseWhere, restricts } = readBase(tableName);
            const args = intoCountArgs(whereOrArgs);

            return base.count(tableName, {
                ...args,
                baseWhere: mergeBaseWhere(args.baseWhere, baseWhere),
                restrictsCounts: args.restrictsCounts || restricts,
            });
        },

        delete: (id) => gateById(id, "delete", () => base.delete(id)),

        async findFirst(tableName, args) {
            const { baseWhere } = readBase(tableName);

            return base.findFirst(tableName, { ...intoQueryArgs(args), baseWhere: mergeBaseWhere(args?.baseWhere, baseWhere) });
        },

        async findFirstOrThrow(tableName, args) {
            const { baseWhere } = readBase(tableName);

            return base.findFirstOrThrow(tableName, { ...intoQueryArgs(args), baseWhere: mergeBaseWhere(args?.baseWhere, baseWhere) });
        },

        async findMany(tableName, args) {
            const { baseWhere } = readBase(tableName);

            return base.findMany(tableName, { ...intoQueryArgs(args), baseWhere: mergeBaseWhere(args?.baseWhere, baseWhere) });
        },

        async get(id) {
            const row = await base.get(id);

            if (!row) {
                return null;
            }

            // Two-step lookup, in parallel across the policy-gated tables:
            //   1. **Membership** — does this row belong to this table?
            //      A `findFirst` WITHOUT `baseWhere` so it can't be confused
            //      with a policy denial.
            //   2. **Policy check** — re-fetch WITH `baseWhere` only on the
            //      table that owns the row; null here means deny, not absent.
            // Without step 1 a denied row would silently fall through to the
            // unguarded `row` below, leaking what the policy is meant to hide.
            const probes = await Promise.all(
                [...perTable.keys()].map(async (tableName) => {
                    const membership = await base.findFirst(tableName, { where: { _id: id }, limit: 1 });

                    if (membership?.["_id"] !== id) {
                        return null;
                    }

                    const { baseWhere, restricts } = readBase(tableName);

                    if (!restricts || !baseWhere) {
                        return { allowed: membership };
                    }

                    const allowed = await base.findFirst(tableName, { where: { _id: id }, baseWhere, limit: 1 });

                    return { allowed: allowed?.["_id"] === id ? allowed : null };
                }),
            );

            // Ids are globally unique, so at most one probe matches.
            const hit = probes.find((entry): entry is { allowed: null | Record<string, unknown> } => entry !== null);

            // Row exists but isn't in any policy-gated table → unrestricted.
            if (!hit) {
                return row;
            }

            // Row owned by a policy-gated table; surface the policy verdict
            // (a deliberate null means "denied", NOT "fall back to row").
            return hit.allowed;
        },

        async insert(tableName, document) {
            const policies = perTable.get(tableName);

            if (policies) {
                const writeOk = evaluateWrite(policies, "insert", { ...context, row: document });

                if (!writeOk) {
                    throw new CirrusError("FORBIDDEN", `insert on "${tableName}" denied by policy`);
                }
            }

            return base.insert(tableName, document);
        },

        patch: (id, patch) => gateById(id, "update", () => base.patch(id, patch)),

        query(tableName) {
            const { baseWhere } = readBase(tableName);

            const reader = base.query(tableName);

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

        replace: (id, document) => gateById(id, "update", () => base.replace(id, document)),
    };
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

        if (key === "AND") {
            if (!Array.isArray(value) || !value.every((branch) => matchesWhere(document, branch as WhereInput))) {
                return false;
            }

            continue;
        }

        if (key === "OR") {
            if (!Array.isArray(value) || !value.some((branch) => matchesWhere(document, branch as WhereInput))) {
                return false;
            }

            continue;
        }

        if (key === "NOT") {
            if (matchesWhere(document, (value ?? {}) as WhereInput)) {
                return false;
            }

            continue;
        }

        const docValue = document[key];

        if (isPlainObject(value) && Object.keys(value).every((k) => (OPERATOR_KEYS as ReadonlyArray<string>).includes(k))) {
            const operators = value as Record<string, unknown>;

            if ("eq" in operators && docValue !== operators["eq"]) {
                return false;
            }

            if ("ne" in operators && docValue === operators["ne"]) {
                return false;
            }

            if ("in" in operators) {
                const list = operators["in"];

                if (!Array.isArray(list) || !list.includes(docValue)) {
                    return false;
                }
            }

            if ("notIn" in operators) {
                const list = operators["notIn"];

                if (Array.isArray(list) && list.includes(docValue)) {
                    return false;
                }
            }

            if ("lt" in operators && (!isOrderable(docValue) || !isOrderable(operators["lt"]) || (docValue as number) >= (operators["lt"] as number))) {
                return false;
            }

            if ("lte" in operators && (!isOrderable(docValue) || !isOrderable(operators["lte"]) || (docValue as number) > (operators["lte"] as number))) {
                return false;
            }

            if ("gt" in operators && (!isOrderable(docValue) || !isOrderable(operators["gt"]) || (docValue as number) <= (operators["gt"] as number))) {
                return false;
            }

            if ("gte" in operators && (!isOrderable(docValue) || !isOrderable(operators["gte"]) || (docValue as number) < (operators["gte"] as number))) {
                return false;
            }

            if ("contains" in operators) {
                const needle = operators["contains"];

                if (typeof docValue !== "string" || typeof needle !== "string" || !docValue.includes(needle)) {
                    return false;
                }
            }

            if ("isNull" in operators) {
                const expectsNull = operators["isNull"] === true;

                if (expectsNull !== (docValue === null || docValue === undefined)) {
                    return false;
                }
            }

            continue;
        }

        if (docValue !== value) {
            return false;
        }
    }

    return true;
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
export const rls = <Ctx extends RlsCtxIn = RlsCtxIn>(policies: ReadonlyArray<Policy<Ctx>>): Middleware<Ctx, Ctx> => {
    const perTable = indexByTable(policies);

    return async ({ ctx, next }) => {
        const auth = ctx.auth ?? {};
        // Resolve identity once per RLS-protected procedure so policies can
        // branch on claims (`ctx.auth.identity.email` etc.) without each
        // policy paying for its own `getIdentity()` call. `null` covers both
        // the anonymous case and the no-resolver case (older auth states).
        const identity = await auth.getIdentity?.() ?? null;
        const policyContext: PolicyContext<Ctx> = {
            auth: {
                identity,
                roles: auth.roles ?? [],
                userId: auth.userId ?? null,
            },
            ctx,
        };

        const wrapped = wrapDb<Ctx>(ctx.db, perTable, policyContext);
        // `next({ ctx: extension })` expects an extension shape — we only
        // replace `db`, so the downstream context type is unchanged (`Ctx`
        // in / `Ctx` out). The cast routes the wrapped db through the same
        // middleware-extension channel without leaking RLS internals into
        // the builder's typed surface.
        const extension = { db: wrapped } as unknown as Record<string, unknown>;

        return next({ ctx: extension }) as Promise<Ctx>;
    };
};
