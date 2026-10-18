import { isLunoraError } from "@lunora/errors";
import { v } from "@lunora/values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A `v.id("parent")` column must point at a row that exists when it is written.
 *
 * The writer accepted any string for an id column, so an order could be created
 * for a customer that was never there and then fail every later read that
 * followed the reference. The check is one primary-key lookup per foreign key, in
 * the same SQLite transaction as the write, and only where it can be answered
 * locally: a parent in a different shard, or in D1, is not in this database to
 * look up.
 */
const schema = {
    tables: {
        customers: { indexes: [], shape: { name: v.string() } },
        orders: {
            indexes: [],
            shape: { customerId: v.id("customers"), note: v.string(), referrerId: v.optional(v.id("customers")) },
        },
        // Parent lives in another shard (one DO per tenant): not checkable here.
        shardedOrders: {
            indexes: [],
            shape: { tenantId: v.id("tenants") },
        },
        tenants: { indexes: [], shape: { name: v.string() }, shardMode: { field: "name", kind: "shardBy" } },
    },
} as unknown as SchemaLike;

let harness: ReturnType<typeof createSqliteExec>;
let writer: DatabaseWriterLike;

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
    try {
        await promise;
    } catch (error) {
        return isLunoraError(error) ? error.code : "NOT_A_LUNORA_ERROR";
    }

    return undefined;
};

describe("ctx.db enforces v.id foreign keys on the same shard", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("insert accepts an existing parent and an absent or null optional reference", async () => {
        expect.assertions(3);

        const customer = await writer.insert("customers", { name: "ada" });

        await expect(writer.insert("orders", { customerId: customer, note: "a" })).resolves.toBeTypeOf("string");
        await expect(writer.insert("orders", { customerId: customer, note: "b", referrerId: customer })).resolves.toBeTypeOf("string");
        // An explicit null is its own validation question; the foreign-key check only looks at ids.
        await expect(writer.insert("orders", { customerId: customer, note: "c", referrerId: undefined })).resolves.toBeTypeOf("string");
    });

    it("insert rejects a reference to a row that does not exist", async () => {
        expect.assertions(3);

        const failure = writer.insert("orders", { customerId: "no-such-customer", note: "x" });

        await expect(failure).rejects.toThrow(/orders\.customerId.*customers.*no-such-customer/u);
        await expect(codeOf(writer.insert("orders", { customerId: "no-such-customer", note: "x" }))).resolves.toBe("VALIDATION_ERROR");
        await expect(writer.findMany("orders", {})).resolves.toMatchObject({ page: [] });
    });

    it("insert rejects a dangling optional reference too", async () => {
        expect.assertions(1);

        const customer = await writer.insert("customers", { name: "ada" });

        await expect(writer.insert("orders", { customerId: customer, note: "x", referrerId: "ghost" })).rejects.toThrow(/orders\.referrerId/u);
    });

    it("patch checks the reference it sets, and only that one", async () => {
        expect.assertions(3);

        const customer = await writer.insert("customers", { name: "ada" });
        const order = await writer.insert("orders", { customerId: customer, note: "x" });

        await expect(writer.patch(order, { customerId: "ghost" })).rejects.toThrow(/orders\.customerId/u);
        await expect(writer.patch(order, { note: "y" })).resolves.toBeUndefined();

        const other = await writer.insert("customers", { name: "grace" });

        await expect(writer.patch(order, { customerId: other })).resolves.toBeUndefined();
    });

    it("patch of an unrelated field does not re-check a reference the row already held", async () => {
        expect.assertions(1);

        // A row written before the check existed, or by a trusted import, may point nowhere.
        const order = await writer.insert("orders", { _id: "o1", customerId: "ghost", note: "x" }, { allowExplicitId: true });

        await expect(writer.patch(order, { note: "y" })).resolves.toBeUndefined();
    });

    it("replace rejects a dangling reference", async () => {
        expect.assertions(1);

        const customer = await writer.insert("customers", { name: "ada" });
        const order = await writer.insert("orders", { customerId: customer, note: "x" });

        await expect(writer.replace(order, { customerId: "ghost", note: "x" })).rejects.toThrow(/orders\.customerId/u);
    });

    it("a trusted import (allowExplicitId) may write a child before its parent", async () => {
        expect.assertions(1);

        await expect(writer.insert("orders", { _id: "o1", customerId: "arrives-later", note: "x" }, { allowExplicitId: true })).resolves.toBe("o1");
    });

    it("does not check a parent that lives in another shard", async () => {
        expect.assertions(1);

        await expect(writer.insert("shardedOrders", { tenantId: "tenant-in-another-do" })).resolves.toBeTypeOf("string");
    });
});
