import type { GlobalTablePage } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { fnv1aHex } from "../../../../../shared/fnv1a";
import { GlobalDataBrowser } from "../../../src/features/data/global-data-browser";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/**
 * The `.global()` (D1) browser's half of the mask preview. Its surfaces are a
 * subset of the shard browser's — there is no row-detail drawer, no JSON view,
 * no transposed view and no export here — so what is covered is: the header
 * chips, the grid cells, the facet sidebar, and the drill-down filter chips
 * (whose values come from a facet dump, i.e. from stored data).
 *
 * The metadata is the same one the shard browser reads:
 * `__lunora_admin__:maskPolicies` is deployment-wide `(table, column, strategy)`
 * and a `.global()` table is browsed under its logical schema name with its
 * declared columns (`@lunora/d1`'s `resolveColumns`), so the lookup resolves for
 * both tiers off the same payload.
 */

const TABLES = [{ name: "accounts", rowCount: 2 }];

const ACCOUNT_ROWS = [
    { _creationTime: 1, _id: "a1", email: "ada@example.com", name: "Ada Lovelace" },
    { _creationTime: 2, _id: "a2", email: "grace@example.com", name: "Grace Hopper" },
];

const ACCOUNT_COLUMNS = ["_id", "_creationTime", "email", "name"];

/** Mask coverage the worker would serve: `accounts.email` redacted, `accounts.name` hashed. */
const MASK_POLICIES = {
    columns: [
        { column: "email", strategy: "redact", table: "accounts" },
        { column: "name", strategy: "hash", table: "accounts" },
    ],
};

const createMaskedClient = (policies: unknown = MASK_POLICIES): MockClientHooks =>
    createMockClient({
        facetGlobalColumn: (options) => {
            const values = ACCOUNT_ROWS.map((row) => {
                return { count: 1, value: row[options.column as "email" | "name"] };
            });

            return { truncated: false, values };
        },
        listGlobalTables: () => TABLES,
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.maskPolicies) {
                return policies;
            }

            return undefined;
        },
        readGlobalTablePage: (options): GlobalTablePage => {
            const filter = options.filters?.[0];
            const rows = filter === undefined ? ACCOUNT_ROWS : ACCOUNT_ROWS.filter((row) => row[filter.column as "email"] === filter.value);

            return { columns: ACCOUNT_COLUMNS, rows, total: rows.length };
        },
    });

const renderBrowser = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <GlobalDataBrowser />
    </LunoraProvider>
);

const openAccounts = async (mock: MockClientHooks): Promise<void> => {
    render(renderBrowser(mock));
    fireEvent.click(await screen.findByTestId("gdb-table-accounts"));
    await screen.findByTestId("gdb-page");
};

describe("globalDataBrowser masking", () => {
    it("marks mask-covered columns with a header chip (independent of the toggle)", async () => {
        expect.assertions(3);

        await openAccounts(createMaskedClient());

        // Chips render from the static codegen metadata, before any toggle.
        expect(screen.getByTestId("gdb-mask-chip-email")).toBeDefined();
        expect(screen.getByTestId("gdb-mask-chip-name")).toBeDefined();
        // A non-covered column gets no chip.
        expect(screen.queryByTestId("gdb-mask-chip-_id")).toBeNull();
    });

    it("redacts and hashes covered cells by default (toggle defaults on)", async () => {
        expect.assertions(3);

        await openAccounts(createMaskedClient());

        const firstRow = screen.getAllByTestId("gdb-row")[0] as HTMLElement;

        expect(within(firstRow).queryByText("ada@example.com")).toBeNull();
        // hash → the same FNV-1a token the server's `"hash"` strategy produces.
        expect(within(firstRow).getByText(fnv1aHex("Ada Lovelace"))).toBeDefined();
        expect(within(firstRow).queryByText("Ada Lovelace")).toBeNull();
    });

    it("reveals raw values once the mask toggle is switched off", async () => {
        expect.assertions(2);

        await openAccounts(createMaskedClient());

        fireEvent.click(screen.getByTestId("gdb-mask-toggle"));

        const firstRow = screen.getAllByTestId("gdb-row")[0] as HTMLElement;

        expect(within(firstRow).getByText("ada@example.com")).toBeDefined();
        expect(within(firstRow).getByText("Ada Lovelace")).toBeDefined();
    });

    it("hides the toggle when no column in the selected table is masked", async () => {
        expect.assertions(1);

        // No explicit policies, and none of the columns (`_id`, `_creationTime`,
        // `email`, `name`) trips the name heuristic.
        await openAccounts(createMaskedClient({ columns: [] }));

        expect(screen.queryByTestId("gdb-mask-toggle")).toBeNull();
    });

    it("masks a plaintext secret column with no explicit policy via the name heuristic", async () => {
        expect.assertions(3);

        const mock = createMockClient({
            listGlobalTables: () => [{ name: "keys", rowCount: 1 }],
            query: (reference): unknown => (reference === ADMIN_FUNCTIONS.maskPolicies ? { columns: [] } : undefined),
            readGlobalTablePage: (): GlobalTablePage => {
                return { columns: ["_id", "api_key"], rows: [{ _id: "k1", api_key: "sk-live-42" }], total: 1 };
            },
        });

        render(renderBrowser(mock));
        fireEvent.click(await screen.findByTestId("gdb-table-keys"));
        await screen.findByTestId("gdb-page");

        expect(screen.getByTestId("gdb-mask-toggle")).toBeDefined();
        expect(within(screen.getAllByTestId("gdb-row")[0] as HTMLElement).queryByText("sk-live-42")).toBeNull();

        fireEvent.click(screen.getByTestId("gdb-mask-toggle"));

        expect(within(screen.getAllByTestId("gdb-row")[0] as HTMLElement).getByText("sk-live-42")).toBeDefined();
    });

    it("withholds the facet toggle for mask-covered columns while the preview is on", async () => {
        expect.assertions(3);

        await openAccounts(createMaskedClient());

        expect(screen.getByTestId("db-facet-toggle-_id")).toBeDefined();
        expect(screen.queryByTestId("db-facet-toggle-email")).toBeNull();
        expect(screen.queryByTestId("db-facet-toggle-name")).toBeNull();
    });

    it("hides an already-open facet's raw values when the mask preview is switched back on", async () => {
        expect.assertions(2);

        await openAccounts(createMaskedClient());

        // Reveal (the toggle defaults on), then open the email facet.
        fireEvent.click(screen.getByTestId("gdb-mask-toggle"));
        fireEvent.click(screen.getByTestId("db-facet-toggle-email"));

        const values = await screen.findAllByTestId("db-facet-value-email");

        expect(values[0]?.textContent).toContain("ada@example.com");

        fireEvent.click(screen.getByTestId("gdb-mask-toggle"));

        expect(screen.queryByTestId("db-facet-email")).toBeNull();
    });

    it("masks the drill-down filter chip of a covered column when the preview is switched back on", async () => {
        expect.assertions(2);

        await openAccounts(createMaskedClient());

        // Reveal, facet the covered column, and drill into one of its values — the
        // chip then carries a stored secret.
        fireEvent.click(screen.getByTestId("gdb-mask-toggle"));
        fireEvent.click(screen.getByTestId("db-facet-toggle-email"));
        const facetValues = await screen.findAllByTestId("db-facet-value-email");

        fireEvent.click(facetValues[0] as HTMLElement);

        const chip = await screen.findByTestId("gdb-filter-chip");

        expect(chip.textContent).toContain("ada@example.com");

        // Re-mask: the chip must go with the cells, not keep rendering the raw value.
        fireEvent.click(screen.getByTestId("gdb-mask-toggle"));

        expect(screen.getByTestId("gdb-filter-chip").textContent).not.toContain("ada@example.com");
    });
});
