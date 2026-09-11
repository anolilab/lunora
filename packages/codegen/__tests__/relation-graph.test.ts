import { describe, expect, it } from "vitest";

import type { SchemaIR, TableIR, ValidatorIR } from "../src/ir";
import { deriveRelationEdges } from "../src/relation-graph";

/** Build a minimal `TableIR` with the given field shape. */
const table = (name: string, shape: TableIR["shape"]): TableIR => {
    return {
        indexes: [],
        name,
        rankIndexes: [],
        relations: [],
        searchIndexes: [],
        shape,
        shardMode: "root",
        vectorIndexes: [],
    };
};

const schema = (tables: TableIR[]): SchemaIR => {
    return { tables, vectorIndexes: [] };
};

const idOf = (tableName: string): ValidatorIR => {
    return { kind: "id", tableName };
};
const optionalOf = (inner: ValidatorIR): ValidatorIR => {
    return { inner, kind: "optional" };
};
const arrayOf = (inner: ValidatorIR): ValidatorIR => {
    return { inner, kind: "array" };
};
const text: ValidatorIR = { kind: "string" };

describe("deriveRelationEdges", () => {
    it("derives one named edge per v.id column, in declaration order", () => {
        expect.assertions(1);

        const ir = schema([
            table("customers", { name: text }),
            table("tickets", { customerId: idOf("customers"), subject: text }),
            table("messages", { body: text, ticketId: idOf("tickets") }),
        ]);

        expect(deriveRelationEdges(ir)).toStrictEqual([
            { array: false, column: "customerId", name: "tickets.customerId", sourceTable: "tickets", targetTable: "customers" },
            { array: false, column: "ticketId", name: "messages.ticketId", sourceTable: "messages", targetTable: "tickets" },
        ]);
    });

    it("treats an optional id as an edge", () => {
        expect.assertions(1);

        const ir = schema([table("users", { name: text }), table("posts", { authorId: optionalOf(idOf("users")) })]);

        expect(deriveRelationEdges(ir)).toStrictEqual([
            { array: false, column: "authorId", name: "posts.authorId", sourceTable: "posts", targetTable: "users" },
        ]);
    });

    it("treats an array of ids as a to-many edge and marks it", () => {
        expect.assertions(1);

        const ir = schema([table("tags", { label: text }), table("posts", { tagIds: arrayOf(idOf("tags")) })]);

        expect(deriveRelationEdges(ir)).toStrictEqual([{ array: true, column: "tagIds", name: "posts.tagIds", sourceTable: "posts", targetTable: "tags" }]);
    });

    it("marks an optional array of ids as an array edge", () => {
        expect.assertions(1);

        const ir = schema([table("tags", { label: text }), table("posts", { tagIds: optionalOf(arrayOf(idOf("tags"))) })]);

        expect(deriveRelationEdges(ir)?.[0]?.array).toBe(true);
    });

    it("drops an edge whose target table the schema does not declare", () => {
        expect.assertions(1);

        const ir = schema([table("notes", { archiveId: idOf("archive"), body: text })]);

        expect(deriveRelationEdges(ir)).toStrictEqual([]);
    });

    it("ignores an id nested in a structure the query layer cannot filter on", () => {
        expect.assertions(1);

        const ir = schema([
            table("users", { name: text }),
            table("notes", { meta: { kind: "object", shape: { ownerId: idOf("users") } }, tagged: { kind: "union", members: [idOf("users"), text] } }),
        ]);

        expect(deriveRelationEdges(ir)).toStrictEqual([]);
    });

    it("returns no edges for a schema with no foreign keys", () => {
        expect.assertions(1);

        expect(deriveRelationEdges(schema([table("logs", { line: text })]))).toStrictEqual([]);
    });
});
