import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { createElement, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { fnv1aHex } from "../../../../../shared/fnv1a";
import { DataBrowser } from "../../../src/features/data/data-browser";
import type { GridRow } from "../../../src/features/data/grid-features";
import { toCsv, toJson, toSql } from "../../../src/features/data/grid-features";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { maskValue } from "../../../src/lib/mask-preview";
import type { DataView } from "../../../src/lib/saved-queries";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/**
 * The page hands `GridActionsBar` the rows the Export menu serialises — the seam
 * where the raw page used to leak past the mask toggle into a downloaded file.
 * `ExportMenu` is called through a module-local binding inside `grid-features`,
 * so it cannot be intercepted; `GridActionsBar` is the closest observable point,
 * and it forwards `rows` to `ExportMenu` verbatim.
 */
const { exportedRows } = vi.hoisted(() => {
    return { exportedRows: vi.fn<(rows: ReadonlyArray<Record<string, unknown>>) => void>() };
});

vi.mock(import("../../../src/features/data/grid-features"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/features/data/grid-features")>();

    return {
        ...actual,
        GridActionsBar: (properties: Parameters<typeof actual.GridActionsBar>[0]): ReactElement => {
            const { rows } = properties;

            exportedRows(rows);

            return createElement(actual.GridActionsBar, properties);
        },
    };
});

const TABLES = [{ name: "users", rowCount: 2 }];

const USER_ROWS = [
    { __id__: "u1", email: "ada@example.com", name: "Ada Lovelace" },
    { __id__: "u2", email: "grace@example.com", name: "Grace Hopper" },
];

const USERS_PAGE = { columns: ["__id__", "email", "name"], rows: USER_ROWS, total: USER_ROWS.length };

/**
 * The one pin on the FNV-1a algorithm itself. The studio preview and the server's
 * `"hash"` mask strategy call the *same* function (`shared/fnv1a.ts`, inlined into
 * both bundles), so nothing has to assert that the two agree — they cannot
 * disagree. What is still worth pinning is the digest an unchanged algorithm must
 * produce, so an accidental edit to the shared helper (a different offset basis, a
 * `charCodeAt` swap, a dropped `>>> 0`) goes red instead of silently repseudonymising
 * every hashed column in every deployment.
 *
 * The inputs are the algorithm's edge cases, not sample data. `""` is the bare
 * offset basis with the loop never entered. `"9007199254740993"` is a bigint's
 * decimal form, past `Number.MAX_SAFE_INTEGER` (see the `"hash"` bigint case
 * below). `"x".repeat(4096)` is long enough to exercise the 32-bit wraparound many
 * times over. The emoji entry is non-BMP, so `codePointAt` reads the astral code
 * point at index 0 and a lone low surrogate at index 1 — a quirk of iterating by
 * UTF-16 index that the digest must keep reproducing.
 */
const FNV1A_DIGESTS: ReadonlyArray<readonly [input: string, digest: string]> = [
    // The bare FNV-1a offset basis.
    ["", "811c9dc5"],
    // A bigint's decimal form — see the `"hash"` bigint case below.
    ["9007199254740993", "aeb18cd1"],
    ["ada@example.com", "bef5cfd2"],
    ["x".repeat(4096), "e01bddc5"],
    // An astral character is folded ONCE, over its two UTF-16 code units — the
    // standard FNV-1a walk, and byte-for-byte what `@lunora/client`'s `hashToken`
    // and the Dart SDK's `_hashToken` produce. An earlier `codePointAt`-per-index
    // walk folded it twice (full code point, then the trailing low surrogate) and
    // pinned `9b551f7a` / `0faeabcd` here, digests no other implementation of the
    // algorithm agrees with.
    ["\u{1F642} masked", "3e19aa73"],
    ["\u{1F600}", "cb31c4b8"],
];

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
 * A `users` page whose `manager` column is a foreign key back into `users` and is
 * ALSO mask-covered under `"hash"` — the case where the drawer used to render an
 * `↗` link whose href pointed at a row id that is really a digest.
 */
const FK_PAGE = {
    columns: ["__id__", "manager"],
    refs: { manager: "users" },
    rows: [{ __id__: "u2", manager: "u1" }],
    total: 1,
};

const FK_POLICIES = { columns: [{ column: "manager", strategy: "hash", table: "users" }] };

const createFkClient = (): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return TABLES;
            }

            if (reference === ADMIN_FUNCTIONS.maskPolicies) {
                return FK_POLICIES;
            }

            return FK_PAGE;
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

    it("exports the masked rows, not the raw page (toggle defaults on)", async () => {
        expect.assertions(6);

        const mock = createMaskedClient();

        exportedRows.mockClear();

        await openUsers(mock);

        const rows = (exportedRows.mock.lastCall?.[0] ?? []) as ReadonlyArray<GridRow>;
        const csv = toCsv(USERS_PAGE.columns, rows);
        const json = toJson(rows);
        const sql = toSql("users", USERS_PAGE.columns, rows);

        // A download taken while the toggle is on carries what is on screen…
        expect(csv).not.toContain("ada@example.com");
        expect(csv).toContain(fnv1aHex("Ada Lovelace"));
        expect(json).not.toContain("grace@example.com");
        expect(json).toContain(fnv1aHex("Grace Hopper"));
        expect(sql).not.toContain("Ada Lovelace");
        expect(sql).toContain(fnv1aHex("Ada Lovelace"));
    });

    it("exports the raw rows again once the mask toggle is switched off", async () => {
        expect.assertions(2);

        const mock = createMaskedClient();

        exportedRows.mockClear();

        await openUsers(mock);

        fireEvent.click(screen.getByTestId("db-mask-toggle"));

        const rows = (exportedRows.mock.lastCall?.[0] ?? []) as ReadonlyArray<GridRow>;
        const csv = toCsv(USERS_PAGE.columns, rows);

        expect(csv).toContain("ada@example.com");
        expect(csv).toContain("Ada Lovelace");
    });

    it("masks the row detail drawer's covered fields (toggle defaults on)", async () => {
        expect.assertions(3);

        const mock = createMaskedClient();

        await openUsers(mock);

        fireEvent.click(screen.getByTestId("db-inspect-u1"));

        const panel = await screen.findByTestId("rd-panel");

        // The drawer reads the same masked row the grid renders — no raw values,
        // and no expand-to-raw affordance, matching the grid's masked cells.
        expect(panel.textContent).not.toContain("ada@example.com");
        expect(panel.textContent).not.toContain("Ada Lovelace");
        expect(panel.textContent).toContain(fnv1aHex("Ada Lovelace"));
    });

    it("drops the foreign-key link in the detail drawer for a mask-covered column", async () => {
        expect.assertions(3);

        const mock = createFkClient();

        await openUsers(mock);

        fireEvent.click(screen.getByTestId("db-inspect-u2"));

        const panel = await screen.findByTestId("rd-panel");

        // The hashed token is shown, and the `↗` navigation affordance is gone —
        // under `"hash"` it would target a row id that does not exist. Same policy
        // the grid takes for a masked cell.
        expect(panel.textContent).toContain(fnv1aHex("u1"));
        expect(screen.queryByTestId("rd-ref-manager")).toBeNull();
        expect(screen.getByTestId("rd-masked-manager")).toBeDefined();
    });

    it("restores the foreign-key link in the detail drawer once the mask toggle is switched off", async () => {
        expect.assertions(2);

        const mock = createFkClient();

        await openUsers(mock);

        fireEvent.click(screen.getByTestId("db-mask-toggle"));
        fireEvent.click(screen.getByTestId("db-inspect-u2"));

        await screen.findByTestId("rd-panel");

        expect(screen.getByTestId("rd-ref-manager").textContent).toContain("u1");
        expect(screen.queryByTestId("rd-masked-manager")).toBeNull();
    });

    it("reveals the raw row in the detail drawer once the mask toggle is switched off", async () => {
        expect.assertions(2);

        const mock = createMaskedClient();

        await openUsers(mock);

        fireEvent.click(screen.getByTestId("db-mask-toggle"));
        fireEvent.click(screen.getByTestId("db-inspect-u1"));

        const panel = await screen.findByTestId("rd-panel");

        expect(panel.textContent).toContain("ada@example.com");
        expect(panel.textContent).toContain("Ada Lovelace");
    });
});

/**
 * The facet sidebar lists a column's DISTINCT VALUES and, on click, writes the
 * clicked value into the URL as an `eq` filter. For a mask-covered column that is
 * strictly worse than the cell the preview already hides: a plaintext dump of the
 * secret, plus a shareable link carrying one. Every other surface (grid cell, row
 * detail, JSON, transposed, and all three exports) honours the preview, so this
 * one is held to the same rule — mirroring the grid cell's "no expand-to-raw
 * affordance" for a covered column.
 */
describe("dataBrowser masking — facets", () => {
    const FACET_VALUES = { truncated: false, values: [{ count: 1, value: "ada@example.com" }] };

    const createFacetClient = (): MockClientHooks =>
        createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return TABLES;
                }

                if (reference === ADMIN_FUNCTIONS.maskPolicies) {
                    return MASK_POLICIES;
                }

                if (reference === ADMIN_FUNCTIONS.facetColumn) {
                    return FACET_VALUES;
                }

                return USERS_PAGE;
            },
        });

    it("withholds the facet toggle for mask-covered columns while the preview is on", async () => {
        expect.assertions(3);

        const mock = createFacetClient();

        await openUsers(mock);

        // An uncovered column stays facetable…
        expect(screen.getByTestId("db-facet-toggle-__id__")).toBeDefined();
        // …the covered ones are withheld.
        expect(screen.queryByTestId("db-facet-toggle-email")).toBeNull();
        expect(screen.queryByTestId("db-facet-toggle-name")).toBeNull();
    });

    it("hides an already-open facet's raw values when the mask preview is switched back on", async () => {
        expect.assertions(2);

        const mock = createFacetClient();

        await openUsers(mock);

        // Reveal (the toggle defaults on), then open the email facet.
        fireEvent.click(screen.getByTestId("db-mask-toggle"));
        fireEvent.click(screen.getByTestId("db-facet-toggle-email"));

        const values = await screen.findAllByTestId("db-facet-value-email");

        expect(values[0]?.textContent).toContain("ada@example.com");

        // Re-mask: the open section must go with it, not keep rendering the dump.
        fireEvent.click(screen.getByTestId("db-mask-toggle"));

        expect(screen.queryByTestId("db-facet-email")).toBeNull();
    });
});

/**
 * The shard browser's filter bar is the one read surface that deliberately does
 * NOT honour the mask preview. `data-filters.tsx` carries the enumeration; these
 * two tests pin the two facts that enumeration rests on, so a later change that
 * invalidates either goes red instead of leaving a stale rationale in a comment:
 *
 * (a) a mask-covered filter row still renders its raw, editable value, and (b)
 * that same value is mirrored to the host for the URL (`?filters=`), which is what
 * makes leaving it raw cost nothing.
 */
describe("dataBrowser masking — filters", () => {
    /** A deep link that already carries a covered column's value — the shared-link case. */
    const LINKED_FILTERS = [{ column: "email", operator: "eq" as const, value: "ada@example.com" }];

    /**
     * The URL-controlled host, minus the URL: `initialFilters` stays fixed (as a
     * deep link's `?filters=` would) while the table selection is fed back through
     * `onSelectTable`, so opening `users` re-seeds the bar from those filters.
     */
    const LinkedDataBrowser = ({ onViewChange }: { onViewChange?: (view: Pick<DataView, "filters">) => void }): ReactElement => {
        const [table, setTable] = useState<string | undefined>(undefined);

        return <DataBrowser initialFilters={LINKED_FILTERS} onSelectTable={setTable} onViewChange={onViewChange} tableParam={table} />;
    };

    const openLinked = async (mock: MockClientHooks, onViewChange?: (view: Pick<DataView, "filters">) => void): Promise<void> => {
        render(
            <LunoraProvider client={mock.asClient}>
                <LinkedDataBrowser onViewChange={onViewChange} />
            </LunoraProvider>,
        );
        fireEvent.click(await screen.findByTestId("db-table-users"));
        await screen.findByTestId("db-page");
    };

    it("keeps a mask-covered filter row raw and editable while the preview masks the grid", async () => {
        expect.assertions(3);

        const mock = createMaskedClient();

        await openLinked(mock);

        // The toggle defaults ON, so the grid hides the very value the filter is on…
        const firstRow = screen.getAllByTestId("db-row")[0] as HTMLElement;

        expect(within(firstRow).queryByText("ada@example.com")).toBeNull();

        // …while the filter row keeps it, because the operator cannot edit `•••`
        // and the value is in the address bar anyway (pinned by the next test).
        const valueInput = screen.getByTestId<HTMLInputElement>("db-filter-value");

        expect(valueInput.value).toBe("ada@example.com");
        expect(screen.getByTestId<HTMLSelectElement>("db-filter-column").value).toBe("email");
    });

    it("mirrors a mask-covered filter value to the host, so it is already in the URL", async () => {
        expect.assertions(1);

        const mock = createMaskedClient();
        const onViewChange = vi.fn<(view: Pick<DataView, "filters">) => void>();

        await openLinked(mock, onViewChange);

        // Edit the covered row: the mirror is what puts the value into `?filters=`.
        fireEvent.change(screen.getByTestId("db-filter-value"), { target: { value: "grace@example.com" } });

        await waitFor(() => {
            if (onViewChange.mock.calls.length === 0) {
                throw new Error("the view was never mirrored to the host");
            }
        });

        // Every clause the host was handed — this is verbatim what `table-editor`
        // writes into `?filters=`, and therefore what the address bar already shows.
        const mirrored = onViewChange.mock.calls.flatMap(([view]) => view.filters ?? []);

        expect(mirrored).toContainEqual({ column: "email", operator: "eq", value: "grace@example.com" });
    });
});

describe("maskValue — 'hash'", () => {
    it("hashes a bigint over its decimal form instead of failing closed", () => {
        expect.assertions(2);

        // `JSON.stringify` throws on a bigint, which would fail the cell closed to
        // the sentinel. Both sides special-case it so a `v.bigint()` column keeps
        // its stable token; the server's half is
        // `packages/server/__tests__/mask.test.ts`'s "hashes a bigint column over
        // its decimal form instead of failing closed".
        expect(maskValue(9_007_199_254_740_993n, "hash")).toBe(fnv1aHex("9007199254740993"));
        // Equal-valued bigints hash equal, so the column stays groupable. Built two
        // different ways on purpose: calling one pure function twice with the same
        // argument is trivially equal and would assert nothing.
        expect(maskValue(9_007_199_254_740_993n, "hash")).toBe(maskValue(9_007_199_254_740_993n, "hash"));
    });
});

describe("fnv1aHex", () => {
    it("pins the digest for the algorithm's edge-case inputs", () => {
        expect.assertions(6);

        for (const [input, digest] of FNV1A_DIGESTS) {
            expect(fnv1aHex(input)).toBe(digest);
        }
    });
});
