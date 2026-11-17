import { defineSchema, defineTable, v } from "@lunora/server";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../src/discover/schema";
import { schemaFromIr } from "../src/schema-from-ir";

const indexNames = (indexes: ReadonlyArray<{ name: string }>): string[] => indexes.map((index) => index.name);

describe("schemaFromIr", () => {
    it("keeps chained indexes in declaration order, as the runtime table builder does", () => {
        expect.hasAssertions();

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
        const schemaPath = "/virtual/lunora/schema.ts";

        project.createSourceFile(
            schemaPath,
            `
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                slots: defineTable({ flag: v.boolean(), kind: v.boolean() })
                    .index("by_flag", ["flag"], { unique: true })
                    .index("by_kind", ["kind"], { unique: true }),
            });
            `,
        );

        const runtime = defineSchema({
            slots: defineTable({ flag: v.boolean(), kind: v.boolean() })
                .index("by_flag", ["flag"], { unique: true })
                .index("by_kind", ["kind"], { unique: true }),
        });
        const seeded = schemaFromIr(discoverSchema(project, schemaPath));

        expect(indexNames(seeded.tables.slots?.indexes ?? [])).toStrictEqual(["by_flag", "by_kind"]);
        expect(indexNames(seeded.tables.slots?.indexes ?? [])).toStrictEqual(indexNames(runtime.tables.slots?.indexes ?? []));
    });
});
