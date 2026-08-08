/**
 * Tests for the shared change-plan appliers.
 *
 * The load-bearing property is that both sides apply a plan the *same* way — same
 * order, same key handling — because a client body and a server body that disagree
 * produce a bug that only reproduces under latency.
 */
import type { Collection } from "@tanstack/db";
import { describe, expect, it } from "vitest";

import type { ChangePlan, PlanWriter } from "../src/apply-plan";
import { applyPlanToCollections, applyPlanToDb } from "../src/apply-plan";
import type { Row } from "../src/internals";

/** A collection double recording the ops applied to it, in order. */
const fakeCollection = (log: string[], name: string) =>
    ({
        delete: (id: string) => log.push(`${name}:delete:${id}`),
        insert: (row: Row) => log.push(`${name}:insert:${row._id}`),
        update: (id: string, updater: (draft: Record<string, unknown>) => void) => {
            const draft: Record<string, unknown> = {};

            updater(draft);
            log.push(`${name}:patch:${id}:${JSON.stringify(draft)}`);
        },
    }) as unknown as Collection<Row, string>;

/** A `ctx.db` double recording the ops applied to it, in order. */
const fakeWriter = (log: string[]): PlanWriter => {
    return {
        delete: async (id: string) => {
            log.push(`delete:${id}`);
        },
        insert: async (table: string, document: Record<string, unknown>, options?: { clientId?: string }) => {
            log.push(`insert:${table}:${JSON.stringify(document)}:${options?.clientId ?? "-"}`);

            return "server-id";
        },
        patch: async (id: string, patch: Record<string, unknown>) => {
            log.push(`patch:${id}:${JSON.stringify(patch)}`);
        },
    };
};

/** The error `applyPlanToCollections` throws for a keyless optimistic insert. */
const NEEDS_ID = /needs an "_id"/;

const plan: ChangePlan = {
    deletes: [{ id: "d1", table: "nodes" }],
    inserts: [{ row: { _id: "i1", text: "new" }, table: "nodes" }],
    patches: [{ fields: { text: "edited" }, id: "p1", table: "nodes" }],
};

describe(applyPlanToCollections, () => {
    it("applies deletes, then patches, then inserts", () => {
        expect.assertions(1);

        const log: string[] = [];

        applyPlanToCollections({ nodes: fakeCollection(log, "nodes") }, plan);

        // The order is contract, not incidental: a plan that deletes a row and
        // re-inserts its replacement only behaves identically on both sides if both
        // agree which happens first.
        expect(log).toStrictEqual(["nodes:delete:d1", 'nodes:patch:p1:{"text":"edited"}', "nodes:insert:i1"]);
    });

    it("skips a table with no wired collection rather than throwing", () => {
        expect.assertions(1);

        const log: string[] = [];

        // An app legitimately syncs a subset of the tables its mutators write (a
        // server-only audit row has no client collection).
        applyPlanToCollections({}, plan);

        expect(log).toStrictEqual([]);
    });

    it("requires a client-minted _id on an insert", () => {
        expect.assertions(1);

        const log: string[] = [];

        // Without a key now, the optimistic row is invisible until it syncs — and then
        // arrives as a second row.
        expect(() => {
            applyPlanToCollections({ nodes: fakeCollection(log, "nodes") }, { inserts: [{ row: { text: "x" }, table: "nodes" }] });
        }).toThrow(NEEDS_ID);
    });

    it("is a no-op for an empty plan", () => {
        expect.assertions(1);

        const log: string[] = [];

        applyPlanToCollections({ nodes: fakeCollection(log, "nodes") }, {});

        expect(log).toStrictEqual([]);
    });
});

describe(applyPlanToDb, () => {
    it("applies the plan in the same order as the collection applier", async () => {
        expect.assertions(1);

        const log: string[] = [];

        await applyPlanToDb(fakeWriter(log), plan);

        expect(log).toStrictEqual(["delete:d1", 'patch:p1:{"text":"edited"}', 'insert:nodes:{"text":"new"}:i1']);
    });

    it("forwards a client-minted _id as the clientId so the keys match", async () => {
        expect.assertions(1);

        const log: string[] = [];

        await applyPlanToDb(fakeWriter(log), { inserts: [{ row: { _id: "client-key", text: "x" }, table: "nodes" }] });

        // `_id` is stripped from the body and passed as `clientId`; the server
        // validates it and uses it as the primary key, so the persisted row matches
        // the optimistic one the client already rendered.
        expect(log).toStrictEqual(['insert:nodes:{"text":"x"}:client-key']);
    });

    it("omits clientId when the plan lets the server mint the id", async () => {
        expect.assertions(1);

        const log: string[] = [];

        await applyPlanToDb(fakeWriter(log), { inserts: [{ row: { text: "x" }, table: "nodes" }] });

        expect(log).toStrictEqual(['insert:nodes:{"text":"x"}:-']);
    });

    it("is a no-op for an empty plan", async () => {
        expect.assertions(1);

        const log: string[] = [];

        await applyPlanToDb(fakeWriter(log), {});

        expect(log).toStrictEqual([]);
    });
});
