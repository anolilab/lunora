import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ADMIN_FUNCTIONS } from "../src/admin";
import type { SchemaEdge } from "../src/schema-graph";
import { SchemaGraph } from "../src/schema-graph";
import { SchemaViewer } from "../src/schema-viewer";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const TABLES = [
    { name: "messages", rowCount: 3 },
    { name: "users", rowCount: 1 },
];

const GLOBAL_TABLES = [{ name: "user", rowCount: 5 }];

// Hoisted graph-prop fixtures so the JSX props aren't fresh arrays each render.
const TABLE_NAMES = ["messages", "users"];
const NODE_NAMES = ["nodes"];
const NO_NAMES: string[] = [];
const NO_EDGES: SchemaEdge[] = [];
const REF_EDGES: SchemaEdge[] = [{ column: "author", from: "messages", to: "users" }];
const SELF_EDGES: SchemaEdge[] = [{ column: "parent", from: "nodes", to: "nodes" }];

/** A shard mock whose `messages` table carries a `v.id("users")` ref (the `author` column). */
const createClient = (): MockClientHooks =>
    createMockClient({
        listGlobalTables: () => GLOBAL_TABLES,
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return TABLES;
            }

            if (reference === ADMIN_FUNCTIONS.readTablePage) {
                const { table } = args as { table: string };

                if (table === "messages") {
                    return { columns: ["__id__", "author", "text"], refs: { author: "users" }, rows: [], total: 0 };
                }

                return { columns: ["__id__", "name"], rows: [], total: 0 };
            }

            throw new Error(`unexpected ${reference}`);
        },
        readGlobalTablePage: () => {
            return { columns: ["_id", "email"], rows: [], total: 0 };
        },
    });

const renderViewer = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <SchemaViewer />
    </CirrusProvider>
);

describe("schemaGraph (component)", () => {
    it("renders a node per table", () => {
        expect.assertions(2);

        render(<SchemaGraph edges={NO_EDGES} tables={TABLE_NAMES} testIdPrefix="g" tier="shard" />);

        expect(screen.getByTestId("g-node-messages")).toBeDefined();
        expect(screen.getByTestId("g-node-users")).toBeDefined();
    });

    it("renders a directed edge for a v.id ref", () => {
        expect.assertions(1);

        render(<SchemaGraph edges={REF_EDGES} tables={TABLE_NAMES} testIdPrefix="g" tier="shard" />);

        expect(screen.getByTestId("g-edge-messages-author-users")).toBeDefined();
    });

    it("tolerates a self-referential edge without crashing", () => {
        expect.assertions(1);

        render(<SchemaGraph edges={SELF_EDGES} tables={NODE_NAMES} testIdPrefix="g" tier="shard" />);

        expect(screen.getByTestId("g-edge-nodes-parent-nodes")).toBeDefined();
    });

    it("shows an empty state when there are no tables", () => {
        expect.assertions(1);

        render(<SchemaGraph edges={NO_EDGES} tables={NO_NAMES} testIdPrefix="g" tier="global" />);

        expect(screen.getByTestId("g-empty").textContent).toContain("No tables to graph");
    });
});

describe("schemaGraph (viewer integration)", () => {
    it("toggles between the table list and the graph view", async () => {
        expect.assertions(3);

        render(renderViewer(createClient()));

        // List view is the default.
        await screen.findByTestId("sc-table-messages");

        expect(screen.queryByTestId("sc-graph-view")).toBeNull();

        // Switch to the graph.
        fireEvent.click(screen.getByTestId("sc-view-graph"));

        const node = await screen.findByTestId("sc-graph-shard-node-messages");

        expect(node.textContent).toContain("messages");

        // Switch back to the list.
        fireEvent.click(screen.getByTestId("sc-view-list"));

        expect(screen.queryByTestId("sc-graph-view")).toBeNull();
    });

    it("draws a foreign-key edge probed from a table's refs", async () => {
        expect.assertions(1);

        render(renderViewer(createClient()));

        await screen.findByTestId("sc-table-messages");
        fireEvent.click(screen.getByTestId("sc-view-graph"));

        // The `messages.author` → `users` ref becomes a directed edge.
        const edge = await screen.findByTestId("sc-graph-shard-edge-messages-author-users");

        expect(edge.getAttribute("marker-end")).toContain("url(#");
    });

    it("still renders graph nodes when a ref probe fails", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            listGlobalTables: () => [],
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return TABLES;
                }

                // Every readTablePage probe rejects.
                throw new Error("probe failed");
            },
        });

        render(renderViewer(mock));

        await screen.findByTestId("sc-table-messages");
        fireEvent.click(screen.getByTestId("sc-view-graph"));

        // Nodes render even though the ref probe threw.
        const node = await screen.findByTestId("sc-graph-shard-node-users");

        expect(node).toBeDefined();
    });
});
