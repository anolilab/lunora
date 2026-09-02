/**
 * Relation-crossing `where` predicates — the semijoin pre-resolver shared by
 * both ORM dialects (DO SQLite + D1).
 *
 * The flat `WhereInput` compiler (`compileWhereSql`) only knows about a table's
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

import { LunoraError } from "@lunora/errors";

import type { RelationOperator } from "../../../shared/relation-operators";
import { isRelationPredicate as isSharedRelationPredicate, RELATION_OPERATOR_SET } from "../../../shared/relation-operators";
import { isMemoryTable } from "./ctx-db-memory";
import { distinctValues } from "./relations";
import type { QueryArgs, QueryPage, RelationDefinitionLike, TableDefinitionLike } from "./schema-types";
import type { WhereInput } from "./where-types";
import { RELATION_EXISTS_KEY } from "./where-types";

/**
 * Single source of truth for the Prisma-style relation operators. Both the
 * semijoin reduction ({@link compileOperator}) and the EXISTS push-down
 * ({@link buildExistsMarker}) derive their entire truth table from this map, so
 * adding a 6th operator is a one-line data change rather than edits scattered
 * across two switch sites, the cardinality guard, and three operator sets.
 *
 * - `kind` — the relation cardinality the operator requires (`is`/`isNot` are
 * to-one; `some`/`none`/`every` are to-many). Drives {@link assertCardinality}.
 * - `negated` — the membership test is inverted: the flat clause uses `notIn`
 * (vs `in`) and the EXISTS marker emits `NOT EXISTS` (vs `EXISTS`).
 * - `negateChild` — run the child query with the predicate negated (`every` ≡
 * "no child matches NOT W").
 * - `nullDisjunct` — the semijoin must add an explicit `isNull` disjunct so an
 * absent to-one relation (null FK) matches (`isNot`). The EXISTS path needs no
 * such disjunct — `NOT EXISTS` over an absent FK is naturally true.
 *
 * The projected/clause join columns are not per-operator: they follow purely
 * from the relation's cardinality (see {@link joinColumns}).
 */
interface RelationOperatorMeta {
    kind: RelationDefinitionLike["kind"];
    negateChild?: boolean;
    negated: boolean;
    nullDisjunct?: boolean;
}

// `Record<RelationOperator, …>` deliberately, not `Record<string, …>`: the names
// live in `shared/relation-operators.ts` because `@lunora/server` needs the same
// set and cannot depend on this package. Keying the meta map off that union is
// what makes them one fact — add a sixth name there without a row here and this
// file stops compiling, rather than the server's guards silently walking past it.
const RELATION_OPERATOR_META: Record<RelationOperator, RelationOperatorMeta> = {
    every: { kind: "many", negateChild: true, negated: true },
    is: { kind: "one", negated: false },
    isNot: { kind: "one", negated: true, nullDisjunct: true },
    none: { kind: "many", negated: true },
    some: { kind: "many", negated: false },
};

/** Narrow an arbitrary key to a relation operator, so the union-keyed meta map can be indexed with it. */
const asRelationOperator = (operator: string): RelationOperator | undefined =>
    RELATION_OPERATOR_SET.has(operator) ? (operator as RelationOperator) : undefined;

/** Look up an operator's meta row, throwing on an unknown operator. */
const requireOperatorMeta = (operator: string): RelationOperatorMeta => {
    const key = asRelationOperator(operator);
    const meta = key === undefined ? undefined : RELATION_OPERATOR_META[key];

    if (!meta) {
        throw new LunoraError("INTERNAL", `unknown relation operator "${operator}"`);
    }

    return meta;
};

/**
 * The two join columns a relation predicate touches, derived from cardinality:
 * - **clause** — the *parent* column the rewritten flat clause / EXISTS
 * correlation constrains. to-one: the parent's FK (`field`); to-many: the
 * parent's referenced column (`references`).
 * - **project** — the *child* column whose distinct values the semijoin reads
 * off matched rows. Always the mirror of `clause`.
 */
const joinColumns = (relation: RelationDefinitionLike): { clause: string; project: string } =>
    relation.kind === "one" ? { clause: relation.field, project: relation.references } : { clause: relation.references, project: relation.field };

/**
 * Default cap on the number of join keys a single relation predicate may pull
 * back. A broad `some: {}` over a large child table would otherwise build an
 * unbounded `IN (...)`; past the cap we fail **closed** (a clear error) rather
 * than silently truncating, which would under- or over-match. The same-shard
 * `EXISTS` fast path (Phase 2) is the real fix for genuinely large sets.
 */
const DEFAULT_MAX_RELATION_KEYS = 5000;

/**
 * Marker node payload for a pushed-down correlated EXISTS. Emitted under the
 * reserved `RELATION_EXISTS_KEY` in place of a semijoin rewrite when the dialect
 * reports the relation as co-located (same SQLite DB). The compiler's
 * `relationExists` strategy hook turns it into `[NOT] EXISTS (...)`; this module
 * stays storage-blind and only assembles the (RLS-merged, recursively resolved)
 * child predicate plus the correlation metadata the SQL layer needs.
 */
interface RelationExistsMarker {
    /** Child predicate compiled inside the subquery: RLS base AND (W | NOT W). */
    childWhere: WhereInput;
    /** `true` → `NOT EXISTS` (none/isNot/every); `false` → `EXISTS` (some/is). */
    negated: boolean;
    /** Table the outer `where` reads — the correlation's parent side. */
    parentTable: string;
    /** The relation crossed, carrying kind + join columns. */
    relation: RelationDefinitionLike;
}

/**
 * How an EXISTS-pushable relation node is resolved.
 *
 * - `"auto"` (default) — **cost-based**: resolve via the cheaper semijoin first
 * and only escalate a node to the correlated EXISTS when its child key set
 * overflows {@link DEFAULT_MAX_RELATION_KEYS}. Benchmarks put the semijoin at
 * 2.5–13× the throughput of the push-down on the JSON-blob path (an indexed
 * flat `IN (...)` vs a per-row correlated subquery), so EXISTS earns its keep on
 * exactly one axis — it has no key cap. `"auto"` spends the cheap path on the
 * common small/indexed set and reserves the pricier-but-unbounded push-down for
 * the genuinely large set that would otherwise fail closed.
 * - `"always"` — push every pushable node inline regardless of size (the old
 * Phase 2 default; kept for EXISTS-path test coverage and benchmarking).
 * - A relation is only ever a push candidate when {@link
 * ResolveRelationPredicatesOptions.canPushExists} reports it co-located; absent
 * that gate every node takes the semijoin and a cap overflow fails closed.
 */
type ExistsPushMode = "always" | "auto";

interface ResolveRelationPredicatesOptions {
    /**
     * Phase 2 push-down gate. When supplied and it returns `true` for a
     * relation, that relation node is *eligible* for a correlated-EXISTS marker
     * (compiled inline by the SQL layer) instead of a semijoin child fetch —
     * subject to {@link ExistsPushMode}. Returning `false` (or omitting the
     * gate) pins the universal semijoin path. The DO dialect gates on
     * parent+child co-location in one SQLite DB; D1 omits it (cross-backend, no
     * shared subquery scope).
     */
    canPushExists?: (relation: RelationDefinitionLike) => boolean;
    /** Push-eligible-node policy (see {@link ExistsPushMode}). Defaults to `"auto"`. */
    existsPushMode?: ExistsPushMode;
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
    canPushExists?: (relation: RelationDefinitionLike) => boolean;
    existsPushMode: ExistsPushMode;
    fetcher: (tableName: string, args: QueryArgs) => Promise<QueryPage>;
    maxRelationKeys: number;
    relationBaseWhere?: (table: string) => undefined | WhereInput;
    schema: { readonly tables: Record<string, TableDefinitionLike> };
}

/**
 * Sentinel returned by {@link projectChildKeys}/{@link compileOperator} when the
 * child key set exceeds the cap *and* an EXISTS escalation is available — the
 * caller swaps the semijoin for a push-down marker instead of failing closed.
 */
const KEY_OVERFLOW = Symbol("relation-key-overflow");

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
const isRelationPredicate = (value: unknown): value is Record<string, WhereInput> => isSharedRelationPredicate(value);

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
 * Reject a relation-crossing predicate on a path that compiles `where` directly
 * (aggregate / count / groupBy / rank) instead of resolving it. Such a node
 * would otherwise silently mis-compile as an ordinary column comparison and
 * return a confusing empty/wrong result — a fail-**open** RLS hazard when the
 * predicate arrives via an injected read policy. Shared by both dialects so the
 * DO and D1 backends can't drift on which ops are guarded.
 */
const assertFlatPredicate = (where: WhereInput | undefined, schema: ResolveContext["schema"], tableName: string, op: string): void => {
    if (where && containsRelationPredicate(where, schema, tableName)) {
        throw new LunoraError("INTERNAL", `relation-crossing predicates are not supported in ${op}() — use them in findMany/findFirst or an RLS read policy`);
    }
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
    escalatable: boolean,
): Promise<typeof KEY_OVERFLOW | unknown[]> => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: a child predicate may itself cross relations (multi-hop)
    const resolvedChildWhere = await resolveForTable(childWhere, relation.table, context);
    const { page } = await context.fetcher(relation.table, {
        baseWhere: context.relationBaseWhere?.(relation.table),
        relationBaseWhere: context.relationBaseWhere,
        where: resolvedChildWhere,
    });
    const keys = distinctValues(page, projectField);

    if (keys.length > context.maxRelationKeys) {
        // A co-located relation can escape the cap via the (unbounded) EXISTS
        // push-down — signal the overflow so the caller escalates. Otherwise
        // (cross-backend/cross-shard) there is no subquery to fall back to, so
        // fail closed rather than truncate the `IN (...)` and silently mis-match.
        if (escalatable) {
            return KEY_OVERFLOW;
        }

        throw new LunoraError(
            "INTERNAL",
            `relation predicate on "${relation.table}" matched ${String(keys.length)} rows, exceeding the ${String(context.maxRelationKeys)}-key limit; narrow the predicate (a same-shard EXISTS push-down lifts this cap)`,
        );
    }

    return keys;
};

/**
 * Compile one relation operator into the equivalent flat `WhereInput` clause,
 * deriving the entire truth table from {@link RELATION_OPERATOR_META}:
 *
 * `negateChild` (`every`) runs the child query under `{ NOT: W }`, so the
 * projected keys are the *violating* rows. Children the caller can't read are
 * excluded by `relationBaseWhere` — so `every` means "every *readable* child
 * matches W" (a deliberate RLS-respecting divergence). An empty violating set
 * ⇒ `notIn []` ⇒ all parents, preserving vacuous truth for childless parents.
 *
 * `negated: false` (`is`/`some`) ⇒ `{ clause: { in: keys } }`. A null parent
 * FK never matches a non-empty `in` (correct — no related row).
 *
 * `negated: true` + `nullDisjunct` (`isNot`) adds the explicit `isNull`
 * disjunct: SQLite `NULL NOT IN (...)` is NULL (excluded), but `isNot` must
 * match a row with no related record. `negated: true` without it
 * (`none`/`every`) ⇒ a bare `notIn`.
 */
const compileOperator = async (
    operator: string,
    relation: RelationDefinitionLike,
    childWhere: WhereInput,
    context: ResolveContext,
    escalatable: boolean,
): Promise<typeof KEY_OVERFLOW | WhereInput> => {
    const meta = requireOperatorMeta(operator);
    const { clause, project } = joinColumns(relation);
    const keys = await projectChildKeys(relation, meta.negateChild ? { NOT: childWhere } : childWhere, project, context, escalatable);

    if (keys === KEY_OVERFLOW) {
        return KEY_OVERFLOW;
    }

    if (!meta.negated) {
        return { [clause]: { in: keys } };
    }

    if (meta.nullDisjunct) {
        return { OR: [{ [clause]: { notIn: keys } }, { [clause]: { isNull: true } }] };
    }

    return { [clause]: { notIn: keys } };
};

/**
 * Phase 2: rewrite a pushable relation operator into a correlated-EXISTS marker
 * instead of a semijoin (no child fetch). The child predicate is RLS-merged
 * (`relationBaseWhere`) and recursively resolved — so a co-located grandchild
 * pushes down too. `every` ("no readable child violates W") negates only `W`,
 * leaving the RLS base intact, and emits `NOT EXISTS`; this mirrors the semijoin
 * truth table exactly (`NOT EXISTS` over a null/absent FK is naturally `true`,
 * matching the explicit `isNull` disjunct the semijoin path adds).
 */
const buildExistsMarker = async (
    operator: string,
    relation: RelationDefinitionLike,
    childWhere: WhereInput,
    parentTable: string,
    context: ResolveContext,
): Promise<WhereInput> => {
    const meta = requireOperatorMeta(operator);
    const base = context.relationBaseWhere?.(relation.table);
    const predicatePart: WhereInput = meta.negateChild ? { NOT: childWhere } : childWhere;
    const merged: WhereInput = base ? { AND: [base, predicatePart] } : predicatePart;
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: the child predicate may itself cross relations (multi-hop / nested push-down)
    const resolvedChild = await resolveForTable(merged, relation.table, context);
    const marker: RelationExistsMarker = { childWhere: resolvedChild, negated: meta.negated, parentTable, relation };

    return { [RELATION_EXISTS_KEY]: marker };
};

/** Reject a relation operator applied to a relation of the wrong cardinality. */
const assertCardinality = (operator: string, name: string, relation: RelationDefinitionLike): void => {
    const key = asRelationOperator(operator);
    const meta = key === undefined ? undefined : RELATION_OPERATOR_META[key];

    if (meta && meta.kind !== relation.kind) {
        throw new LunoraError("INTERNAL", `relation operator "${operator}" requires a to-${meta.kind} relation, but "${name}" is to-${relation.kind}`);
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
    parentTable: string,
    context: ResolveContext,
): Promise<WhereInput> => {
    const clauses: WhereInput[] = [];

    for (const operator of Object.keys(predicate)) {
        assertCardinality(operator, name, relation);

        const childWhere = predicate[operator] ?? {};
        const pushable = context.canPushExists?.(relation) ?? false;

        if (pushable && context.existsPushMode === "always") {
            // Forced push (parity tests / benchmarks): emit the EXISTS marker
            // without the semijoin probe.
            // eslint-disable-next-line no-await-in-loop -- sequential bounded resolution per operator (a non-pushable grandchild may still fetch)
            clauses.push(await buildExistsMarker(operator, relation, childWhere, parentTable, context));

            continue;
        }

        // Cost-based default: take the cheaper semijoin first. It only escalates
        // to the (pricier but unbounded) EXISTS push-down when the child key set
        // overflows the cap AND the relation is co-located (`pushable`); a
        // non-pushable overflow fails closed inside `compileOperator`.
        // eslint-disable-next-line no-await-in-loop -- one bounded child query per operator; sequential keeps the fan-out predictable
        const semijoin = await compileOperator(operator, relation, childWhere, context, pushable);

        if (semijoin === KEY_OVERFLOW) {
            // eslint-disable-next-line no-await-in-loop -- escalation path: build the inline subquery for this oversized node
            clauses.push(await buildExistsMarker(operator, relation, childWhere, parentTable, context));
        } else {
            clauses.push(semijoin);
        }
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
        return resolveRelationNode(key, relation, value, tableName, context);
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
 * predicates, ready for `compileWhereSql`. Returns the input unchanged when there
 * are no relation predicates (the common path pays a single synchronous scan
 * and issues no extra query).
 */
const resolveRelationPredicates = async (where: WhereInput | undefined, options: ResolveRelationPredicatesOptions): Promise<WhereInput | undefined> => {
    if (!where || !containsRelationPredicate(where, options.schema, options.tableName)) {
        return where;
    }

    return resolveForTable(where, options.tableName, {
        canPushExists: options.canPushExists,
        existsPushMode: options.existsPushMode ?? "auto",
        fetcher: options.fetcher,
        maxRelationKeys: options.maxRelationKeys ?? DEFAULT_MAX_RELATION_KEYS,
        relationBaseWhere: options.relationBaseWhere,
        schema: options.schema,
    });
};

/**
 * A relation predicate a live shape cannot be poked from, and why: its target
 * table lives in another Durable Object (`shardBy`), or its writes never reach
 * the changelog the poke loop replicates from (`memory`).
 */
type UnpokeableRelationHit = { kind: "memory" | "shardBy"; relation: string; target: string };

/** First unpokeable hit across a set of sibling sub-wheres (each scanned under `tableName`). */
const firstShardedHit = (branches: Iterable<WhereInput>, schema: ResolveContext["schema"], tableName: string): UnpokeableRelationHit | undefined => {
    for (const branch of branches) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: a branch is itself a where to re-scan.
        const hit = findShardedRelationTarget(branch, schema, tableName);

        if (hit) {
            return hit;
        }
    }

    return undefined;
};

/** Scan one `where` key (boolean branch or relation predicate) for an unpokeable-join hit. */
const inspectKey = (key: string, value: WhereInput[string], schema: ResolveContext["schema"], tableName: string): UnpokeableRelationHit | undefined => {
    if (key === "AND" || key === "OR") {
        return firstShardedHit(branchesOf(value), schema, tableName);
    }

    if (key === "NOT") {
        return firstShardedHit([(value ?? {}) as WhereInput], schema, tableName);
    }

    const relation = schema.tables[tableName]?.relationMap?.[key];

    if (!relation || !isRelationPredicate(value)) {
        return undefined;
    }

    const target = schema.tables[relation.table];

    if (target?.shardMode?.kind === "shardBy") {
        return { kind: "shardBy", relation: key, target: relation.table };
    }

    // Same freeze as a shape declared ON a memory table, one join away: the
    // joined table's writes never enter `__cdc_log`, so membership that turns on
    // one of its rows can change without a single poke. `.global()` tables are
    // exempt — they are served by the D1 snapshot-diff tier, which reads the
    // rows rather than the log.
    if (isMemoryTable(target) && target?.shardMode?.kind !== "global") {
        return { kind: "memory", relation: key, target: relation.table };
    }

    // The relation target isn't sharded itself, but its OWN nested predicate may
    // still hop into a shard — keep descending under the target table.
    return firstShardedHit(Object.values(value), schema, relation.table);
};

/**
 * Walk every relation predicate reachable from `where` (descending through
 * `AND`/`OR`/`NOT` branches and the nested where of each relation operator),
 * returning the first one whose target table the poke loop cannot observe:
 * `.shardBy()` (the rows live in another DO) or `.memory()` (the rows never
 * reach the changelog). Relations to a `root` (same Durable Object) or
 * `.global()` (D1) table are fine.
 */
const findShardedRelationTarget = (where: WhereInput, schema: ResolveContext["schema"], tableName: string): UnpokeableRelationHit | undefined => {
    for (const key of Object.keys(where)) {
        const hit = inspectKey(key, where[key], schema, tableName);

        if (hit) {
            return hit;
        }
    }

    return undefined;
};

/**
 * Registration-time guard for partial-replication shapes: both ways a shape can
 * name rows its poke loop is unable to observe. Called from the generated
 * `resolveShape` override the moment a socket subscribes — the first point the
 * compiled predicate and the schema are both in hand.
 *
 * **1. The shape's own table is `.memory()` — or a relation predicate joins one.** A shard-local shape replicates FROM
 * `__cdc_log`, and `recordCdc` deliberately never appends a memory table (see
 * `ctx-db.ts`: its rows do not survive the next eviction, and log retention is
 * opt-in, so a heartbeat-rate presence table would grow the log without bound).
 * So `readCdcChangeKeys` returns nothing for it on every flush, `buildShapeDiff`
 * returns `[]` before it ever probes membership, and the shape seeds once and
 * then never moves again — no error, no counter, nothing to grep. Refused here
 * rather than left to freeze silently.
 *
 * There is no fix available further down: a full-membership re-probe per poke
 * would emit upserts but could never emit a DELETE, because without the log
 * nothing records which keys left, and the snapshot-diff tier that solves exactly
 * this for `.global()` tables (`diffGlobalMembership` against
 * `__global_shape_snapshot`) is wired to the D1 read path.
 *
 * A JOINED memory table freezes the same way and was the sibling this guard
 * originally missed: `where: { session: { some: { online: true } }}` over a
 * durable table whose `session` target is `.memory()` passes every check on the
 * shape's own table, and then no write to `session` ever moves the membership.
 *
 * **2. The predicate joins a `.shardBy()` table.** A live shape can only be poked
 * from the op-log of its OWN Durable Object, so an `effectiveWhere` that joins to
 * a sharded table reaches rows that live in other DOs the poke loop can never
 * observe.
 */
const assertShapeShardable = (effectiveWhere: WhereInput | undefined, schema: ResolveContext["schema"], table: string): void => {
    if (isMemoryTable(schema.tables[table])) {
        throw new LunoraError(
            "SHAPE_MEMORY_TABLE",
            `shape on "${table}" replicates from the changelog, which never records a .memory() table — the shape would seed once and never update again. Fix it by (a) dropping .memory() from "${table}" so its writes reach the changelog, or (b) reading it through a live query (\`useQuery\`), which refreshes off the changed-table set rather than the log.`,
        );
    }

    if (!effectiveWhere) {
        return;
    }

    const offending = findShardedRelationTarget(effectiveWhere, schema, table);

    if (!offending) {
        return;
    }

    if (offending.kind === "memory") {
        throw new LunoraError(
            "SHAPE_MEMORY_TABLE",
            `shape on "${table}" joins the .memory() table "${offending.target}" via relation "${offending.relation}" — memory writes never reach the changelog, so membership that depends on them would freeze after the first seed. Fix it by (a) dropping .memory() from "${offending.target}", or (b) reading this through a live query (\`useQuery\`), which refreshes off the changed-table set rather than the log.`,
        );
    }

    throw new LunoraError(
        "SHAPE_CROSS_SHARD_JOIN",
        `shape on "${table}" joins the sharded table "${offending.target}" via relation "${offending.relation}" — a live shape cannot replicate rows that live in another shard's Durable Object. Fix it by (a) denormalizing the joined columns into "${table}", or (b) moving "${offending.target}" to .global() so it is served through the latency-tiered D1 shape tier.`,
    );
};

export { assertFlatPredicate, assertShapeShardable, containsRelationPredicate, DEFAULT_MAX_RELATION_KEYS, isRelationPredicate, resolveRelationPredicates };
export type { RelationExistsMarker, ResolveRelationPredicatesOptions };
