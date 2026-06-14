import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SchemaEdge } from "../../../src/features/schema/layout";
import { buildEdges, buildNodes, SchemaDiagram } from "../../../src/features/schema/schema-diagram";
import { SchemaViewer } from "../../../src/features/schema/schema-viewer";
import type { ColumnMeta } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const MESSAGES_COLUMNS: ColumnMeta[] = [
    { name: "_id", optional: false, pk: true, type: "id" },
    { name: "_creationTime", optional: false, type: "number" },
    { name: "author", optional: false, ref: "users", type: "id" },
    { name: "text", optional: false, type: "string" },
];

const USERS_COLUMNS: ColumnMeta[] = [
    { name: "_id", optional: false, pk: true, type: "id" },
    { name: "_creationTime", optional: false, type: "number" },
    { name: "name", optional: false, type: "string" },
];

const COLUMNS_BY_TABLE: Record<string, ColumnMeta[]> = { messages: MESSAGES_COLUMNS, users: USERS_COLUMNS };
const TABLES = ["messages", "users"];
const REF_EDGES: SchemaEdge[] = [{ column: "author", from: "messages", to: "users" }];
const NO_TABLES: string[] = [];
const NO_EDGES: SchemaEdge[] = [];
const NO_COLUMNS: Record<string, ColumnMeta[]> = {};

describe("buildNodes", () => {
    it("builds one databaseSchema node per table, carrying its typed columns", () => {
        expect.assertions(4);

        const nodes = buildNodes(TABLES, REF_EDGES, COLUMNS_BY_TABLE, "shard");
        const messages = nodes.find((node) => node.id === "messages");

        expect(nodes).toHaveLength(2);
        expect(messages?.type).toBe("databaseSchema");
        expect(messages?.data.columns).toHaveLength(4);
        expect(messages?.data.tier).toBe("shard");
    });
});

describe("buildEdges", () => {
    it("draws an FK edge from the referenced PK (source) to the referencing column (target)", () => {
        expect.assertions(4);

        const edges = buildEdges(REF_EDGES, COLUMNS_BY_TABLE);

        expect(edges).toHaveLength(1);
        // `messages.author → users`: the edge flows from `users`' PK to `messages.author`.
        expect(edges[0]?.source).toBe("users");
        expect(edges[0]?.sourceHandle).toBe("_id");
        expect(edges[0]?.target).toBe("messages");
    });

    it("targets the referencing column's handle", () => {
        expect.assertions(1);

        const edges = buildEdges(REF_EDGES, COLUMNS_BY_TABLE);

        expect(edges[0]?.targetHandle).toBe("author");
    });

    it("skips an edge when the columns aren't loaded (handles would be missing)", () => {
        expect.assertions(1);

        expect(buildEdges(REF_EDGES, NO_COLUMNS)).toHaveLength(0);
    });
});

describe("schemaDiagram (component)", () => {
    it("renders a node per table with its columns and PK/FK markers", () => {
        expect.assertions(5);

        render(<SchemaDiagram columnsByTable={COLUMNS_BY_TABLE} edges={REF_EDGES} tables={TABLES} testIdPrefix="sd" tier="shard" />);

        expect(screen.getByTestId("sd-node-messages")).toBeDefined();
        expect(screen.getByTestId("sd-node-users")).toBeDefined();
        expect(screen.getByTestId("sd-col-messages-author")).toBeDefined();
        // The `_id` row carries a PK badge; the `author` row carries an FK badge.
        expect(screen.getByTestId("sd-col-messages-_id").textContent).toContain("PK");
        expect(screen.getByTestId("sd-col-messages-author").textContent).toContain("FK");
    });

    it("shows an empty state when there are no tables", () => {
        expect.assertions(1);

        render(<SchemaDiagram columnsByTable={NO_COLUMNS} edges={NO_EDGES} tables={NO_TABLES} testIdPrefix="sd" tier="global" />);

        expect(screen.getByTestId("sd-empty").textContent).toContain("No tables to graph");
    });
});

/** A shard mock whose `messages` table carries a `v.id("users")` ref + typed columns via describeTable. */
const createClient = (): MockClientHooks =>
    createMockClient({
        listGlobalTables: () => [],
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [
                    { name: "messages", rowCount: 3 },
                    { name: "users", rowCount: 1 },
                ];
            }

            if (reference === ADMIN_FUNCTIONS.readTablePage) {
                const { table } = args as { table: string };

                return table === "messages"
                    ? { columns: ["__id__", "author", "text"], refs: { author: "users" }, rows: [], total: 0 }
                    : { columns: ["__id__", "name"], rows: [], total: 0 };
            }

            if (reference === ADMIN_FUNCTIONS.describeTable) {
                const { table } = args as { table: string };

                return { columns: COLUMNS_BY_TABLE[table] ?? [] };
            }

            throw new Error(`unexpected ${reference}`);
        },
        readGlobalTablePage: () => {
            return { columns: [], rows: [], total: 0 };
        },
    });

const renderViewer = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <SchemaViewer />
    </CirrusProvider>
);

describe("schemaDiagram (viewer integration)", () => {
    it("renders the diagram node with a typed column when switched to graph view", async () => {
        expect.assertions(1);

        render(renderViewer(createClient()));

        await screen.findByTestId("sc-table-messages");
        fireEvent.click(screen.getByTestId("sc-view-graph"));

        // The shard diagram renders the `messages` node, with its `author` FK column probed via describeTable.
        const column = await screen.findByTestId("sd-col-messages-author");

        expect(column.textContent).toContain("author");
    });
});
