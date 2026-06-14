import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
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

const renderBrowser = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <DataBrowser />
    </CirrusProvider>
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

    it("shows raw values until the mask toggle is switched on", async () => {
        expect.assertions(2);

        const mock = createMaskedClient();

        await openUsers(mock);

        const firstRow = screen.getAllByTestId("db-row")[0] as HTMLElement;

        expect(within(firstRow).getByText("ada@example.com")).toBeDefined();
        expect(within(firstRow).getByText("Ada Lovelace")).toBeDefined();
    });

    it("redacts and hashes covered cells when the toggle is on", async () => {
        expect.assertions(3);

        const mock = createMaskedClient();

        await openUsers(mock);

        fireEvent.click(screen.getByTestId("db-mask-toggle"));

        const firstRow = screen.getAllByTestId("db-row")[0] as HTMLElement;

        // redact → NULL sentinel; raw email is gone.
        expect(within(firstRow).queryByText("ada@example.com")).toBeNull();
        // hash → deterministic FNV-1a token mirroring the server's `"hash"` strategy.
        expect(within(firstRow).getByText(fnv1aHex("Ada Lovelace"))).toBeDefined();
        // The raw name is no longer rendered.
        expect(within(firstRow).queryByText("Ada Lovelace")).toBeNull();
    });

    it("masks the JSON view when the toggle is on", async () => {
        expect.assertions(2);

        const mock = createMaskedClient();

        await openUsers(mock);

        fireEvent.click(screen.getByTestId("db-mask-toggle"));
        fireEvent.click(screen.getByTestId("db-view-json"));

        const json = screen.getByTestId("db-json").textContent ?? "";

        expect(json).not.toContain("ada@example.com");
        expect(json).toContain(fnv1aHex("Ada Lovelace"));
    });

    it("hides the toggle when no column in the selected table is masked", async () => {
        expect.assertions(1);

        const mock = createMaskedClient({ columns: [] });

        await openUsers(mock);

        expect(screen.queryByTestId("db-mask-toggle")).toBeNull();
    });
});
