import { v, ValidationError } from "@lunora/values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A whole-row validation failure names where it happened. `patch` validates every column of the
 * merged row, so a value already stored in a column the patch never touched fails it too; the
 * error must say which table and column, what was expected and what type was found, and whether
 * the patch set it — and never quote the value, which may be a secret.
 */

const SECRET = "2020-01-01T00:00:00.000Z-secret";

const schema = {
    tables: {
        accounts: {
            indexes: [],
            shape: {
                expiresAt: v.number(),
                name: v.string(),
                profile: v.object({ age: v.number().check((value) => value >= 0, "age must not be negative") }),
            },
        },
    },
} as unknown as SchemaLike;

let harness: ReturnType<typeof createSqliteExec>;
let writer: DatabaseWriterLike;

const rejection = async (write: Promise<unknown>): Promise<ValidationError> => {
    const error = await write.then(
        () => undefined,
        (error_: unknown) => error_,
    );

    expect(error).toBeInstanceOf(ValidationError);

    return error as ValidationError;
};

describe("ctx.db — whole-row validation errors", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    });

    afterEach(() => {
        harness.close();
    });

    it("names the stored column a patch did not set, with its expected kind and received type, never the value", async () => {
        expect.hasAssertions();

        const id = await writer.insert("accounts", { expiresAt: 1, name: "a", profile: { age: 1 } });

        harness.raw(`UPDATE "accounts" SET "__doc__" = json_set("__doc__", '$.expiresAt', ?) WHERE id = ?`, SECRET, id);

        const error = await rejection(writer.patch("accounts", id, { name: "b" }));

        expect(error.code).toBe("VALIDATION_ERROR");
        expect(error.message).toMatch(/^accounts\.expiresAt: expected number, received string \(a stored value this patch does not set/u);
        expect(error.path).toStrictEqual(["expiresAt"]);
        expect(error.received).toBe("string");
        expect(JSON.stringify(error)).not.toContain(SECRET);
        expect(error.message).not.toContain(SECRET);
    });

    it("says when the patch set the invalid column, and keeps a refinement's reason and the nested path", async () => {
        expect.hasAssertions();

        const id = await writer.insert("accounts", { expiresAt: 1, name: "a", profile: { age: 1 } });

        const error = await rejection(writer.patch("accounts", id, { profile: { age: -5 } }));

        expect(error.message).toBe("accounts.profile.age: expected age must not be negative, received number (set by this patch)");
        expect(error.path).toStrictEqual(["profile", "age"]);
    });

    it("names the table and column on insert too, without the value", async () => {
        expect.hasAssertions();

        const error = await rejection(writer.insert("accounts", { expiresAt: SECRET, name: "a", profile: { age: 1 } }));

        expect(error.message).toBe("accounts.expiresAt: expected number, received string");
        expect(error.message).not.toContain(SECRET);
    });
});
