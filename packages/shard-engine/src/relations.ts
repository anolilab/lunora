/**
 * Dialect-agnostic relation loader shared by both ORM backends.
 *
 * A relation is resolved as a **batched second fetch** keyed by the foreign
 * key — never an N+1. `resolveWith` takes a page of already-fetched parent
 * rows and, for each requested relation, issues a single `IN (...)` query
 * against the target table, then attaches the loaded rows back onto each
 * parent in place. `_count` aggregation follows the same batching discipline:
 * a single `GROUP BY :fk … WHERE :fk IN (...)` returns every per-parent
 * tally in one round-trip via the injected `groupedCounter`.
 *
 * The fetcher/groupedCounter are injected (the DO passes its `writer.findMany`
 * and a grouped-count helper over the local SQLite, D1 passes its async twins),
 * so the same helper serves both dialects. Nested `with` recurses for free:
 * the injected fetcher re-enters its own `findMany`, which calls `resolveWith`
 * again on the child page.
 *
 * Cross-backend scope: BOTH directions are supported, and routing is the
 * injected `fetcher`/`groupedCounter`'s job — `resolveWith` itself is
 * backend-agnostic. Forward (shard-local parent → global D1 child) is a
 * single bounded `IN (...)` read routed to the D1 writer. Reverse (global D1
 * parent → shard-local child): the child's rows span every shard DO, so the
 * D1 ctx-db routes the child's read/count to an injected cross-shard reader
 * built on the Query Coordinator's RLS-correct `fanOut` (identity forwarded →
 * RLS per shard). When that capability isn't wired the injected fetcher throws
 * a clear "not supported" error, so the loader never pre-rejects the direction
 * itself. Same-backend relations route straight back to the local writer.
 *
 * Ordering caveat (reverse direction only): a `many` relation with `orderBy` +
 * `limit` whose children span MULTIPLE shards is grouped correctly but globally
 * ordered by per-shard-ordered concatenation, not a global merge-sort — so the
 * order+cap is best-effort across shards. `one` and `_count` are exact, and a
 * child sharded by its parent lives on one shard, so its ordering is exact too.
 */

import { LunoraError } from "@lunora/errors";

import { tableColumns } from "./do-sql";
import { applySelect } from "./query-args";
import type {
    FanOutBudget,
    KeyedRelationDefinitionLike,
    NestedWith,
    QueryArgs,
    RelationDefinitionLike,
    ResolveWithOptions,
    ServerDefaultContextLike,
    TableDefinitionLike,
    ThroughRelationDefinitionLike,
    ValidatorLike,
} from "./schema-types";
import { FAN_OUT_BUDGET } from "./schema-types";
import type { WhereInput } from "./where-types";

/**
 * The relation-scoped hooks a read hands down to {@link resolveWith}, pulled off
 * `args` as a unit.
 *
 * Every backend's `findMany` calls `resolveWith` from TWO places (the unpaged and
 * the paged branch), so there are four hand-written call sites across
 * `@lunora/shard-engine` and `@lunora/sql-store` that each have to re-list these
 * fields. That is not hypothetical bookkeeping: the sql-store pair silently
 * drifted from the shard-engine pair and stopped forwarding `relationBaseWhere`
 * at all, which dropped row-level security from every `with` hop on that backend.
 * Spreading this instead means a third relation-scoped hook is added in one place
 * and cannot be forgotten at a call site.
 */
const relationHooks = (
    args: Pick<QueryArgs, "relationBaseWhere" | "relationMask">,
): Pick<QueryArgs, "relationBaseWhere" | "relationMask"> & Pick<ResolveWithOptions, "fanOutBudget"> => {
    return {
        // Lifted back off the symbol the nested `fetcher` args carry it under —
        // see `FAN_OUT_BUDGET`. Doing it here keeps every `resolveWith` call site
        // spreading one thing, and keeps the budget out of the public `QueryArgs`.
        fanOutBudget: (args as { [FAN_OUT_BUDGET]?: FanOutBudget })[FAN_OUT_BUDGET],
        relationBaseWhere: args.relationBaseWhere,
        relationMask: args.relationMask,
    };
};

/** Project a loaded child (or page) per `nested.select`, keeping system + nested-`with` keys. Returns the input unchanged when no select. */
const projectChildren = (documents: Record<string, unknown>[], nested: NestedWith): Record<string, unknown>[] =>
    nested.select ? applySelect(documents, nested.select, nested.with) : documents;

/**
 * Cross-backend fan-out for grouped `_count` on backends whose `groupedCounter`
 * must fall back to scalar calls (e.g. a DO's global-D1 child or the sql-store's
 * cross-shard reverse direction). Issues one `counter(table, where)` per FK
 * value in parallel and collects the results into a Map.
 *
 * Used by both the DO and sql-store `relationGroupedCounter` implementations so
 * the parallel fan-out logic isn't duplicated.
 */
const fanOutScalarCounts = async (
    counter: (tableName: string, where?: WhereInput) => Promise<number>,
    tableName: string,
    whereField: string,
    values: unknown[],
    policyWhere: WhereInput | undefined,
): Promise<Map<unknown, number>> => {
    const pairs = await Promise.all(
        values.map(async (value) => {
            const countWhere: WhereInput = policyWhere ? { AND: [{ [whereField]: value }, policyWhere] } : { [whereField]: value };

            return [value, await counter(tableName, countWhere)] as const;
        }),
    );

    return new Map(pairs);
};

/**
 * The total fan-out reads one request may spend across every `with` level.
 *
 * The fan-out is the only shape that can bound a per-parent `limit` (see
 * `loadMany`), but it costs one read per parent, and on a `fetcher` backed by
 * D1 or Hyperdrive every read is a Workers SUBREQUEST. Those are capped per
 * request — 1000 paid, 50 free — and exceeding the cap is a hard failure, not a
 * slow page: `findMany({ limit: 200, with: { comments: { limit: 3 } } })` would
 * spend 200 of them on one relation.
 *
 * 32 is picked off the FREE-tier cap, not the paid one, and it is deliberately
 * below the width the fan-out was measured at (100 parents, 62x): a page wider
 * than this gives the speed-up back rather than risk a hard failure, because a
 * slow page beats one that cannot run. Both branches return the same rows — the
 * batched one over-fetches and slices, which is the behaviour that shipped
 * before the fan-out — so what is traded away is the tightness of the bound,
 * never correctness.
 *
 * This is a TOTAL, carried in a {@link FanOutBudget} shared by every level of
 * one read, because a per-level cap bounds nothing. Each of up to 32 level-1
 * reads resolves its own nested `with` in its own `fetcher` call, seeing only
 * its own `cap` parents — comfortably under any per-level threshold — so
 * `with: { a: { limit: 5, with: { b: { limit: 5 } } } }` over 32 parents costs
 * 32 + 160 reads, and a third level another 800. A per-level bound is exactly
 * the shape that looks safe and multiplies anyway.
 */
const MAX_FANOUT_READS = 32;

/**
 * The most join rows one many-to-many `with` (or `_count`) hop may read for a whole page of parents.
 *
 * A one-hop `many` pushes a `limit` into the child read, so its cost follows the cap the caller asked for. Here the
 * order and the cap belong to the TARGET read, so the first hop cannot be capped per parent: it has to see every
 * link. Instead of letting that grow with the data, it is bounded, and a page that links more than this fails
 * closed rather than silently dropping links (which would return a wrong, partly empty relation).
 */
const MAX_LINK_ROWS = 10_000;

/**
 * Bucket every child row from a set of pages by the foreign-key value it carries,
 * preserving the order the pages were read in.
 *
 * Lifted out of `loadMany` so the fan-out/batched decision above it stays
 * readable; both branches produce a list of pages and both group them the same
 * way. `project` runs per page rather than per row so a caller's masking sees a
 * whole page at a time.
 */
const groupByForeignKey = (
    pages: Record<string, unknown>[][],
    field: string,
    project: (page: Record<string, unknown>[]) => Record<string, unknown>[],
): Map<unknown, Record<string, unknown>[]> => {
    const groups = new Map<unknown, Record<string, unknown>[]>();

    for (const page of pages) {
        for (const child of project(page)) {
            const key = child[field];
            const group = groups.get(key);

            if (group) {
                group.push(child);
            } else {
                groups.set(key, [child]);
            }
        }
    }

    return groups;
};

/**
 * Attach the shared fan-out budget to a `fetcher`'s args.
 *
 * The one place the cast lives. `QueryArgs` deliberately has no field for this
 * (see {@link FAN_OUT_BUDGET}), so the symbol is an excess property as far as the
 * type is concerned — which is exactly the property that keeps a caller from
 * setting it.
 */
const withBudget = (args: QueryArgs, budget: FanOutBudget): QueryArgs => ({ ...args, [FAN_OUT_BUDGET]: budget }) as QueryArgs;

/** Bucket target rows under every owner that links to them, keeping the order the rows were read in. */
const groupByLinkedOwner = (links: Map<unknown, Set<unknown>>, targets: Record<string, unknown>[]): Map<unknown, Record<string, unknown>[]> => {
    const ownersOf = new Map<unknown, unknown[]>();

    for (const [owner, ids] of links) {
        for (const id of ids) {
            const owners = ownersOf.get(id);

            if (owners) {
                owners.push(owner);
            } else {
                ownersOf.set(id, [owner]);
            }
        }
    }

    const groups = new Map<unknown, Record<string, unknown>[]>();

    for (const target of targets) {
        for (const owner of ownersOf.get(target["_id"]) ?? []) {
            const group = groups.get(owner);

            if (group) {
                group.push(target);
            } else {
                groups.set(owner, [target]);
            }
        }
    }

    return groups;
};

/** Distinct, non-nullish values of `field` across `rows`, preserving first-seen order. */
const distinctValues = (rows: Record<string, unknown>[], field: string): unknown[] => {
    const seen = new Set<unknown>();

    for (const row of rows) {
        const value = row[field];

        if (value !== null && value !== undefined) {
            seen.add(value);
        }
    }

    return [...seen];
};

/**
 * Resolve every requested relation on `parents` (a single already-fetched
 * page), mutating each parent in place: `one` → `Doc | null`, `many` →
 * `Doc[]`, `_count` → merged into `parent._count`.
 */
const resolveWith = async (options: ResolveWithOptions): Promise<void> => {
    const { groupedCounter, fanOutBudget, fetcher, parents, relationBaseWhere, relationMask, schema, tableName, with: withInput } = options;

    // Seeded by the OUTERMOST `resolveWith` and passed down by reference from
    // there, so all levels of one read draw on the same allowance.
    const budget: FanOutBudget = fanOutBudget ?? { remaining: MAX_FANOUT_READS };

    /**
     * Apply the column mask for a hop's TARGET table. Masking lives above
     * `ctx.db` and never sees these rows otherwise — see `RelationMask`. Runs
     * before `projectChildren` so a `select` narrows the already-masked row.
     */
    const masked = (table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] => relationMask?.(table, rows) ?? rows;

    if (parents.length === 0) {
        return;
    }

    const parentDefinition = schema.tables[tableName];

    if (!parentDefinition) {
        throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
    }

    const relationMap = parentDefinition.relationMap ?? {};

    /** Do both tables live in one store, so a grouped count over the target is one query? A `.global()` table and a sharded one each live elsewhere. */
    const sameStore = (left: string, right: string): boolean => {
        const kindOf = (table: string): string => schema.tables[table]?.shardMode?.kind ?? "root";

        return kindOf(left) === kindOf(right) && kindOf(left) !== "shardBy";
    };

    const requireRelation = (name: string): RelationDefinitionLike => {
        const relation = relationMap[name];

        if (!relation) {
            throw new LunoraError("INTERNAL", `unknown relation "${name}" on table "${tableName}"`);
        }

        // Backend routing is the injected `fetcher`/`counter`'s job, not the
        // loader's. A **global** (D1) parent → **shard-local** child is now
        // supported: the D1 ctx-db routes such a child's read/count to an
        // injected cross-shard reader built on the Query Coordinator's
        // RLS-correct `fanOut`. If that capability isn't wired, the injected
        // fetcher throws a clear "not supported" error — so we no longer
        // pre-throw here. The forward direction and same-backend relations are
        // unaffected.
        return relation;
    };

    const loadOne = async (name: string, relation: KeyedRelationDefinitionLike, nested: NestedWith): Promise<void> => {
        const fkValues = distinctValues(parents, relation.field);

        if (fkValues.length === 0) {
            for (const parent of parents) {
                // eslint-disable-next-line unicorn/no-null -- documented `one`-relation result shape (Doc | null) sent to the client
                parent[name] = null;
            }

            return;
        }

        // Apply the child table's read policy on the relation hop (RLS): the
        // policy filter rides `baseWhere` exactly as a top-level read would, and
        // `relationBaseWhere` is threaded on so nested `with` levels inherit it.
        const { page } = await fetcher(
            relation.table,
            withBudget(
                {
                    baseWhere: relationBaseWhere?.(relation.table),
                    relationBaseWhere,
                    relationMask,
                    where: { [relation.references]: { in: fkValues } },
                    with: nested.with,
                },
                budget,
            ),
        );
        const byReference = new Map<unknown, Record<string, unknown>>();

        for (const child of masked(relation.table, page)) {
            byReference.set(child[relation.references], child);
        }

        for (const parent of parents) {
            const child = byReference.get(parent[relation.field]);

            // eslint-disable-next-line unicorn/no-null -- documented `one`-relation result shape (Doc | null) sent to the client
            parent[name] = child ? (projectChildren([child], nested)[0] ?? null) : null;
        }
    };

    /**
     * One read of `table` under a relation hop's refinements: the table's read policy rides `baseWhere` (same as a
     * top-level read), `relationBaseWhere` threads on for nested `with`, and `nested`'s `where`/`orderBy`/`with`
     * apply. Shared by the `many` and the many-to-many loaders.
     */
    const fetchChildren = async (table: string, nested: NestedWith, where: WhereInput, limit: number | undefined): Promise<Record<string, unknown>[]> => {
        const { page } = await fetcher(
            table,
            withBudget(
                {
                    baseWhere: relationBaseWhere?.(table),
                    limit,
                    orderBy: nested.orderBy,
                    relationBaseWhere,
                    relationMask,
                    where: nested.where ? { AND: [nested.where, where] } : where,
                    with: nested.with,
                },
                budget,
            ),
        );

        return page;
    };

    /**
     * Set each parent's `name` to its group of loaded children, keyed by the parent's `keyField`.
     *
     * Still sliced to `cap`: a fan-out read is already bounded, but the batched branch is not, and a cross-shard
     * fetcher concatenates per-shard pages (see this module's ordering caveat) so its `limit` is a per-shard bound
     * rather than a global one.
     */
    const attachGroups = (
        name: string,
        nested: NestedWith,
        cap: number | undefined,
        keyField: string,
        groups: Map<unknown, Record<string, unknown>[]>,
    ): void => {
        for (const parent of parents) {
            const group = groups.get(parent[keyField]) ?? [];

            parent[name] = projectChildren(cap === undefined ? group : group.slice(0, cap), nested);
        }
    };

    const loadMany = async (name: string, relation: KeyedRelationDefinitionLike, nested: NestedWith): Promise<void> => {
        const referenceValues = distinctValues(parents, relation.references);

        if (referenceValues.length === 0) {
            for (const parent of parents) {
                parent[name] = [];
            }

            return;
        }

        const cap = typeof nested.limit === "number" ? Math.max(0, Math.floor(nested.limit)) : undefined;

        const fetchWhere = (where: WhereInput, limit: number | undefined): Promise<Record<string, unknown>[]> =>
            fetchChildren(relation.table, nested, where, limit);

        /**
         * `with: { rel: { limit: n } }` bounds the fetch, not just the result.
         *
         * One batched `IN (...)` read cannot: a single `LIMIT` over the whole
         * batch has no way to give each parent its own n — the first parent's
         * children would consume the budget and later parents would come back
         * empty. So a capped relation fans out one bounded read per parent key
         * instead, in parallel, the same shape `fanOutScalarCounts` already uses
         * for `_count` on the backends whose grouped count has to degrade.
         *
         * Slicing after an unbounded fetch (what this did) meant a 100-parent
         * page asking for 5 children each materialized EVERY child of all 100
         * parents and threw away all but 500 rows — unbounded in exactly the way
         * a `limit` reads as preventing.
         *
         * ponytail: P bounded reads instead of 1 unbounded one, and only up to
         * {@link MAX_FANOUT_READS} of them. A window function
         * (`ROW_NUMBER() OVER (PARTITION BY fk ...)`) would do it in one, but the
         * injected `fetcher` is a `findMany`-shaped interface with no way to say
         * that — which is the point at which it would be worth widening.
         */
        // `cap === 0` is answered without reading anything, so it neither needs
        // the fan-out nor may pay for it: charging the budget for reads it does
        // not issue lets a `limit: 0` relation exhaust the allowance and push a
        // LATER capped relation onto the unbounded batched path, which is the
        // over-fetch the budget exists to bound.
        if (cap === 0) {
            for (const parent of parents) {
                parent[name] = [];
            }

            return;
        }

        const canFanOut = cap !== undefined && referenceValues.length <= budget.remaining;

        if (canFanOut) {
            budget.remaining -= referenceValues.length;
        }

        const pages = canFanOut
            ? await Promise.all(referenceValues.map(async (value) => fetchWhere({ [relation.field]: value }, cap)))
            : [await fetchWhere({ [relation.field]: { in: referenceValues } }, undefined)];

        const groups = groupByForeignKey(pages, relation.field, (page) => masked(relation.table, page));

        attachGroups(name, nested, cap, relation.references, groups);
    };

    /**
     * The join rows of every parent as `parent id → linked target ids`, read under the join table's own read
     * policy so a link the caller may not see is not a link. The first hop of a many-to-many load, bounded by
     * {@link MAX_LINK_ROWS}.
     */
    const loadLinks = async (relation: ThroughRelationDefinitionLike): Promise<Map<unknown, Set<unknown>>> => {
        const { from, table, to } = relation.through;
        const links = new Map<unknown, Set<unknown>>();
        const ownerIds = distinctValues(parents, "_id");

        if (ownerIds.length === 0) {
            return links;
        }

        const rows = await fetchChildren(table, {}, { [from]: { in: ownerIds } }, MAX_LINK_ROWS + 1);

        if (rows.length > MAX_LINK_ROWS) {
            throw new LunoraError(
                "INTERNAL",
                `loading "${tableName}" relations through "${table}" read more than ${String(MAX_LINK_ROWS)} join rows for one page; load fewer ${tableName} rows at a time`,
            );
        }

        for (const row of masked(table, rows)) {
            const owner = row[from];
            const target = row[to];

            if (owner === null || owner === undefined || target === null || target === undefined) {
                continue;
            }

            const linked = links.get(owner);

            if (linked) {
                linked.add(target);
            } else {
                links.set(owner, new Set([target]));
            }
        }

        return links;
    };

    /**
     * A many-to-many relation is two of the batched hops the other kinds already make: the join rows keyed by the
     * parent, then the target rows keyed by the ids those rows name. A `limit` fans out one bounded target read per
     * parent exactly as {@link loadMany} does, and draws on the same budget; rows come back in the target read's
     * order (its `orderBy`), not in the order the join rows were created.
     */
    const loadThrough = async (name: string, relation: ThroughRelationDefinitionLike, nested: NestedWith): Promise<void> => {
        const cap = typeof nested.limit === "number" ? Math.max(0, Math.floor(nested.limit)) : undefined;
        const links = cap === 0 ? new Map<unknown, Set<unknown>>() : await loadLinks(relation);
        const fetchTargets = (ids: Iterable<unknown>, limit: number | undefined): Promise<Record<string, unknown>[]> =>
            fetchChildren(relation.table, nested, { _id: { in: [...ids] } }, limit);

        let byOwner = new Map<unknown, Record<string, unknown>[]>();

        if (links.size > 0 && cap !== undefined && links.size <= budget.remaining) {
            budget.remaining -= links.size;

            const owners = [...links.keys()];
            const pages = await Promise.all([...links.values()].map(async (ids) => fetchTargets(ids, cap)));

            byOwner = new Map(owners.map((owner, index) => [owner, masked(relation.table, pages[index] ?? [])]));
        } else if (links.size > 0) {
            const linkedIds = new Set([...links.values()].flatMap((ids) => [...ids]));

            byOwner = groupByLinkedOwner(links, masked(relation.table, await fetchTargets(linkedIds, undefined)));
        }

        attachGroups(name, nested, cap, "_id", byOwner);
    };

    /**
     * The number of `linked` ids that name a target row the caller can read. One grouped count when the target lives
     * in the same store as the parent, which hydrates no rows; a cross-backend target falls back to reading the rows,
     * because its grouped counter degrades to one read PER id, which a page of links would multiply.
     */
    const countReadable = async (target: string, linked: Set<unknown>): Promise<Set<unknown>> => {
        const ids = [...linked];

        if (ids.length === 0) {
            return new Set();
        }

        if (sameStore(tableName, target)) {
            const counts = await groupedCounter(target, "_id", ids, relationBaseWhere?.(target));

            return new Set(ids.filter((id) => (counts.get(id) ?? 0) > 0));
        }

        const rows = await fetchChildren(target, {}, { _id: { in: ids } }, undefined);

        return new Set(rows.map((row) => row["_id"]));
    };

    /**
     * `_count` over a many-to-many relation counts the target rows the caller can read, not the join rows: a link to
     * a row the target's read policy hides (or one that no longer exists) is not counted. That takes both hops,
     * where a one-to-many count is a single grouped query.
     */
    const countThrough = async (name: string, relation: ThroughRelationDefinitionLike): Promise<void> => {
        const links = await loadLinks(relation);
        const visible = await countReadable(relation.table, new Set([...links.values()].flatMap((linked) => [...linked])));

        for (const parent of parents) {
            const counts = (parent["_count"] as Record<string, number> | undefined) ?? {};

            counts[name] = [...(links.get(parent["_id"]) ?? [])].filter((id) => visible.has(id)).length;
            parent["_count"] = counts;
        }
    };

    const resolveCounts = async (countInput: Record<string, true>): Promise<void> => {
        for (const name of Object.keys(countInput)) {
            const relation = requireRelation(name);

            if (relation.through !== undefined) {
                // eslint-disable-next-line no-await-in-loop -- one two-hop count per relation
                await countThrough(name, relation);

                continue;
            }

            // `many`: count children whose FK matches this parent's reference.
            // `one`: count target rows the parent's FK points at (0 or 1).
            const [whereField, parentField] = relation.kind === "many" ? [relation.field, relation.references] : [relation.references, relation.field];

            // RLS: AND the child table's read policy into the grouped count so
            // a `_count` can never reveal rows the caller couldn't read.
            const policyWhere = relationBaseWhere?.(relation.table);

            // Collect the distinct parent values we need counts for; skip the
            // query entirely when the page is empty or all FKs are null.
            const values = distinctValues(parents, parentField);

            // Single grouped query: GROUP BY <whereField> WHERE <whereField> IN (values).
            // All per-parent tallies come back in one round-trip. The outer loop
            // is per-relation (sequential over relations, not per value); each
            // iteration issues exactly one async call.
            // eslint-disable-next-line no-await-in-loop -- one grouped query per relation; collapses D per-value queries into 1
            const countByValue = values.length === 0 ? new Map<unknown, number>() : await groupedCounter(relation.table, whereField, values, policyWhere);

            for (const parent of parents) {
                const counts = (parent["_count"] as Record<string, number> | undefined) ?? {};
                const parentValue = parent[parentField];

                // JS SameValueZero Map lookup: safe for string ids; numeric FK
                // values must arrive from SQL as the same JS type as parent[parentField]
                // (the SQL→JS key-equality invariant introduced by the grouped path).
                counts[name] = parentValue === null || parentValue === undefined ? 0 : (countByValue.get(parentValue) ?? 0);
                parent["_count"] = counts;
            }
        }
    };

    for (const [name, value] of Object.entries(withInput)) {
        if (value === undefined || value === false) {
            continue;
        }

        if (name === "_count") {
            // eslint-disable-next-line no-await-in-loop -- relations resolved sequentially; each batched fetch mutates the shared parent page in place
            await resolveCounts(value as Record<string, true>);

            continue;
        }

        const relation = requireRelation(name);
        const nested: NestedWith = value === true ? {} : value;

        if (relation.through === undefined) {
            // eslint-disable-next-line no-await-in-loop -- same
            await (relation.kind === "one" ? loadOne(name, relation, nested) : loadMany(name, relation, nested));
        } else {
            // eslint-disable-next-line no-await-in-loop -- same
            await loadThrough(name, relation, nested);
        }
    }
};

/**
 * Apply declared `onDelete` actions to rows that hold an FK to the row being
 * deleted, **before** the physical delete runs (so `restrict` can abort and
 * per-row broadcast/onWrite still fire for cascaded deletes).
 *
 * Walks every `one` relation across the schema whose target is `tableName`;
 * for each, finds holder rows pointing at `id` and applies the action:
 * `cascade` → recursive `writer.delete` (chains), `set null` → `writer.patch`
 * the FK to null, `restrict` → throw via `onRestrict` when any holder exists.
 */
interface ApplyOnDeleteOptions {
    deletedId: string;
    deletedReference: (references: string) => unknown;

    /**
     * Locate holder rows pointing at the deleted parent. Receives the
     * `holderTable` so the caller can route to the right backend
     * (DO SQLite vs D1) per-table.
     */
    findHolders: (holderTable: string, field: string, value: unknown) => Promise<Record<string, unknown>[]>;

    /**
     * Delete a holder row. `holderTable` is the row's table so the caller can
     * route the delete to the matching backend's writer — same shape as
     * `findHolders`.
     */
    onCascade: (holderTable: string, id: string) => Promise<void>;
    onRestrict: (message: string) => never;

    /**
     * Null out the FK on a holder row. `holderTable` lets the caller route
     * the patch to the right backend.
     */
    onSetNull: (holderTable: string, id: string, field: string) => Promise<void>;
    schema: { readonly tables: Record<string, TableDefinitionLike> };
    tableName: string;
}

/**
 * Apply the `onDelete` action for a single holder relation pointing at the
 * deleted parent. Resolves the referenced value, finds holder rows and either
 * aborts (`restrict`), cascades the delete, or nulls the FK.
 *
 * Cross-backend cascade is not rejected here: backend-aware callbacks (each
 * receives `holderTable`) route to the right writer. The supported direction
 * (DO → D1) routes through the global writer the codegen passes into
 * `createShardCtxDb`; the unsupported direction (D1 → many shards) throws via
 * the D1 caller's `findHolders`, so this helper stays backend-agnostic.
 *
 * **Atomicity caveat.** A cross-backend cascade is not transactional: the
 * global cascade fires *before* the local DELETE commits. If the cascade
 * succeeds and the local DELETE then fails, the parent row stays but its
 * global holders are gone. Callers that care should add their own
 * compensation (a periodic reconciliation job, or a Cloudflare Queue retry).
 */
const applyRelationOnDelete = async (options: ApplyOnDeleteOptions, holderTable: string, relation: KeyedRelationDefinitionLike): Promise<void> => {
    const { deletedId, deletedReference, findHolders, onCascade, onRestrict, onSetNull, tableName } = options;
    const referencedValue = relation.references === "_id" ? deletedId : deletedReference(relation.references);

    if (referencedValue === null || referencedValue === undefined) {
        return;
    }

    const holders = await findHolders(holderTable, relation.field, referencedValue);

    if (holders.length === 0) {
        return;
    }

    if (relation.onDelete === "restrict") {
        onRestrict(`cannot delete "${tableName}" row: "${holderTable}.${relation.field}" still references it`);
    }

    for (const holder of holders) {
        const holderId = holder["_id"];

        if (typeof holderId !== "string") {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- holders are cascaded/nulled one at a time so a thrown restrict/cascade aborts deterministically
        await (relation.onDelete === "cascade" ? onCascade(holderTable, holderId) : onSetNull(holderTable, holderId, relation.field));
    }
};

const applyOnDelete = async (options: ApplyOnDeleteOptions): Promise<void> => {
    const { schema, tableName } = options;

    if (!schema.tables[tableName]) {
        throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
    }

    for (const [holderTable, holderDefinition] of Object.entries(schema.tables)) {
        const relations = holderDefinition.relationMap;

        if (!relations) {
            continue;
        }

        for (const relation of Object.values(relations)) {
            if (relation.kind !== "one" || relation.table !== tableName || !relation.onDelete) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- relations applied sequentially so a `restrict` abort/cascade fires in declared order before the parent delete
            await applyRelationOnDelete(options, holderTable, relation);
        }
    }
};

const transformCache = new WeakMap<ValidatorLike, boolean>();

/**
 * Whether a column holds a `v.from(schema)` anywhere inside it — bare, or under
 * `v.optional` / `v.array` / `v.object` / `v.record` / `v.union` (a nullable keeps the
 * inner kind). Those are the only columns whose `parse()` is not idempotent: a
 * transform (`z.string().transform(Number)`) changes the value, so its output may
 * not be valid input to the same schema (or is transformed a second time). A write
 * therefore parses such a column only when it carries a NEW value — see
 * `RowValidatorOptions.previous` for how stored output handed back is told apart.
 */
const hasTransform = (validator: ValidatorLike): boolean => {
    const cached = transformCache.get(validator);

    if (cached !== undefined) {
        return cached;
    }

    // `v.record`'s key and value validators are not on the structural `_meta` type.
    const meta: (NonNullable<ValidatorLike["_meta"]> & { readonly keyValidator?: ValidatorLike; readonly valueValidator?: ValidatorLike }) | undefined =
        validator._meta;
    const children = [meta?.inner, meta?.keyValidator, meta?.valueValidator, ...(meta?.members ?? []), ...Object.values(meta?.shape ?? {})];
    const result = validator.kind === "from" || children.some((child) => child !== undefined && hasTransform(child));

    transformCache.set(validator, result);

    return result;
};

const isPlain = (value: object): boolean => {
    const prototype: unknown = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
};

const bytesOf = (value: unknown): Uint8Array | undefined => {
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : undefined;
};

/**
 * Structural equality over what a column stores: primitives, dates, byte buffers (by content),
 * arrays and plain objects. Any other object (a `Map`, a class instance) is never equal to
 * another, so a value of that kind is parsed rather than trusted as stored output.
 */
const sameValue = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) {
        return true;
    }

    if (a instanceof Date && b instanceof Date) {
        return a.getTime() === b.getTime();
    }

    const leftBytes = bytesOf(a);
    const rightBytes = bytesOf(b);

    if (leftBytes !== undefined || rightBytes !== undefined) {
        return (
            leftBytes !== undefined &&
            rightBytes !== undefined &&
            Object.getPrototypeOf(a) === Object.getPrototypeOf(b) &&
            leftBytes.length === rightBytes.length &&
            leftBytes.every((byte, index) => byte === rightBytes[index])
        );
    }

    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
    }

    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
        return false;
    }

    if (!isPlain(a) || !isPlain(b)) {
        return false;
    }

    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);

    return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]));
};

const transformShapeCache = new WeakMap<TableDefinitionLike, TableDefinitionLike | undefined>();

/**
 * The table narrowed to its transform columns (see {@link hasTransform}), or `undefined` when it has none.
 * Running `runRowValidators` over it adopts the parsed output of those columns without validating the
 * rest — the shape `insertManyUnsafe` needs. Computed once per table.
 */
const transformOnlyDefinition = (definition: TableDefinitionLike): TableDefinitionLike | undefined => {
    if (transformShapeCache.has(definition)) {
        return transformShapeCache.get(definition);
    }

    const shape = Object.fromEntries(Object.entries(definition.shape).filter(([, validator]) => hasTransform(validator)));
    const narrowed = Object.keys(shape).length > 0 ? { ...definition, shape } : undefined;

    transformShapeCache.set(definition, narrowed);

    return narrowed;
};

interface RowValidatorOptions {
    /**
     * Parse transform columns only for these fields; the rest are skipped. A patch
     * passes the keys it sets, because the others in the merged row are already
     * stored output and must not be fed through their transform again. A field an
     * update hook assigned is not among them: a hook returns the stored form.
     */
    only?: ReadonlySet<string>;

    /**
     * The row being overwritten (`patch` and `replace`), read lazily. A transform
     * column whose value deep-equals the stored one is that stored OUTPUT handed
     * back — `{ ...(await db.get(id)), x: 1 }` — so it is passed through unparsed;
     * only a value that differs from what is stored is treated as new input. That cannot tell
     * a read-back spread from an explicit re-entry of the same value, so for a non-idempotent
     * transform an explicit write equal to the stored output is kept as is, not re-parsed.
     */
    previous?: () => Readonly<Record<string, unknown>> | undefined;

    /**
     * The document as the caller wrote it, before defaults and update hooks filled in
     * the rest (`insert`, `replace`). Only the transform columns it carries are INPUT
     * and parsed; a value from `.default()`, `.$defaultFn()`, `.$onUpdateFn()` or a
     * `.serverDefault()` is declared as the stored form and kept as is. Ignored when
     * `only` is set.
     */
    supplied?: Readonly<Record<string, unknown>>;

    /**
     * Skip a `null` on an optional field (see below). Set on the patch path only.
     */
    tolerateStoredNull?: boolean;

    /**
     * The document is a replay of an already-stored row (an import, a CDC apply, a
     * data-migration rewrite — the writes made under `allowExplicitId`), so its
     * transform columns hold output, not input, and are neither parsed nor adopted.
     */
    trusted?: boolean;
}

/** A check for "this value is what the row already stores", reading the stored row once and only if asked. */
const storedValueCheck = (previous: RowValidatorOptions["previous"]): ((field: string, value: unknown) => boolean) => {
    let row: Readonly<Record<string, unknown>> | undefined;

    return (field, value) => {
        if (previous === undefined) {
            return false;
        }

        row ??= previous() ?? {};

        return field in row && sameValue(value, row[field]);
    };
};

/**
 * The fields of `supplied` the caller really wrote: not an `undefined` (which defaults fill) and
 * not a `.serverDefault()` column (which is stamped over whatever was sent).
 */
const callerFields = (definition: TableDefinitionLike, supplied: Readonly<Record<string, unknown>>): Set<string> => {
    const fields = new Set(Object.keys(supplied).filter((field) => supplied[field] !== undefined));

    for (const [field, column] of tableColumns(definition)) {
        if (column.serverDefault) {
            fields.delete(field);
        }
    }

    return fields;
};

/**
 * Whether a transform column's value is already stored output rather than input: the write
 * replays a stored row, the column is one the caller did not write (`only`), or it equals what is stored.
 */
const holdsStoredOutput = (
    field: string,
    value: unknown,
    options: RowValidatorOptions,
    only: ReadonlySet<string> | undefined,
    isStored: (field: string, value: unknown) => boolean,
): boolean => options.trusted === true || (only !== undefined && !only.has(field)) || isStored(field, value);

/**
 * A copy of a declared default that no write can alias: plain objects, arrays, dates, byte
 * buffers, maps and sets are copied deeply; any other object (a `URL`, a class instance) is
 * handed out as is, because `structuredClone` throws on it or flattens it to a plain object.
 */
const cloneDefault = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) {
        return value;
    }

    if (value instanceof Date) {
        return new Date(value);
    }

    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return structuredClone(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => cloneDefault(item));
    }

    if (value instanceof Map) {
        return new Map([...value].map(([key, item]) => [cloneDefault(key), cloneDefault(item)]));
    }

    if (value instanceof Set) {
        return new Set([...value].map((item) => cloneDefault(item)));
    }

    if (!isPlain(value)) {
        return value;
    }

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDefault(item)]));
};

/**
 * Fill any field absent from `document` that declares a `.default()` literal or
 * `.$defaultFn()` factory. The factory wins when both are present; a literal is
 * applied on presence (`"defaultValue" in column`), so `null`/`false`/`0`
 * defaults survive.
 *
 * A `.serverDefault(fn)` column is SERVER-trusted: it is always stamped from
 * `auth` (overwriting any client-supplied value), so owner/tenant ids can never
 * be set by the client.
 */
const applyInsertDefaults = (
    definition: TableDefinitionLike,
    document: Record<string, unknown>,
    auth: ServerDefaultContextLike["auth"],
): Record<string, unknown> => {
    const result = { ...document };

    for (const [field, column] of tableColumns(definition)) {
        if (column.serverDefault) {
            result[field] = column.serverDefault({ auth });

            continue;
        }

        if (result[field] !== undefined) {
            continue;
        }

        if (column.defaultFn) {
            result[field] = column.defaultFn();
        } else if ("defaultValue" in column) {
            // The literal is declared once in the schema. An object or array handed out by
            // reference lets a hook that mutates one inserted row rewrite the default of
            // every insert after it.
            const { defaultValue } = column;

            result[field] = cloneDefault(defaultValue);
        }
    }

    return result;
};

/**
 * Run each declared column's `validator.parse()` against the matching field on
 * `document`. Fires user refinements (e.g. `v.number().check(n => n >= 0)`)
 * at write time so an invariant violation surfaces as a `ValidationError`
 * before the row hits SQL.
 *
 * Skips fields the validator doesn't declare a `parse` for (the structural
 * fakes used in DO/D1 unit tests omit it), fields absent from the document, and
 * — only when `options.tolerateStoredNull` is set, i.e. on the patch path — a `null` on
 * an optional field (see below). The shape is iterated, not the document, so
 * unknown fields pass through untouched — they're part of the JSON-blob shape
 * but not part of the schema's declared columns.
 *
 * Returns the document to store. It is the argument itself unless a transform
 * column was parsed, in which case it is a copy carrying that column's parsed
 * OUTPUT — reads are typed as the output, so that is what must be stored. Only
 * a value the caller wrote is parsed (see `supplied` / `only`): a default or an
 * update hook already yields the output type and is stored as declared. A column
 * counts as one when a `v.from` sits anywhere inside it (an array element, an
 * object field, a doubly-wrapped optional). Every other column keeps storing what the caller supplied: their parsers are
 * idempotent, and adopting a normalised result (`v.bytes()` turning a view into
 * an `ArrayBuffer`) would change how a column is stored, not just validate it.
 *
 * Lives here (alongside `applyOnDelete`) rather than in each backend's
 * `ctx-db.ts` so DO + D1 share one implementation instead of two drift-prone
 * copies. The signature is intentionally `validator.parse?` so the unit-test
 * fakes (which never carry a runtime parser) keep working.
 */
const runRowValidators = (definition: TableDefinitionLike, document: Record<string, unknown>, options: RowValidatorOptions = {}): Record<string, unknown> => {
    let parsed: Record<string, unknown> | undefined;
    const isStored = storedValueCheck(options.previous);
    const only = options.only ?? (options.supplied === undefined ? undefined : callerFields(definition, options.supplied));

    for (const [field, validator] of Object.entries(definition.shape)) {
        if (!(field in document)) {
            continue;
        }

        if (typeof validator.parse !== "function") {
            continue;
        }

        const fromColumn = hasTransform(validator);

        if (fromColumn && holdsStoredOutput(field, document[field], options, only, isStored)) {
            continue;
        }

        // A `null` on an OPTIONAL field is skipped like an absent field, but ONLY on
        // the patch path, where the document is `{...existing, ...patch}` and the null
        // may well be one the store itself produced: `onDelete: "set null"` writes the
        // FK as null by design, and a `.global()` read returns SQL NULL for every
        // column that was never set. `v.optional(x)` admits `undefined` and rejects
        // `null`, so validating those would fail a patch of one field because of a
        // *different* column nobody touched.
        //
        // Insert and replace stay strict, because there the whole document is
        // caller-supplied — tolerating null on those paths would let a caller persist
        // an explicit `null` into a column the generated types promise is
        // `T | undefined`, which on the DO backend is a *distinct* stored value (the
        // document is JSON-serialized whole, so `"x": null` is not an absent key) and
        // would reintroduce the very null-vs-undefined hazard this guard exists for.
        //
        // Required fields are unaffected on every path: a null there is a genuine
        // violation and still throws.
        if (options.tolerateStoredNull === true && document[field] === null && validator.kind === "optional") {
            continue;
        }

        // Re-parse the field; the validator's own ValidationError carries the
        // refinement message and propagates up to the caller unchanged.
        const result = validator.parse(document[field]);

        if (fromColumn) {
            parsed ??= { ...document };
            parsed[field] = result;
        }
    }

    return parsed ?? document;
};

export {
    applyInsertDefaults,
    applyOnDelete,
    distinctValues,
    fanOutScalarCounts,
    MAX_LINK_ROWS,
    relationHooks,
    resolveWith,
    runRowValidators,
    transformOnlyDefinition,
};
export type { ApplyOnDeleteOptions };
