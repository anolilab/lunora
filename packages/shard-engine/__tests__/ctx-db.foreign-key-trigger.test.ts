import { v } from "@lunora/values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A `before` trigger runs before the foreign-key existence check, so one that
 * creates the referenced parent through its own db context can still save the
 * child. A parent nobody creates is refused exactly as before.
 */
const createParent = async (context: { db: DatabaseWriterLike }, event: { doc?: Record<string, unknown> }): Promise<void> => {
    const id = event.doc?.["customerId"];

    if (typeof id === "string" && id.startsWith("from-trigger")) {
        await context.db.insert("customers", { _id: id, name: "made by trigger" }, { allowExplicitId: true });
    }
};

const schema = {
    tables: {
        customers: { indexes: [], shape: { name: v.string() } },
        orders: {
            indexes: [],
            shape: { customerId: v.id("customers"), note: v.string() },
            triggerMap: {
                onInsert: { handler: createParent, op: "insert", timing: "before" },
                onUpdate: { handler: createParent, op: "update", timing: "before" },
            },
        },
    },
} as unknown as SchemaLike;

let harness: ReturnType<typeof createSqliteExec>;
let writer: DatabaseWriterLike;

describe("foreign keys are checked after the before trigger", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("insert succeeds when a before trigger creates the parent", async () => {
        expect.assertions(2);

        const id = await writer.insert("orders", { customerId: "from-trigger", note: "x" });

        await expect(writer.get("orders", id)).resolves.toMatchObject({ customerId: "from-trigger" });
        await expect(writer.get("customers", "from-trigger")).resolves.toMatchObject({ name: "made by trigger" });
    });

    it("patch succeeds when a before trigger creates the new parent", async () => {
        expect.assertions(1);

        const customer = await writer.insert("customers", { name: "ada" });
        const order = await writer.insert("orders", { customerId: customer, note: "x" });

        await expect(writer.patch(order, { customerId: "from-trigger-patch" })).resolves.toBeUndefined();
    });

    it("replace succeeds when a before trigger creates the new parent", async () => {
        expect.assertions(1);

        const customer = await writer.insert("customers", { name: "ada" });
        const order = await writer.insert("orders", { customerId: customer, note: "y" });

        await expect(writer.replace(order, { customerId: "from-trigger-replace", note: "z" })).resolves.toBeUndefined();
    });

    it("a parent no trigger creates is still refused", async () => {
        expect.assertions(1);

        await expect(writer.insert("orders", { customerId: "ghost", note: "x" })).rejects.toThrow(/orders\.customerId.*ghost/u);
    });
});
