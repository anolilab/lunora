/**
 * Dialect-agnostic relation loader shared by both ORM backends.
 *
 * A relation is resolved as a **batched second fetch** keyed by the foreign
 * key — never an N+1. `resolveWith` takes a page of already-fetched parent
 * rows and, for each requested relation, issues a single `IN (...)` query
 * against the target table, then attaches the loaded rows back onto each
 * parent in place. `_count` aggregation is the one exception: it issues one
 * `count` per *distinct* parent FK value (no single GROUP BY yet), since the
 * injected `counter` returns a scalar rather than grouped tallies.
 *
 * The fetcher/counter are injected (the DO passes its `writer.findMany` /
 * `writer.count`, D1 passes its async twins), so the same helper serves both
 * dialects. Nested `with` recurses for free: the injected fetcher re-enters
 * its own `findMany`, which calls `resolveWith` again on the child page.
 *
 * Cross-backend scope: BOTH directions are supported, and routing is the
 * injected `fetcher`/`counter`'s job — `resolveWith` itself is backend-agnostic.
 * Forward (shard-local parent → global D1 child) is a single bounded `IN (...)`
 * read routed to the D1 writer. Reverse (global D1 parent → shard-local child):
 * the child's rows span every shard DO, so the D1 ctx-db routes the child's
 * read/count to an injected cross-shard reader built on the Query Coordinator's
 * RLS-correct `fanOut` (identity forwarded → RLS per shard). When that
 * capability isn't wired the injected fetcher throws a clear "not supported"
 * error, so the loader never pre-rejects the direction itself. Same-backend
 * relations route straight back to the local writer.
 *
 * Ordering caveat (reverse direction only): a `many` relation with `orderBy` +
 * `limit` whose children span MULTIPLE shards is grouped correctly but globally
 * ordered by per-shard-ordered concatenation, not a global merge-sort — so the
 * order+cap is best-effort across shards. `one` and `_count` are exact, and a
 * child sharded by its parent lives on one shard, so its ordering is exact too.
 */

import type { TableDefinitionLike } from "./ctx-db";
import type { OrderByInput, QueryArgs, QueryPage } from "./query-args";
import type { WhereInput } from "./where-clause-compiler";

/** FK behaviour when a referenced parent row is deleted (mirrors SQL `ON DELETE`). */
type OnDeleteActionLike = "cascade" | "restrict" | "set null";

/**
 * Structural mirror of `@cirrus/server`'s `RelationDefinition` (kept local so
 * this package takes no runtime dependency on the server package — same
 * reasoning as {@link TableDefinitionLike}).
 */
interface RelationDefinitionLike {
    readonly field: string;
    readonly kind: "many" | "one";
    readonly onDelete?: OnDeleteActionLike;
    readonly references: string;
    readonly table: string;
}

/** Per-relation refinements: filter / order / cap / recurse into the children. */
interface NestedWith {
    limit?: number;
    orderBy?: OrderByInput[];
    where?: WhereInput;
    with?: WithInput;
}

/**
 * The `with` argument. Each key is a relation name resolving to either `true`
 * (load with no refinements) or a {@link NestedWith}. The reserved `_count`
 * key requests per-parent aggregate counts instead of loaded rows.
 */
interface WithInput {
    [relationName: string]: NestedWith | Record<string, true> | boolean | undefined;
    _count?: Record<string, true>;
}

interface ResolveWithOptions {
    counter: (tableName: string, where?: WhereInput) => Promise<number>;
    fetcher: (tableName: string, args: QueryArgs) => Promise<QueryPage>;
    parents: Record<string, unknown>[];
    schema: { readonly tables: Record<string, TableDefinitionLike> };
    tableName: string;
    with: WithInput;
}

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
    const { counter, fetcher, parents, schema, tableName, with: withInput } = options;

    if (parents.length === 0) {
        return;
    }

    const parentDefinition = schema.tables[tableName];

    if (!parentDefinition) {
        throw new Error(`unknown table: ${tableName}`);
    }

    const relationMap = parentDefinition.relationMap ?? {};

    const requireRelation = (name: string): RelationDefinitionLike => {
        const relation = relationMap[name];

        if (!relation) {
            throw new Error(`unknown relation "${name}" on table "${tableName}"`);
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

    const loadOne = async (name: string, relation: RelationDefinitionLike, nested: NestedWith): Promise<void> => {
        const fkValues = distinctValues(parents, relation.field);

        if (fkValues.length === 0) {
            for (const parent of parents) {
                // eslint-disable-next-line unicorn/no-null -- documented `one`-relation result shape (Doc | null) sent to the client
                parent[name] = null;
            }

            return;
        }

        const { page } = await fetcher(relation.table, { where: { [relation.references]: { in: fkValues } }, with: nested.with });
        const byReference = new Map<unknown, Record<string, unknown>>();

        for (const child of page) {
            byReference.set(child[relation.references], child);
        }

        for (const parent of parents) {
            // eslint-disable-next-line unicorn/no-null -- documented `one`-relation result shape (Doc | null) sent to the client
            parent[name] = byReference.get(parent[relation.field]) ?? null;
        }
    };

    const loadMany = async (name: string, relation: RelationDefinitionLike, nested: NestedWith): Promise<void> => {
        const referenceValues = distinctValues(parents, relation.references);

        if (referenceValues.length === 0) {
            for (const parent of parents) {
                parent[name] = [];
            }

            return;
        }

        const fkFilter: WhereInput = { [relation.field]: { in: referenceValues } };
        const where: WhereInput = nested.where ? { AND: [nested.where, fkFilter] } : fkFilter;
        const { page } = await fetcher(relation.table, { orderBy: nested.orderBy, where, with: nested.with });

        const groups = new Map<unknown, Record<string, unknown>[]>();

        for (const child of page) {
            const key = child[relation.field];
            const group = groups.get(key);

            if (group) {
                group.push(child);
            } else {
                groups.set(key, [child]);
            }
        }

        const cap = typeof nested.limit === "number" ? Math.max(0, Math.floor(nested.limit)) : undefined;

        for (const parent of parents) {
            const group = groups.get(parent[relation.references]) ?? [];

            parent[name] = cap === undefined ? group : group.slice(0, cap);
        }
    };

    const resolveCounts = async (countInput: Record<string, true>): Promise<void> => {
        for (const name of Object.keys(countInput)) {
            const relation = requireRelation(name);
            // `many`: count children whose FK matches this parent's reference.
            // `one`: count target rows the parent's FK points at (0 or 1).
            const [whereField, parentField] = relation.kind === "many" ? [relation.field, relation.references] : [relation.references, relation.field];

            // One count per *distinct* parent value (deduped), so repeated FKs
            // across the page collapse to a single aggregate query each.
            const countByValue = new Map<unknown, number>();

            for (const value of distinctValues(parents, parentField)) {
                // eslint-disable-next-line no-await-in-loop -- one aggregate query per distinct FK value; sequential keeps the count fan-out bounded
                countByValue.set(value, await counter(relation.table, { [whereField]: value }));
            }

            for (const parent of parents) {
                const counts = (parent["_count"] as Record<string, number> | undefined) ?? {};
                const parentValue = parent[parentField];

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

        // eslint-disable-next-line no-await-in-loop -- relations resolved sequentially; each batched fetch mutates the shared parent page in place
        await (relation.kind === "one" ? loadOne(name, relation, nested) : loadMany(name, relation, nested));
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
const applyRelationOnDelete = async (options: ApplyOnDeleteOptions, holderTable: string, relation: RelationDefinitionLike): Promise<void> => {
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
        throw new Error(`unknown table: ${tableName}`);
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

/**
 * Run each declared column's `validator.parse()` against the matching field on
 * `document`. Fires user refinements (e.g. `v.number().check(n => n >= 0)`)
 * at write time so an invariant violation surfaces as a `ValidationError`
 * before the row hits SQL.
 *
 * Skips fields the validator doesn't declare a `parse` for (the structural
 * fakes used in DO/D1 unit tests omit it) and skips fields absent from the
 * document. The shape is iterated, not the document, so unknown fields pass
 * through untouched — they're part of the JSON-blob shape but not part of the
 * schema's declared columns.
 *
 * Lives here (alongside `applyOnDelete`) rather than in each backend's
 * `ctx-db.ts` so DO + D1 share one implementation instead of two drift-prone
 * copies. The signature is intentionally `validator.parse?` so the unit-test
 * fakes (which never carry a runtime parser) keep working.
 */
const runRowValidators = (definition: TableDefinitionLike, document: Record<string, unknown>): void => {
    for (const [field, validator] of Object.entries(definition.shape)) {
        if (!(field in document)) {
            continue;
        }

        if (typeof validator.parse !== "function") {
            continue;
        }

        // Re-parse the field; the validator's own ValidationError carries the
        // refinement message and propagates up to the caller unchanged.
        validator.parse(document[field]);
    }
};

export { applyOnDelete, resolveWith, runRowValidators };
export type { ApplyOnDeleteOptions, NestedWith, OnDeleteActionLike, RelationDefinitionLike, ResolveWithOptions, WithInput };
