import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ServerDefaultContextLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Exercises `.serverDefault(fn)` columns on the D1 column dialect: the factory
 * is SERVER-trusted, so it must stamp from the resolved request `auth` and
 * OVERWRITE any client-supplied value on insert/replace, while a patch that
 * leaves the column untouched must not re-stamp it to the current caller.
 */
const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return {
        _meta: { column: { notNull: true, ...column } },
        kind,
    };
};

const notesSchema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: {
                ownerId: col("string", {
                    serverDefault: ({ auth }: ServerDefaultContextLike) => auth.userId ?? "anon",
                }),
                title: col("string"),
            },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const setup = (auth?: ServerDefaultContextLike["auth"]): DatabaseWriterLike => {
    harness.ddl(
        `CREATE TABLE "notes" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "ownerId" TEXT,
            "title" TEXT
        )`,
    );

    return createD1ContextDatabase(
        auth
            ? { auth, clock: () => FIXED_CLOCK, exec: harness.exec, schema: notesSchema }
            : { clock: () => FIXED_CLOCK, exec: harness.exec, schema: notesSchema },
    );
};

describe("d1 ctx-db .serverDefault()", () => {
    beforeEach(() => {
        harness = createD1Exec();
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

        await writer.patch("n1", { title: "bye" });

        const afterTitlePatch = await writer.get("n1");

        expect(afterTitlePatch?.["ownerId"]).toBe("u1");

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
