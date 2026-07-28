import { getAuthTablesWithResolvedIndexes, getDatabaseFieldIndexName } from "@better-auth/core/db/internal";
import { describe, expect, it } from "vitest";

/**
 * The shape of the two `@better-auth/core/db/internal` helpers the DO schema depends on.
 *
 * ## Why this test exists
 *
 * `authDoSchemaStatements` derives its DDL from these rather than mirroring
 * better-auth's logic, which is the right call — a local mirror drifts silently. But
 * the subpath is named **internal**: it is in the package's `exports` map, so importing
 * it is legitimate, and it is what `getAuthTables` itself is built on, but nothing
 * promises the shape across a minor release.
 *
 * Types alone are not enough cover. If a future version keeps the type declarations and
 * changes the runtime shape — renames `indexesByTable`, returns an object instead of a
 * `Map`, folds field-level `unique` into the resolved map — `tsc` stays quiet and the
 * failure mode is a schema quietly missing its constraints. That is the exact class of
 * bug this whole area already produced once (a materialiser that emitted no UNIQUE
 * indexes at all and looked fine).
 *
 * So these assertions read the runtime values, and are deliberately about the shape of
 * the contract rather than its content: the properties exist, the container types are
 * what the caller assumes, and the field-level flags still live on `fields` rather than
 * in the resolved index map. A dependency bump that breaks any of them fails here, with
 * a name, instead of shipping a table without a unique email.
 */

const OPTIONS = { secret: "contract-test-secret-contract-test-secret" };

describe("@better-auth/core/db/internal contract", () => {
    it("returns both a table map and an index map", () => {
        expect.assertions(3);

        const resolved = getAuthTablesWithResolvedIndexes(OPTIONS);

        expect(resolved).toHaveProperty("tables");
        expect(resolved).toHaveProperty("indexesByTable");

        // A `Map`, not a plain object — `authDoSchemaStatements` calls `.get(modelName)`.
        expect(resolved.indexesByTable).toBeInstanceOf(Map);
    });

    it("describes each table with the physical name and field attributes the DDL reads", () => {
        expect.assertions(4);

        const {
            tables: { user },
        } = getAuthTablesWithResolvedIndexes(OPTIONS);

        expect(user?.modelName).toBe("user");
        expect(user?.fields).toBeTypeOf("object");

        // `required` / `unique` drive NOT NULL and the unique indexes; `fieldName` is the
        // physical column when it differs from the logical key.
        expect(user?.fields["email"]).toMatchObject({ required: true, unique: true });
        expect(user?.fields["email"]?.fieldName).toBe("email");
    });

    it("keeps field-level uniqueness OUT of the resolved index map", () => {
        expect.assertions(2);

        const { indexesByTable, tables } = getAuthTablesWithResolvedIndexes(OPTIONS);

        // This is the asymmetry that made the original bug possible: `user.email` is
        // `unique: true` on the field, and the resolved map for `user` is EMPTY. If a
        // future version starts folding field flags into the map, the DDL would emit the
        // index twice under two names — so a change in either direction must fail here.
        expect(tables["user"]?.fields["email"]?.unique).toBe(true);
        expect(indexesByTable.get("user") ?? []).toStrictEqual([]);
    });

    it("resolves table-level indexes to physical columns with a name", () => {
        expect.assertions(3);

        const { indexesByTable } = getAuthTablesWithResolvedIndexes(OPTIONS);
        const [accountIndex] = indexesByTable.get("account") ?? [];

        // `columns` (physical), not `fields` (logical) — the DDL quotes these directly.
        expect(accountIndex?.columns).toStrictEqual(["issuer", "providerAccountId"]);
        expect(accountIndex?.name).toBeTypeOf("string");
        expect(accountIndex?.unique).toBe(true);
    });

    it("names a field index deterministically, and distinguishes unique from plain", () => {
        expect.assertions(3);

        const unique = getDatabaseFieldIndexName("user", "email", true);
        const plain = getDatabaseFieldIndexName("session", "userId", false);

        expect(unique).toBeTypeOf("string");
        expect(unique).not.toBe(plain);

        // Stable across calls: these names are written into DDL that better-auth's own
        // introspection later compares against.
        expect(getDatabaseFieldIndexName("user", "email", true)).toBe(unique);
    });
});
