import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../../src/discover/schema";
import { emitDataModel } from "../../src/emit";

/**
 * Discovery of the two table modes this branch added: `.commitOrdered()` and
 * `.memory()`.
 *
 * Both are chain calls with no arguments, which makes them the easy kind to lose:
 * an unrecognised method is skipped silently, so the flag comes out `false`, the
 * feature is simply absent, and nothing anywhere errors. `_commitSeq` would stop
 * being stamped and a memory table would quietly become durable — with no
 * failing type, no runtime throw, and no diagnostic. These tests are the guard
 * against that, which is why they assert discovery AND the emitted consequence.
 */
const projectWith = (schemaSource: string): { project: Project; schemaPath: string } => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, schemaSource);

    return { project, schemaPath };
};

const discover = (source: string): ReturnType<typeof discoverSchema> => {
    const { project, schemaPath } = projectWith(source);

    return discoverSchema(project, schemaPath);
};

describe("discoverSchema — table modes", () => {
    describe(".commitOrdered()", () => {
        it("records the opt-in and emits `_commitSeq` on the generated Doc", () => {
            expect.assertions(2);

            const schema = discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                export const schema = defineSchema({
                    orders: defineTable({ status: v.string() }).commitOrdered(),
                });
            `);

            expect(schema.tables[0]?.commitOrdered).toBe(true);
            // The field is runtime-minted, so it is rendered onto `Doc_*` directly
            // rather than injected into the shape — a reader consuming the feed
            // needs it typed or every cursor comparison is a cast.
            expect(emitDataModel(schema)).toContain("_commitSeq: number;");
        });

        it("survives an arbitrary chain position", () => {
            expect.assertions(2);

            const schema = discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                export const schema = defineSchema({
                    orders: defineTable({ deskId: v.string(), status: v.string() })
                        .index("by_desk", ["deskId"])
                        .commitOrdered()
                        .softDelete(),
                });
            `);

            expect(schema.tables[0]?.commitOrdered).toBe(true);
            expect(schema.tables[0]?.softDelete).toStrictEqual({ field: "deletedAt" });
        });

        it("leaves an ordinary table alone", () => {
            expect.assertions(2);

            const schema = discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                export const schema = defineSchema({
                    orders: defineTable({ status: v.string() }),
                });
            `);

            expect(schema.tables[0]?.commitOrdered).toBe(false);
            expect(emitDataModel(schema)).not.toContain("_commitSeq");
        });
    });

    describe(".memory()", () => {
        it("records the opt-in", () => {
            expect.assertions(1);

            const schema = discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                export const schema = defineSchema({
                    presence: defineTable({ userId: v.string() }).memory(),
                });
            `);

            expect(schema.tables[0]?.memory).toBe(true);
        });

        it("composes with a plain index, which is the one companion it may carry", () => {
            expect.assertions(2);

            const schema = discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                export const schema = defineSchema({
                    presence: defineTable({ roomId: v.string(), userId: v.string() })
                        .memory()
                        .index("by_room", ["roomId"]),
                });
            `);

            expect(schema.tables[0]?.memory).toBe(true);
            expect(schema.tables[0]?.indexes).toStrictEqual([{ fields: ["roomId"], name: "by_room", unique: false }]);
        });

        it("leaves an ordinary table alone", () => {
            expect.assertions(1);

            const schema = discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                export const schema = defineSchema({
                    presence: defineTable({ userId: v.string() }),
                });
            `);

            expect(schema.tables[0]?.memory).toBe(false);
        });
    });

    it("keeps the two modes independent on one schema", () => {
        expect.assertions(4);

        const schema = discover(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                orders: defineTable({ status: v.string() }).commitOrdered(),
                presence: defineTable({ userId: v.string() }).memory(),
            });
        `);

        const orders = schema.tables.find((table) => table.name === "orders");
        const presence = schema.tables.find((table) => table.name === "presence");

        expect(orders?.commitOrdered).toBe(true);
        expect(orders?.memory).toBe(false);
        expect(presence?.memory).toBe(true);
        expect(presence?.commitOrdered).toBe(false);
    });
});
