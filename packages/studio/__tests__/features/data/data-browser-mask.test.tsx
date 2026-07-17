import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { DataBrowser } from "../../../src/features/data/data-browser";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { fnv1aHex } from "../../../src/lib/mask-preview";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const TABLES = [{ name: "users", rowCount: 2 }];

const USER_ROWS = [
    { __id__: "u1", email: "ada@example.com", name: "Ada Lovelace" },
    { __id__: "u2", email: "grace@example.com", name: "Grace Hopper" },
];

const USERS_PAGE = { columns: ["__id__", "email", "name"], rows: USER_ROWS, total: USER_ROWS.length };

/** Mask coverage the worker would serve: `users.email` redacted, `users.name` hashed. */
const MASK_POLICIES = {
    columns: [
        { column: "email", strategy: "redact", table: "users" },
        { column: "name", strategy: "hash", table: "users" },
    ],
};

/**
 * A client serving a fixed `users` table plus the mask metadata. `readTablePage`
 * (and any other un-cased admin read) falls through to the page so the browser
 * loads rows; `listTables` and `maskPolicies` are served explicitly.
 */
const createMaskedClient = (policies: unknown = MASK_POLICIES): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return TABLES;
            }

            if (reference === ADMIN_FUNCTIONS.maskPolicies) {
                return policies;
            }

            return USERS_PAGE;
        },
    });

/**
 * Test host emulating the studio's URL-controlled wiring: the browser's open
 * table is derived from `tableParam`, so a standalone mount needs selection
 * state fed back through `onSelectTable` (see data-browser.test.tsx).
 */
const ControlledDataBrowser = (): ReactElement => {
    const [table, setTable] = useState<string | undefined>(undefined);

    return <DataBrowser onSelectTable={setTable} tableParam={table} />;
};

const renderBrowser = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <ControlledDataBrowser />
    </LunoraProvider>
);

const openUsers = async (mock: MockClientHooks): Promise<void> => {
    render(renderBrowser(mock));
    fireEvent.click(await screen.findByTestId("db-table-users"));
    await screen.findByTestId("db-page");
};

describe("dataBrowser masking", () => {
    it("marks mask-covered columns with a header chip (independent of the toggle)", async () => {
        expect.assertions(3);

        const mock = createMaskedClient();

        await openUsers(mock);

        // Chips render from the static codegen metadata, before any toggle.
        expect(screen.getByTestId("db-mask-chip-email")).toBeDefined();
        expect(screen.getByTestId("db-mask-chip-name")).toBeDefined();
        // A non-covered column gets no chip.
        expect(screen.queryByTestId("db-mask-chip-__id__")).toBeNull();
    });

    it("reveals raw values once the mask toggle is switched off", async () => {
        expect.assertions(2);

        const mock = createMaskedClient();

        await openUsers(mock);

        // The toggle defaults ON (sensitive columns present), so reveal raw values
        // by switching it off.
        fireEvent.click(screen.getByTestId("db-mask-toggle"));

        const firstRow = screen.getAllByTestId("db-row")[0] as HTMLElement;

        expect(within(firstRow).getByText("ada@example.com")).toBeDefined();
        expect(within(firstRow).getByText("Ada Lovelace")).toBeDefined();
    });

    it("redacts and hashes covered cells by default (toggle defaults on)", async () => {
        expect.assertions(3);

        const mock = createMaskedClient();

        await openUsers(mock);

        const firstRow = screen.getAllByTestId("db-row")[0] as HTMLElement;

        // redact → NULL sentinel; raw email is gone.
        expect(within(firstRow).queryByText("ada@example.com")).toBeNull();
        // hash → deterministic FNV-1a token mirroring the server's `"hash"` strategy.
        expect(within(firstRow).getByText(fnv1aHex("Ada Lovelace"))).toBeDefined();
        // The raw name is no longer rendered.
        expect(within(firstRow).queryByText("Ada Lovelace")).toBeNull();
    });

    it("masks the JSON view by default (toggle defaults on)", async () => {
        expect.assertions(2);

        const mock = createMaskedClient();

        await openUsers(mock);

        fireEvent.click(screen.getByTestId("db-view-json"));

        const json = screen.getByTestId("db-json").textContent ?? "";

        expect(json).not.toContain("ada@example.com");
        expect(json).toContain(fnv1aHex("Ada Lovelace"));
    });

    it("hides the toggle when no column in the selected table is masked", async () => {
        expect.assertions(1);

        // No explicit policies AND the columns (`__id__`, `email`, `name`) carry no
        // heuristic-sensitive names, so nothing is masked and the toggle is hidden.
        const mock = createMaskedClient({ columns: [] });

        await openUsers(mock);

        expect(screen.queryByTestId("db-mask-toggle")).toBeNull();
    });

    it("masks a plaintext secret column with no explicit policy via the name heuristic", async () => {
        expect.assertions(3);

        const SECRET_TABLES = [{ name: "accounts", rowCount: 1 }];
        const SECRET_PAGE = {
            columns: ["__id__", "password"],
            rows: [{ __id__: "a1", password: "hunter2" }],
            total: 1,
        };

        // No mask policies at all — masking must come purely from the name heuristic.
        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return SECRET_TABLES;
                }

                if (reference === ADMIN_FUNCTIONS.maskPolicies) {
                    return { columns: [] };
                }

                return SECRET_PAGE;
            },
        });

        render(renderBrowser(mock));
        fireEvent.click(await screen.findByTestId("db-table-accounts"));
        await screen.findByTestId("db-page");

        // The toggle appears (a sensitive column exists) and defaults ON, so the
        // plaintext secret is hidden out of the box.
        expect(screen.getByTestId("db-mask-toggle")).toBeDefined();

        const firstRow = screen.getAllByTestId("db-row")[0] as HTMLElement;

        expect(within(firstRow).queryByText("hunter2")).toBeNull();

        // Toggling off reveals the raw value.
        fireEvent.click(screen.getByTestId("db-mask-toggle"));

        expect(within(screen.getAllByTestId("db-row")[0] as HTMLElement).getByText("hunter2")).toBeDefined();
    });
});
