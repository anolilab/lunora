import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const optionalNumber: ValidatorLike = {
    _meta: { column: { notNull: true }, inner: { _meta: { column: { notNull: true } }, kind: "number" } },
    kind: "optional",
};

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: { body: col("string"), deletedAt: optionalNumber },
            shardMode: { kind: "global" },
            softDeleteMode: { field: "deletedAt" },
        },
    },
} as never;

describe("createSqlCtxDb — a missing row is NOT_FOUND", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const makeWriter = () => createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema });

    it("patch on an absent id", async () => {
        expect.assertions(1);

        const writer = makeWriter();

        await writer.insert("notes", { body: "a" });

        await expect(writer.patch("notes", "missing", { body: "b" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("replace on an absent id", async () => {
        expect.assertions(1);

        const writer = makeWriter();

        await writer.insert("notes", { body: "a" });

        await expect(writer.replace("notes", "missing", { body: "b" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("restore on an absent id", async () => {
        expect.assertions(1);

        const writer = makeWriter();

        await writer.insert("notes", { body: "a" });

        await expect(writer.restore!("notes", "missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("delete on an absent id is a no-op, not an error", async () => {
        expect.assertions(1);

        const writer = makeWriter();

        await writer.insert("notes", { body: "a" });

        await expect(writer.delete("notes", "missing")).resolves.toBeUndefined();
    });
});
