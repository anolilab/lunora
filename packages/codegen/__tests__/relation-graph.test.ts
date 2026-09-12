/**
 * `schemaDeclaresRelationGraph` — the `relationGraph` platform signal.
 *
 * Two things are pinned here. First the answer itself, per declaration shape.
 * Second, and the reason this file matters: that the answer AGREES with
 * `@lunora/shard-engine`'s `deriveRelationEdges`, which is the derivation the
 * runtime traversal actually walks.
 *
 * The two read different inputs — static AST IR here, live `defineSchema`
 * validators there — so they cannot share code, and before this they did not
 * share a fixture either: each had its own, and nothing compared them. That is
 * exactly how a gate desyncs from the runtime with every test green (teach one
 * side to unwrap `v.union` and the codegen gate starts claiming a graph the
 * traversal cannot walk, or the reverse). So every case below is written ONCE as
 * a column spec and projected into both worlds.
 */
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { deriveRelationEdges } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { SchemaIR, TableIR, ValidatorIR } from "../src/ir";
import schemaDeclaresRelationGraph from "../src/relation-graph";

/** One column, described once for both projections below. */
type ColumnSpec =
    | { inner: ColumnSpec; kind: "array" | "optional" }
    | { kind: "id"; target: string }
    | { kind: "object"; shape: Record<string, ColumnSpec> }
    | { kind: "text" }
    | { kind: "union"; members: ColumnSpec[] };

interface TableSpec {
    columns: Record<string, ColumnSpec>;
    name: string;
}

/** The column spec as `@lunora/codegen`'s discovered IR sees it. */
const toValidatorIr = (column: ColumnSpec): ValidatorIR => {
    switch (column.kind) {
        case "array":
        case "optional": {
            return { inner: toValidatorIr(column.inner), kind: column.kind };
        }
        case "id": {
            return { kind: "id", tableName: column.target };
        }
        case "object": {
            return { kind: "object", shape: Object.fromEntries(Object.entries(column.shape).map(([field, spec]) => [field, toValidatorIr(spec)])) };
        }
        case "union": {
            return { kind: "union", members: column.members.map((member) => toValidatorIr(member)) };
        }
        default: {
            return { kind: "string" };
        }
    }
};

/**
 * The same column as `@lunora/values` leaves it on a live validator at runtime.
 *
 * An object or a union projects OPAQUELY, and that is the fixture being faithful
 * rather than lazy: `ValidatorLike._meta` carries `column`, `inner` and
 * `tableName` and nothing else, so an id nested in one is genuinely unreachable
 * from the runtime derivation. The IR side above keeps the nesting, so a codegen
 * copy that learned to descend into either would light up the cross-pin.
 */
const toValidatorLike = (column: ColumnSpec): ValidatorLike => {
    switch (column.kind) {
        case "array":
        case "optional": {
            return { _meta: { inner: toValidatorLike(column.inner) }, kind: column.kind };
        }
        case "id": {
            return { _meta: { tableName: column.target }, kind: "id" };
        }
        case "object":
        case "union": {
            return { kind: column.kind };
        }
        default: {
            return { kind: "string" };
        }
    }
};

const toSchemaIr = (tables: ReadonlyArray<TableSpec>): SchemaIR => {
    return {
        tables: tables.map((table): TableIR => {
            return {
                indexes: [],
                name: table.name,
                rankIndexes: [],
                relations: [],
                searchIndexes: [],
                shape: Object.fromEntries(Object.entries(table.columns).map(([column, spec]) => [column, toValidatorIr(spec)])),
                shardMode: "root",
                vectorIndexes: [],
            };
        }),
        vectorIndexes: [],
    };
};

const toSchemaLike = (tables: ReadonlyArray<TableSpec>): SchemaLike => {
    return {
        tables: Object.fromEntries(
            tables.map((table) => [
                table.name,
                {
                    indexes: [],
                    shape: Object.fromEntries(Object.entries(table.columns).map(([column, spec]) => [column, toValidatorLike(spec)])),
                },
            ]),
        ),
    };
};

const text: ColumnSpec = { kind: "text" };
const id = (target: string): ColumnSpec => {
    return { kind: "id", target };
};
const optional = (inner: ColumnSpec): ColumnSpec => {
    return { inner, kind: "optional" };
};
const array = (inner: ColumnSpec): ColumnSpec => {
    return { inner, kind: "array" };
};

/** Every declaration shape that decides the signal, each written once. */
const CASES: ReadonlyArray<{ declares: boolean; name: string; tables: TableSpec[] }> = [
    {
        declares: true,
        name: "a plain v.id column",
        tables: [
            { columns: { name: text }, name: "customers" },
            { columns: { customerId: id("customers"), subject: text }, name: "tickets" },
        ],
    },
    {
        declares: true,
        name: "an optional v.id column",
        tables: [
            { columns: { name: text }, name: "users" },
            { columns: { authorId: optional(id("users")) }, name: "posts" },
        ],
    },
    {
        declares: true,
        name: "an array of ids",
        tables: [
            { columns: { label: text }, name: "tags" },
            { columns: { tagIds: array(id("tags")) }, name: "posts" },
        ],
    },
    {
        declares: true,
        name: "an optional array of ids",
        tables: [
            { columns: { label: text }, name: "tags" },
            { columns: { tagIds: optional(array(id("tags"))) }, name: "posts" },
        ],
    },
    {
        declares: true,
        name: "a self-referential id",
        tables: [{ columns: { parentId: optional(id("nodes")), title: text }, name: "nodes" }],
    },
    {
        declares: false,
        name: "an id whose target table the schema does not declare",
        tables: [{ columns: { archiveId: id("archive"), body: text }, name: "notes" }],
    },
    {
        declares: false,
        name: "an id buried in a structure the query layer cannot filter on",
        tables: [
            { columns: { name: text }, name: "users" },
            {
                columns: {
                    meta: { kind: "object", shape: { ownerId: id("users") } },
                    tagged: { kind: "union", members: [id("users"), text] },
                },
                name: "notes",
            },
        ],
    },
    {
        declares: false,
        name: "no foreign key at all",
        tables: [{ columns: { line: text }, name: "logs" }],
    },
    {
        declares: false,
        name: "no tables at all",
        tables: [],
    },
];

describe("schemaDeclaresRelationGraph", () => {
    it.each(CASES)("answers $declares for $name", ({ declares, tables }) => {
        expect.assertions(1);

        expect(schemaDeclaresRelationGraph(toSchemaIr(tables))).toBe(declares);
    });

    // The cross-pin. Codegen's gate and the runtime's edge set read different
    // inputs for the same fact, so nothing but this stops them diverging.
    it.each(CASES)("agrees with the runtime edge set for $name", ({ tables }) => {
        expect.assertions(1);

        expect(schemaDeclaresRelationGraph(toSchemaIr(tables))).toBe(deriveRelationEdges(toSchemaLike(tables)).length > 0);
    });
});
