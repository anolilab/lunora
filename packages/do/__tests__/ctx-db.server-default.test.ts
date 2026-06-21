import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ColumnMetaLike, SchemaLike, ServerDefaultContextLike, ValidatorLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Exercises `.serverDefault(fn)` columns against a real SQLite engine: the
 * factory is SERVER-trusted, so it must stamp from the resolved request `auth`
 * and OVERWRITE any client-supplied value on insert/replace, while a patch that
 * leaves the column untouched must not re-stamp it to the current caller.
 */
const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return {
        _meta: { column: { notNull: true, ...column } },
        kind,
    };
};

let harness: ReturnType<typeof createSqliteExec>;

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: {
                // Stamp the owner from the verified caller, never the client.
                ownerId: col("string", {
                    serverDefault: ({ auth }: ServerDefaultContextLike) => auth.userId ?? "anon",
                }),
                title: col("string"),
            },
        },
    },
};

const setup = (auth?: ServerDefaultContextLike["auth"]) => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase(auth ? { auth, schema, sql: harness.sql } : { schema, sql: harness.sql });
};

describe("ctx-db .serverDefault()", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("stamps the column from auth when the client omits it", async () => {
        expect.assertions(1);

        const writer = setup({ identity: null, userId: "u1" });

        const id = await writer.insert("notes", { _id: "n1", title: "hi" }, { allowExplicitId: true });
        const doc = await writer.get(id);

        expect(doc?.["ownerId"]).toBe("u1");
    });

    it("overwrites a client-supplied value on insert (server wins)", async () => {
        expect.assertions(1);

        const writer = setup({ identity: null, userId: "u1" });

        const id = await writer.insert("notes", { _id: "n1", ownerId: "attacker", title: "hi" }, { allowExplicitId: true });
        const doc = await writer.get(id);

        expect(doc?.["ownerId"]).toBe("u1");
    });

    it("falls back to the anonymous slice when no auth is wired", async () => {
        expect.assertions(1);

        const writer = setup();

        const id = await writer.insert("notes", { _id: "n1", title: "hi" }, { allowExplicitId: true });
        const doc = await writer.get(id);

        expect(doc?.["ownerId"]).toBe("anon");
    });

    it("overwrites a client patch of the column but leaves it untouched otherwise", async () => {
        expect.assertions(2);

        const writer = setup({ identity: null, userId: "u1" });

        await writer.insert("notes", { _id: "n1", title: "hi" }, { allowExplicitId: true });

        // A patch that does NOT touch ownerId leaves the stored value intact.
        await writer.patch("n1", { title: "bye" });

        const afterTitlePatch = await writer.get("n1");

        expect(afterTitlePatch?.["ownerId"]).toBe("u1");

        // A patch that tries to set ownerId is overwritten with the server value.
        await writer.patch("n1", { ownerId: "attacker" });

        const afterOwnerPatch = await writer.get("n1");

        expect(afterOwnerPatch?.["ownerId"]).toBe("u1");
    });

    it("re-stamps the column on replace", async () => {
        expect.assertions(1);

        const writer = setup({ identity: null, userId: "u1" });

        await writer.insert("notes", { _id: "n1", title: "hi" }, { allowExplicitId: true });

        await writer.replace("n1", { ownerId: "attacker", title: "new" });

        const replaced = await writer.get("n1");

        expect(replaced?.["ownerId"]).toBe("u1");
    });
});
