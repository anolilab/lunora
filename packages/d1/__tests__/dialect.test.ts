import { describe, expect, it } from "vitest";

import { columnRef, frameworkColumnDdl, physicalIndexName, quoteIdentifier, sqlAffinityForKind } from "../src/dialect";

describe("dialect", () => {
    describe("quoteIdentifier", () => {
        it("wraps an identifier in double quotes", () => {
            expect.assertions(1);

            expect(quoteIdentifier("name")).toBe(`"name"`);
        });

        it("escapes embedded double quotes by doubling them (injection guard)", () => {
            expect.assertions(2);

            // A crafted identifier that tries to break out of the quoting must
            // have every `"` doubled so it stays a single SQL identifier.
            expect(quoteIdentifier(`a" DROP TABLE x; --`)).toBe(`"a"" DROP TABLE x; --"`);
            expect(quoteIdentifier(`"`)).toBe(`""""`);
        });
    });

    describe("sqlAffinityForKind", () => {
        it("maps validator kinds to SQLite affinities", () => {
            expect.assertions(7);

            expect(sqlAffinityForKind("boolean")).toBe("INTEGER");
            expect(sqlAffinityForKind("bytes")).toBe("BLOB");
            expect(sqlAffinityForKind("number")).toBe("REAL");
            expect(sqlAffinityForKind("timestamp")).toBe("REAL");
            expect(sqlAffinityForKind("date")).toBe("REAL");
            expect(sqlAffinityForKind("string")).toBe("TEXT");
            // bigint/object/array/union/any/undefined all fall through to TEXT so
            // a numeric affinity can never corrupt a numeric-looking string.
            expect(sqlAffinityForKind(undefined)).toBe("TEXT");
        });
    });

    describe("columnRef", () => {
        it("maps both `_id` and `id` to the physical `id` column", () => {
            expect.assertions(2);

            expect(columnRef("_id")).toBe(`"id"`);
            expect(columnRef("id")).toBe(`"id"`);
        });

        it("maps `_creationTime` and every other field to its own quoted column", () => {
            expect.assertions(2);

            expect(columnRef("_creationTime")).toBe(`"_creationTime"`);
            expect(columnRef("title")).toBe(`"title"`);
        });
    });

    describe("frameworkColumnDdl", () => {
        it("emits the id primary key and _creationTime columns", () => {
            expect.assertions(1);

            expect(frameworkColumnDdl()).toEqual([`"id" TEXT PRIMARY KEY`, `"_creationTime" REAL NOT NULL`]);
        });
    });

    describe("physicalIndexName", () => {
        it("namespaces the index by table so like-named indexes don't collide", () => {
            expect.assertions(1);

            expect(physicalIndexName("messages", "byAuthor")).toBe(`"messages_byAuthor"`);
        });
    });
});
