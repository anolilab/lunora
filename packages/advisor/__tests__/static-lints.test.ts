import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorQueryRead, AdvisorSchema } from "../src";
import {
    duplicateIndex,
    emptyIndex,
    filterWithoutIndex,
    fromServerSchema,
    globalTableNearColumnLimit,
    indexReferencesUnknownField,
    relationReferencesUnknownField,
    relationReferencesUnknownTable,
    runAdvisor,
} from "../src";

/** Build a LintContext from query reads only (an empty schema), for the query-shaped lints. */
const queryContext = (queries: AdvisorQueryRead[]) => {
    return { queries, schema: { tables: [] } };
};

const read = (over: Partial<AdvisorQueryRead> = {}): AdvisorQueryRead => {
    return {
        file: "messages",
        hasFilter: true,
        hasIndex: false,
        line: 10,
        table: "messages",
        ...over,
    };
};

describe("duplicate_index", () => {
    it("flags a single-column index covered by a composite's leading prefix", () => {
        expect.assertions(2);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.string(), createdAt: v.number() })
                .index("byAuthor", ["authorId"])
                .index("byAuthorCreated", ["authorId", "createdAt"]),
        });

        const findings = duplicateIndex.run({ schema: fromServerSchema(schema) });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ index: "byAuthor", coveredBy: { name: "byAuthorCreated" } });
    });

    it("flags exactly one of two exact-duplicate indexes", () => {
        expect.assertions(2);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.string() }).index("a", ["authorId"]).index("b", ["authorId"]),
        });

        const findings = duplicateIndex.run({ schema: fromServerSchema(schema) });

        expect(findings).toHaveLength(1);
        // Tie broken by name: the later-sorted ("b") is reported as redundant.
        expect(findings[0]?.metadata).toMatchObject({ index: "b" });
    });

    it("never reports a unique index as redundant", () => {
        expect.assertions(1);

        const schema = defineSchema({
            users: defineTable({ email: v.string(), tenant: v.string() })
                .index("byEmail", ["email"], { unique: true })
                .index("byEmailTenant", ["email", "tenant"]),
        });

        expect(duplicateIndex.run({ schema: fromServerSchema(schema) })).toHaveLength(0);
    });

    it("passes for disjoint indexes", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.string(), slug: v.string() }).index("byAuthor", ["authorId"]).index("bySlug", ["slug"]),
        });

        expect(duplicateIndex.run({ schema: fromServerSchema(schema) })).toHaveLength(0);
    });
});

describe("index_references_unknown_field", () => {
    it("flags an index on a column the table does not declare", () => {
        expect.assertions(2);

        // Built directly rather than through `defineSchema` + `fromServerSchema`:
        // `validateIndexFields` (packages/server/src/schema.ts) now rejects this
        // exact shape at construction time, so `defineSchema` can never hand back
        // a `Schema` with an index over an undeclared column. But the codegen
        // feeder (`packages/codegen/src/advisor.ts`'s `toAdvisorSchema`) builds
        // `AdvisorSchema` straight from its own AST-derived `SchemaIR` and never
        // imports `@lunora/server` — a schema.ts typo is discoverable there
        // *before* the module is ever executed, so this lint stays reachable from
        // that path and needs a fixture that bypasses `defineSchema` entirely.
        const schema: AdvisorSchema = {
            tables: [
                {
                    fields: ["title"],
                    indexes: [{ fields: ["authorId"], kind: "index", name: "byAuthor" }],
                    name: "posts",
                    relations: [],
                },
            ],
        };

        const findings = indexReferencesUnknownField.run({ schema });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ field: "authorId", index: "byAuthor", table: "posts" });
    });

    it("treats system fields (_id / _creationTime) as valid", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ title: v.string() }).index("byCreated", ["_creationTime"]),
        });

        expect(indexReferencesUnknownField.run({ schema: fromServerSchema(schema) })).toHaveLength(0);
    });

    it("checks search-index fields too", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ body: v.string() }).searchIndex("byText", { field: "body", filterFields: ["ghostFilter"] }),
        });

        // `body` resolves; `ghostFilter` does not.
        const findings = indexReferencesUnknownField.run({ schema: fromServerSchema(schema) });

        expect(findings).toHaveLength(1);
    });
});

describe("relation_references_unknown_table", () => {
    it("flags a relation whose target table is absent", () => {
        expect.assertions(2);

        const schema = defineSchema({
            posts: defineTable({ ghostId: v.string() }).relations((r) => {
                return { ghost: r.one("ghosts", { field: "ghostId" }) };
            }),
        });

        const findings = relationReferencesUnknownTable.run({ schema: fromServerSchema(schema) });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ relation: "ghost", target: "ghosts", table: "posts" });
    });

    it("passes when the target exists", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.string() }).relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
            users: defineTable({ name: v.string() }),
        });

        expect(relationReferencesUnknownTable.run({ schema: fromServerSchema(schema) })).toHaveLength(0);
    });
});

describe("relation_references_unknown_field", () => {
    it("flags a `one` relation whose FK column is not declared", () => {
        expect.assertions(2);

        const schema = defineSchema({
            posts: defineTable({ title: v.string() }).relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
            users: defineTable({ name: v.string() }),
        });

        const findings = relationReferencesUnknownField.run({ schema: fromServerSchema(schema) });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ column: "authorId", owner: "posts", side: "field" });
    });

    it("flags a missing `references` column on the target", () => {
        expect.assertions(2);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.string() }).relations((r) => {
                return { author: r.one("users", { field: "authorId", references: "ghostKey" }) };
            }),
            users: defineTable({ name: v.string() }),
        });

        const findings = relationReferencesUnknownField.run({ schema: fromServerSchema(schema) });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ column: "ghostKey", owner: "users", side: "references" });
    });

    it("stays silent when the target table is unknown (the table lint owns that)", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ ghostId: v.string() }).relations((r) => {
                return { ghost: r.one("ghosts", { field: "ghostId" }) };
            }),
        });

        expect(relationReferencesUnknownField.run({ schema: fromServerSchema(schema) })).toHaveLength(0);
    });

    // `many` reverses which table owns which column: the FK `field` lives on the
    // TARGET (`@lunora/server`'s `many: … the FK field lives on the target table,
    // matching this table's references`), `references` on the holder. Without
    // these two cases the swap could be dropped or inverted and every to-many
    // relation in every schema would raise a false build-failing ERROR.
    it("flags a `many` relation whose FK column is missing from the TARGET table", () => {
        expect.assertions(2);

        const schema = defineSchema({
            posts: defineTable({ title: v.string() }),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        const findings = relationReferencesUnknownField.run({ schema: fromServerSchema(schema) });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ column: "authorId", owner: "posts", side: "field" });
    });

    it("flags a `many` relation whose `references` column is missing from the HOLDER table", () => {
        expect.assertions(2);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.string() }),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId", references: "ghostKey" }) };
            }),
        });

        const findings = relationReferencesUnknownField.run({ schema: fromServerSchema(schema) });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ column: "ghostKey", owner: "users", side: "references" });
    });

    it("stays silent on a correctly-wired `many` relation", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.string() }),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        expect(relationReferencesUnknownField.run({ schema: fromServerSchema(schema) })).toHaveLength(0);
    });
});

describe("global_table_near_column_limit", () => {
    /** A `.global()` table with `count` declared string fields. */
    const globalTableWith = (count: number) =>
        defineSchema({
            wide: defineTable(Object.fromEntries(Array.from({ length: count }, (_unused, index) => [`f${String(index)}`, v.string()]))).global(),
        });

    it("flags a global table within ten columns of the ceiling", () => {
        expect.assertions(2);

        // 88 fields + id + _creationTime = 90, the warning threshold.
        const findings = globalTableNearColumnLimit.run({ schema: fromServerSchema(globalTableWith(88)) });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ columns: 90, limit: 100, table: "wide" });
    });

    it("stays silent one column below the threshold", () => {
        expect.assertions(1);

        expect(globalTableNearColumnLimit.run({ schema: fromServerSchema(globalTableWith(87)) })).toHaveLength(0);
    });

    it("ignores a shard-local table, whose fields never become columns", () => {
        expect.assertions(1);

        // Same width, stored as one JSON document — the ceiling does not apply.
        const schema = defineSchema({
            wide: defineTable(Object.fromEntries(Array.from({ length: 200 }, (_unused, index) => [`f${String(index)}`, v.string()]))),
        });

        expect(globalTableNearColumnLimit.run({ schema: fromServerSchema(schema) })).toHaveLength(0);
    });
});

describe("empty_index", () => {
    it("flags a secondary index with no columns", () => {
        expect.assertions(2);

        const schema = defineSchema({
            posts: defineTable({ title: v.string() }).index("empty", []),
        });

        const findings = emptyIndex.run({ schema: fromServerSchema(schema) });

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ index: "empty", table: "posts" });
    });

    it("passes for an index with columns", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ title: v.string() }).index("byTitle", ["title"]),
        });

        expect(emptyIndex.run({ schema: fromServerSchema(schema) })).toHaveLength(0);
    });
});

describe("filter_without_index", () => {
    it("flags a filtered read with no index", () => {
        expect.assertions(2);

        const findings = filterWithoutIndex.run(queryContext([read({ table: "posts", line: 7 })]));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ file: "messages", line: 7, table: "posts" });
    });

    it("passes when the read narrows with an index", () => {
        expect.assertions(1);

        expect(filterWithoutIndex.run(queryContext([read({ hasIndex: true })]))).toHaveLength(0);
    });

    it("ignores reads without a filter and reads on a dynamic (non-literal) table", () => {
        expect.assertions(1);

        const findings = filterWithoutIndex.run(queryContext([read({ hasFilter: false }), read({ table: "" })]));

        expect(findings).toHaveLength(0);
    });

    it("finds nothing when no queries are supplied (runtime callers)", () => {
        expect.assertions(1);

        expect(filterWithoutIndex.run({ schema: { tables: [] } })).toHaveLength(0);
    });
});

describe("runAdvisor with the full static set", () => {
    it("aggregates findings from every lint, correctness first", () => {
        expect.assertions(2);

        // Built directly rather than through `defineSchema` — see the comment in
        // `index_references_unknown_field` above: `byGhost`'s unknown field would
        // now throw at construction time, but the codegen feeder never goes
        // through `defineSchema`, so this fixture mirrors that IR shape by hand.
        const schema: AdvisorSchema = {
            tables: [
                {
                    // unindexed FK (authorId) + a redundant index pair + an unknown index field.
                    fields: ["authorId", "createdAt"],
                    indexes: [
                        { fields: ["authorId"], kind: "index", name: "byAuthor" },
                        { fields: ["authorId", "createdAt"], kind: "index", name: "byAuthorCreated" },
                        { fields: ["ghost"], kind: "index", name: "byGhost" },
                    ],
                    name: "posts",
                    relations: [{ field: "authorId", kind: "one", name: "author", references: "_id", table: "users" }],
                },
                { fields: ["name"], indexes: [], name: "users", relations: [] },
            ],
        };

        const findings = runAdvisor({ schema }, { source: "static" });
        const names = findings.map((finding) => finding.name);

        // index_references_unknown_field (byGhost), duplicate_index (byAuthor),
        // and unindexed_foreign_key never fires here because byAuthor leads authorId.
        expect(names).toContain("index_references_unknown_field");
        expect(names).toContain("duplicate_index");
    });
});
