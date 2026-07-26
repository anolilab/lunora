/**
 * A change **plan** — a description of a write, applicable to either side of a
 * custom mutator.
 *
 * A Lunora custom mutator is two implementations of the same intent: an optimistic
 * body that writes local collections, and an authoritative server body that writes
 * `ctx.db`. Keeping them in agreement is the whole trust model — the server is the
 * linearization point, so a client body that predicts something different produces a
 * visible correction, and a client body that predicts something *wrong* produces a
 * bug that only reproduces under latency.
 *
 * The pattern that keeps them honest is to compute the write once as data, then
 * apply it twice:
 *
 * ```ts
 * // shared/plans.ts — pure, no ctx, no collection. Testable on its own.
 * export const planIndent = (index: TreeIndex, id: string): ChangePlan | undefined => …;
 *
 * // client mutator
 * apply: ({ collections }, args) => {
 *     const plan = planIndent(buildIndex(collections.nodes), args.id);
 *     if (plan) applyPlanToCollections(collections, plan);
 * }
 *
 * // server mutator
 * handler: async ({ args, ctx }) => {
 *     const plan = planIndent(await buildIndex(ctx.db), args.id);
 *     if (plan) await applyPlanToDb(ctx.db, plan);
 * }
 * ```
 *
 * The planner is yours (it encodes your domain). What this module owns is the boring
 * half nobody should write twice: the two appliers, agreeing on ordering, so the
 * client and server can't drift on *how* a plan lands even if they agree on what it
 * says.
 */

/* eslint-disable no-underscore-dangle -- `_id` is the Lunora document-id field rows are keyed by */

import type { Collection } from "@tanstack/db";

import type { Row } from "./internals";

/** One row to insert. `_id` may be pre-minted client-side so the optimistic row keys match the persisted one. */
export interface PlanInsert {
    /** Row body. Include `_id` to key the row yourself (the server honors it as the `clientId`). */
    row: Record<string, unknown> & { _id?: string };
    table: string;
}

/** One row to patch, by id. */
export interface PlanPatch {
    fields: Record<string, unknown>;
    id: string;
    table: string;
}

/** One row to delete, by id. */
export interface PlanDelete {
    id: string;
    table: string;
}

/**
 * A change plan: what a mutator intends to write.
 *
 * Applied in a fixed order — **deletes, then patches, then inserts** — by both
 * appliers. The order is part of the contract, not an implementation detail: a plan
 * that deletes a row and inserts its replacement under the same natural key only
 * behaves the same on both sides if both sides agree which happens first.
 */
export interface ChangePlan {
    deletes?: ReadonlyArray<PlanDelete>;
    inserts?: ReadonlyArray<PlanInsert>;
    patches?: ReadonlyArray<PlanPatch>;
}

/**
 * The `ctx.db` methods {@link applyPlanToDb} needs — structural, so any writer
 * satisfies it.
 *
 * The `never` parameter positions are deliberate, not laziness. `ctx.db.delete` is
 * `<T extends string>(id: Id<T>) => …` over the **branded** `Id<T>`, and under
 * `strictFunctionTypes` a parameter is contravariant — so declaring `id: string` here
 * would make the real `ctx.db` un-assignable to `PlanWriter` (`string` is not
 * assignable to `string & { __table }`), and every caller would need a cast at the
 * call site instead. `never` accepts any branded id, which keeps `applyPlanToDb(ctx.db,
 * plan)` cast-free for the caller and confines the two `as never` casts to this module.
 *
 * The trade-off is real: argument checking inside `applyPlanToDb` is erased, so a plan
 * naming a table the schema doesn't have is a runtime error. Use `ctx.db.asId(table,
 * id)` when building the plan to catch a malformed id at the boundary.
 */
export interface PlanWriter {
    delete: (id: never) => Promise<void>;
    insert: (tableName: never, document: Record<string, unknown>, options?: { clientId?: string }) => Promise<unknown>;
    patch: (id: never, patch: Record<string, unknown>) => Promise<void>;
}

/** Merge a plan's row lists in application order, so both appliers walk the same sequence. */
const ordered = (plan: ChangePlan): { deletes: ReadonlyArray<PlanDelete>; inserts: ReadonlyArray<PlanInsert>; patches: ReadonlyArray<PlanPatch> } => ({
    deletes: plan.deletes ?? [],
    inserts: plan.inserts ?? [],
    patches: plan.patches ?? [],
});

/**
 * Apply `plan` to a map of TanStack collections — the client (optimistic) half.
 *
 * A plan naming a table with no wired collection is **skipped, not an error**: an app
 * legitimately syncs a subset of the tables its mutators write (a server-only audit
 * row has no client collection), and throwing would make the optimistic body fail on
 * a write the server handles fine.
 */
export const applyPlanToCollections = (collections: Record<string, Collection<Row, string>>, plan: ChangePlan): void => {
    const { deletes, inserts, patches } = ordered(plan);

    for (const entry of deletes) {
        collections[entry.table]?.delete(entry.id);
    }

    for (const entry of patches) {
        const collection = collections[entry.table];

        if (!collection) {
            continue;
        }

        collection.update(entry.id, (draft) => {
            Object.assign(draft, entry.fields);
        });
    }

    for (const entry of inserts) {
        const collection = collections[entry.table];

        if (!collection) {
            continue;
        }

        // TanStack keys by `getKey`, so an insert needs a key now — the optimistic row
        // can't wait for the server to mint one or the row would be invisible until it
        // syncs (and then arrive as a second row).
        if (typeof entry.row._id !== "string") {
            throw new TypeError(
                `applyPlanToCollections: insert into "${entry.table}" needs an "_id" — mint it client-side so the optimistic row keys match the persisted one`,
            );
        }

        collection.insert(entry.row as Row);
    }
};

/**
 * Apply `plan` to a `ctx.db` writer — the server (authoritative) half.
 *
 * Sequential by design: the shard's SQLite is single-threaded and a mutation runs
 * inside one BEGIN/COMMIT span, so ordering is observable and a mid-plan failure
 * rolls the whole plan back. An insert carrying an `_id` forwards it as `clientId`,
 * which is how a client-minted key becomes the persisted primary key.
 */
export const applyPlanToDb = async (db: PlanWriter, plan: ChangePlan): Promise<void> => {
    const { deletes, inserts, patches } = ordered(plan);

    for (const entry of deletes) {
        // eslint-disable-next-line no-await-in-loop -- ordered, single-threaded shard writes; a mid-plan throw rolls the mutation back
        await db.delete(entry.id as never);
    }

    for (const entry of patches) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await db.patch(entry.id as never, entry.fields);
    }

    for (const entry of inserts) {
        const { _id, ...body } = entry.row;

        // eslint-disable-next-line no-await-in-loop -- see above
        await db.insert(entry.table as never, body, ...(typeof _id === "string" ? [{ clientId: _id }] : []));
    }
};
