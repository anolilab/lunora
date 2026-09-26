import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { DataBrowser } from "../../../src/features/data/data-browser";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { createMockClient } from "../../mock-client";

// Two tenant shards that each hold a row with the SAME explicit id — a per-tenant settings row.
const ROWS: Record<string, { __id__: string; text: string }[]> = {
    "": [{ __id__: "cfg", text: "root-value" }],
    "tenant-b": [{ __id__: "cfg", text: "tenant-b-value" }],
};

const Host = () => {
    const [table, setTable] = useState<string | undefined>(undefined);

    return <DataBrowser editable onSelectTable={setTable} tableParam={table} />;
};

describe("data browser — manual shard switch", () => {
    it("drops edits staged on the previous shard instead of committing them to the new one", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: (reference, _args, options): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "messages", rowCount: 1 }];
                }

                const rows = ROWS[(options as { shardKey?: string } | undefined)?.shardKey ?? ""] ?? [];

                return { columns: ["__id__", "text"], rows, total: rows.length };
            },
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Host />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("db-table-messages"));
        await waitFor(() => {
            expect(screen.getByTestId("db-cell-cfg-text").textContent).toBe("root-value");
        });

        // Stage an edit on the ROOT shard's row.
        fireEvent.doubleClick(screen.getByTestId("db-cell-cfg-text"));

        const input = await screen.findByTestId<HTMLInputElement>("db-cell-input-cfg-text");

        fireEvent.change(input, { target: { value: "EDIT-MEANT-FOR-ROOT" } });
        fireEvent.keyDown(input, { key: "Enter" });
        await screen.findByTestId("db-staged");

        // The operator retypes the shard box (no URL re-seed).
        fireEvent.change(screen.getByTestId("db-shard-input"), { target: { value: "tenant-b" } });

        await waitFor(
            () => {
                expect(screen.getByTestId("db-cell-cfg-text").textContent).toBe("tenant-b-value");
            },
            { timeout: 3000 },
        );

        expect(screen.queryByTestId("db-staged")).toBeNull();
        expect(mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.writeRow)).toHaveLength(0);
    });
});
