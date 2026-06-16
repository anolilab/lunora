/**
 * Relation-crossing `where` predicates — the semijoin pre-resolver shared by
 * both ORM dialects (DO SQLite + D1).
 *
 * The flat `WhereInput` compiler (`compileWhere`) only knows about a table's
 * own columns. To let a query (or an RLS policy) filter a *parent* table by a
 * condition on a *related* table — Prisma-style `{ author: { is: W } }` /
 * `{ posts: { some: W } }` — we rewrite each relation node into a flat column
 * predicate **before** the SQL is compiled:
 *
 * 1. Run the child query via the injected `fetcher` (the same backend-routed
 * reader `resolveWith` uses, so the child read honours its own RLS via
 * `relationBaseWhere` and routes correctly across DO ↔ D1).
 * 2. Project the join key off the matched child rows.
 * 3. Rewrite the relation node into a flat `in`/`notIn` clause on the join
 * field — which the compiler already handles, including the empty-set sentinels
 * (`in []` → `0 = 1`, `notIn []` → `1 = 1`).
 *
 * This is a *semijoin via `IN`*, the same batched-fetch idiom `resolveWith`
 * uses, pointed the other way. It is universal — it works for cross-backend and
 * cross-shard relations where a single correlated `EXISTS` subquery (which can
 * only span one SQLite database) is impossible. A same-shard `EXISTS` fast path
 * can be layered on top later; the pushability decision lives in `ctx-db.ts`.
 *
 * The resolver is pure with respect to its input tree (it returns a fresh tree,
 * never mutates) and recurses for both nested boolean groups and multi-hop
 * relation predicates (`{ posts: { some: { author: { is: W } } } }` resolves
 * inside-out).
 */

import type { TableDefinitionLike } from "./ctx-db";
import type { QueryArgs, QueryPage } from "./query-args";
import type { RelationDefinitionLike } from "./relations";
import { distinctValues } from "./relations";
import type { WhereInput } from "./where-clause-compiler";

/** Prisma-style relation operators, dispatched by relation cardinality. */
const ONE_OPERATORS = new Set(["is", "isNot"]);
const MANY_OPERATORS = new Set(["every", "none", "some"]);
const RELATION_OPERATORS = new Set([...ONE_OPERATORS, ...MANY_OPERATORS]);

/**
 * Default cap on the number of join keys a single relation predicate may pull
 * back. A broad `some: {}` over a large child table would otherwise build an
 * unbounded `IN (...)`; past the cap we fail **closed** (a clear error) rather
 * than silently truncating, which would under- or over-match. The same-shard
 * `EXISTS` fast path (Phase 2) is the real fix for genuinely large sets.
 */
const DEFAULT_MAX_RELATION_KEYS = 5000;

interface ResolveRelationPredicatesOptions {
    /** Backend-routed child reader — `resolveWith`'s `fetcher` (a DO/D1 `findMany`). */
    fetcher: (tableName: string, args: QueryArgs) => Promise<QueryPage>;
    /** Override the {@link DEFAULT_MAX_RELATION_KEYS} fail-closed cap. */
    maxRelationKeys?: number;
    /** Per-target-table RLS read filter, applied to each child fetch (see `QueryArgs.relationBaseWhere`). */
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    schema: { readonly tables: Record<string, TableDefinitionLike> };
    /** The table the top-level `where` is read against. */
    tableName: string;
}

/** Internal threaded context (everything but the per-call `tableName`). */
interface ResolveContext {
    fetcher: (tableName: string, args: QueryArgs) => Promise<QueryPage>;
    maxRelationKeys: number;
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    schema: { readonly tables: Record<string, TableDefinitionLike> };
}

/** Normalize an `AND`/`OR` branch value into a list of non-null sub-trees. */
const branchesOf = (value: unknown): WhereInput[] => (Array.isArray(value) ? value.map((branch) => (branch ?? {}) as WhereInput) : []);

/** Conjoin per-key clauses without risking key collisions on the merged object. */
const combineAnd = (clauses: WhereInput[]): WhereInput => {
    if (clauses.length === 1) {
        const [only] = clauses;

        return only ?? {};
    }

    return clauses.length === 0 ? {} : { AND: clauses };
};

/**
 * A value is a relation predicate when it is a plain (non-array, non-null)
 * object whose every key is a known relation operator — mirrors the compiler's
 * `isOperatorObject` "all keys known" disambiguation so a relation-named key
 * holding an ordinary literal/filter is left untouched.
 */
const isRelationPredicate = (value: unknown): value is Record<string, WhereInput> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value);

    return keys.length > 0 && keys.every((key) => RELATION_OPERATORS.has(key));
};

/**
 * Cheap synchronous scan: does `where` contain any relation predicate for
 * `tableName`? Lets the common no-relation read skip the rebuild entirely (and
 * issue zero extra queries). A child-table predicate is always nested under a
 * parent relation key, so checking the current table's `relationMap` at each
 * boolean level is sufficient.
 */
const containsRelationPredicate = (where: WhereInput, schema: ResolveContext["schema"], tableName: string): boolean => {
    const relationMap = schema.tables[tableName]?.relationMap ?? {};

    return Object.keys(where).some((key) => {
        const value = where[key];

        if (key === "AND" || key === "OR") {
            return branchesOf(value).some((branch) => containsRelationPredicate(branch, schema, tableName));
        }

        if (key === "NOT") {
            return containsRelationPredicate((value ?? {}) as WhereInput, schema, tableName);
        }

        return Boolean(relationMap[key]) && isRelationPredicate(value);
    });
};

/**
 * Run the child query and return the distinct values of `projectField` off the
 * matched rows. The child `where` is itself pre-resolved (multi-hop) and the
 * child's RLS read filter rides `baseWhere`, so an unreadable child row never
 * contributes a key — relation predicates are fail-closed by construction.
 */
const projectChildKeys = async (
    relation: RelationDefinitionLike,
    childWhere: WhereInput,
    projectField: string,
    context: ResolveContext,
): Promise<unknown[]> => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: a child predicate may itself cross relations (multi-hop)
    const resolvedChildWhere = await resolveForTable(childWhere, relation.table, context);
    const { page } = await context.fetcher(relation.table, {
        baseWhere: context.relationBaseWhere?.(relation.table),
        relationBaseWhere: context.relationBaseWhere,
        where: resolvedChildWhere,
    });
    const keys = distinctValues(page, projectField);

    if (keys.length > context.maxRelationKeys) {
        throw new Error(
            `relation predicate on "${relation.table}" matched ${String(keys.length)} rows, exceeding the ${String(context.maxRelationKeys)}-key limit; narrow the predicate (a same-shard EXISTS push-down lifts this cap)`,
        );
    }

    return keys;
};

/** Compile one relation operator into the equivalent flat `WhereInput` clause. */
const compileOperator = async (operator: string, relation: RelationDefinitionLike, childWhere: WhereInput, context: ResolveContext): Promise<WhereInput> => {
    switch (operator) {
        case "every": {
            // "all children match W" ≡ "no child matches NOT W". Children the
            // caller can't read are excluded by `relationBaseWhere`, so this is
            // "every *readable* child matches W" (a deliberate RLS-respecting
            // divergence). An empty violating set ⇒ `notIn []` ⇒ all parents,
            // preserving vacuous truth for childless parents.
            const violating = await projectChildKeys(relation, { NOT: childWhere }, relation.field, context);

            return { [relation.references]: { notIn: violating } };
        }
        case "is": {
            // Parent's FK points at a child matching W. Project the child's
            // referenced column; a null parent FK never matches a non-empty IN.
            const keys = await projectChildKeys(relation, childWhere, relation.references, context);

            return { [relation.field]: { in: keys } };
        }
        case "isNot": {
            // Absent relation (null FK) OR present-but-not-matching. The explicit
            // isNull disjunct is required: SQLite `NULL NOT IN (...)` is NULL
            // (excluded), but `isNot` must match a row with no related record.
            const keys = await projectChildKeys(relation, childWhere, relation.references, context);

            return { OR: [{ [relation.field]: { notIn: keys } }, { [relation.field]: { isNull: true } }] };
        }
        case "none": {
            const keys = await projectChildKeys(relation, childWhere, relation.field, context);

            return { [relation.references]: { notIn: keys } };
        }
        case "some": {
            const keys = await projectChildKeys(relation, childWhere, relation.field, context);

            return { [relation.references]: { in: keys } };
        }
        default: {
            throw new Error(`unknown relation operator "${operator}"`);
        }
    }
};

/** Reject a relation operator applied to a relation of the wrong cardinality. */
const assertCardinality = (operator: string, name: string, relation: RelationDefinitionLike): void => {
    if (ONE_OPERATORS.has(operator) && relation.kind !== "one") {
        throw new Error(`relation operator "${operator}" requires a to-one relation, but "${name}" is to-many`);
    }

    if (MANY_OPERATORS.has(operator) && relation.kind !== "many") {
        throw new Error(`relation operator "${operator}" requires a to-many relation, but "${name}" is to-one`);
    }
};

/**
 * Resolve a single relation predicate object (`{ is: W }`, `{ some: W1, none:
 * W2 }`, …) into a flat clause, AND-ing every operator it carries. Throws on a
 * cardinality mismatch (`some` on a to-one, `is` on a to-many) — deny-by-default
 * rather than emit a silently-wrong query.
 */
const resolveRelationNode = async (
    name: string,
    relation: RelationDefinitionLike,
    predicate: Record<string, WhereInput>,
    context: ResolveContext,
): Promise<WhereInput> => {
    const clauses: WhereInput[] = [];

    for (const operator of Object.keys(predicate)) {
        assertCardinality(operator, name, relation);

        // eslint-disable-next-line no-await-in-loop -- one bounded child query per operator; sequential keeps the fan-out predictable
        clauses.push(await compileOperator(operator, relation, predicate[operator] ?? {}, context));
    }

    return combineAnd(clauses);
};

/** Resolve one `where` key (boolean group, relation node, or column passthrough) to a flat clause. */
const resolveKey = async (key: string, value: unknown, tableName: string, context: ResolveContext): Promise<WhereInput> => {
    if (key === "AND" || key === "OR") {
        const resolved: WhereInput[] = [];

        for (const branch of branchesOf(value)) {
            // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-use-before-define -- branches resolved in order; each may issue bounded child reads
            resolved.push(await resolveForTable(branch, tableName, context));
        }

        return { [key]: resolved };
    }

    if (key === "NOT") {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion with resolveForTable
        return { NOT: await resolveForTable((value ?? {}) as WhereInput, tableName, context) };
    }

    const relation = context.schema.tables[tableName]?.relationMap?.[key];

    if (relation && isRelationPredicate(value)) {
        return resolveRelationNode(key, relation, value, context);
    }

    return { [key]: value };
};

/**
 * Walk `where` against `tableName`, returning a fresh tree with every relation
 * predicate rewritten to a flat clause. Per-key clauses are AND-combined (an
 * object's keys are conjoined anyway) so a rewritten `OR`/field clause can't
 * collide with an existing key.
 */
const resolveForTable = async (where: WhereInput, tableName: string, context: ResolveContext): Promise<WhereInput> => {
    const clauses: WhereInput[] = [];

    for (const key of Object.keys(where)) {
        // eslint-disable-next-line no-await-in-loop -- keys resolved in order; each may issue bounded child reads
        clauses.push(await resolveKey(key, where[key], tableName, context));
    }

    return combineAnd(clauses);
};

/**
 * Pre-resolve every relation-crossing predicate in `where` into flat column
 * predicates, ready for `compileWhere`. Returns the input unchanged when there
 * are no relation predicates (the common path pays a single synchronous scan
 * and issues no extra query).
 */
const resolveRelationPredicates = async (where: WhereInput | undefined, options: ResolveRelationPredicatesOptions): Promise<WhereInput | undefined> => {
    if (!where || !containsRelationPredicate(where, options.schema, options.tableName)) {
        return where;
    }

    return resolveForTable(where, options.tableName, {
        fetcher: options.fetcher,
        maxRelationKeys: options.maxRelationKeys ?? DEFAULT_MAX_RELATION_KEYS,
        relationBaseWhere: options.relationBaseWhere,
        schema: options.schema,
    });
};

export { containsRelationPredicate, DEFAULT_MAX_RELATION_KEYS, isRelationPredicate, resolveRelationPredicates };
export type { ResolveRelationPredicatesOptions };
