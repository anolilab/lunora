import { fileURLToPath } from "node:url";

import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../../src/discover/schema";
import { RESERVED_TABLE_NAMES } from "../../src/discover/schema/internal/table-builder";

/**
 * The writer whose members `RESERVED_TABLE_NAMES` must cover, read from source
 * rather than from `dist`: an unbuilt or stale `dist` would make this gate pass
 * vacuously, which is exactly the failure mode it exists to catch.
 */
const WRITER_SOURCE = fileURLToPath(new URL("../../../shard-engine/src/schema-types.ts", import.meta.url));

/** Every member name `DatabaseWriterLike` declares, parsed with the real compiler. */
const writerMembers = (): string[] => {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const sourceFile = project.addSourceFileAtPath(WRITER_SOURCE);

    return sourceFile
        .getInterfaceOrThrow("DatabaseWriterLike")
        .getMembers()
        .flatMap((member) => (Node.isMethodSignature(member) || Node.isPropertySignature(member) ? [member.getName()] : []))
        .toSorted((left, right) => left.localeCompare(right));
};

const projectWith = (schemaSource: string): { project: Project; schemaPath: string } => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, schemaSource);

    return { project, schemaPath };
};

describe("reservedTableNames", () => {
    // The drift gate. `_generated/shard.ts` assigns each table's facade onto the
    // very object that carries the writer's own members
    // (`facade[<table>] = bindTableFacade(db, <table>)`), so a member name that is
    // also a table name is overwritten by a `FacadeEntry`. Most members are
    // methods, so the usual symptom is a flat call throwing — but not all are:
    // `relationEdges` is array metadata, and it breaks by reading as the wrong
    // value rather than by throwing. Restating the member list by hand is how six
    // members ended up guarded and twenty-plus did not; this fails the moment the
    // writer grows a member the set does not name.
    it("covers every member of DatabaseWriterLike", () => {
        expect.assertions(1);

        expect([...RESERVED_TABLE_NAMES].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(writerMembers());
    });

    it.each(["aggregate", "count", "findMany", "rank"])("rejects a table named %s at discovery", (name) => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                ${name}: defineTable({ text: v.string() }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(new RegExp(`table name "${name}" is reserved`, "u"));
    });

    it("names the colliding member and what breaks, so the fix needs no source reading", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                count: defineTable({ text: v.string() }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(/ctx\.db\.count\b/u);
    });
});
