import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GenerateRowsDialog } from "../../../src/features/data/generate-rows-dialog";
import type { ColumnMeta } from "../../../src/lib/admin";

// ── Fixture column definitions ───────────────────────────────────────────────

const SIMPLE_COLUMNS: ColumnMeta[] = [
    { name: "_id", optional: false, pk: true, type: "id" },
    { name: "title", optional: false, type: "string" },
    { name: "count", optional: false, type: "number" },
    { name: "active", optional: true, type: "boolean" },
];

const FK_COLUMNS: ColumnMeta[] = [
    { name: "_id", optional: false, pk: true, type: "id" },
    { name: "userId", optional: false, ref: "users", type: "id" },
    { name: "title", optional: false, type: "string" },
];

// ── fetch stub ───────────────────────────────────────────────────────────────

/** A minimal `Response`-like the seed-data client reads (`.ok` + `.json()`). */
const jsonResponse = (ok: boolean, payload: unknown): { json: () => Promise<unknown>; ok: boolean; status: number } => {
    return {
        json: async () => payload,
        ok,
        status: ok ? 200 : 500,
    };
};

/**
 * Stub `fetch` so the dialog's call to the local seed endpoint resolves with a
 * fixed row set. Generation now happens server-side; the dialog only fetches and
 * forwards the rows, so a single canned response drives every generate test.
 */
const stubSeedFetch = (rows: ReadonlyArray<Record<string, unknown>> = [{ title: "seeded" }]): void => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(true, { ok: true, rows })),
    );
};

// ── Render helpers ───────────────────────────────────────────────────────────

const makeInsertRows = (returnValue?: string) => vi.fn<(_rows: ReadonlyArray<Record<string, unknown>>) => Promise<string | undefined>>(async () => returnValue);

const renderDialog = ({ columns = SIMPLE_COLUMNS, fkPools = {}, onClose = vi.fn<() => void>(), onInsertRows = makeInsertRows(), table = "posts" } = {}) =>
    render(<GenerateRowsDialog columns={columns} fkPools={fkPools} onClose={onClose} onInsertRows={onInsertRows} table={table} />);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("generateRowsDialog", () => {
    beforeEach(() => {
        stubSeedFetch();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("renders the title and description", () => {
        expect.assertions(2);

        renderDialog();

        expect(screen.getByTestId("gen-rows-title").textContent).toContain("Generate dummy rows");
        expect(screen.getByTestId("gen-rows-desc").tagName.toLowerCase()).toBe("p");
    });

    it("renders the panel element", () => {
        expect.assertions(1);

        renderDialog();

        expect(screen.getByTestId("gen-rows-panel").tagName.toLowerCase()).toBe("div");
    });

    it("shows the count input with a default of 10", () => {
        expect.assertions(1);

        renderDialog();

        const input = screen.getByTestId<HTMLInputElement>("gen-rows-count");

        expect(input.value).toBe("10");
    });

    it("renders editable columns (non-pk) in the column list", () => {
        expect.assertions(3);

        renderDialog();

        const list = screen.getByTestId("gen-rows-columns");

        // _id (pk) must NOT appear; title, count, active must appear.
        expect(list.textContent).not.toContain("_id");
        expect(list.textContent).toContain("title");
        expect(list.textContent).toContain("count");
    });

    it("calls onClose when cancel is clicked", () => {
        expect.assertions(1);

        const onClose = vi.fn<() => void>();

        renderDialog({ onClose });

        fireEvent.click(screen.getByTestId("gen-rows-cancel"));

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("posts to the seed endpoint and forwards the rows to onInsertRows", async () => {
        expect.hasAssertions();

        const onInsertRows = makeInsertRows();

        renderDialog({ onInsertRows });

        fireEvent.click(screen.getByTestId("gen-rows-generate"));

        await waitFor(() => {
            expect(onInsertRows).toHaveBeenCalledTimes(1);
        });

        expect(globalThis.fetch).toHaveBeenCalledWith("/__lunora/seed", expect.objectContaining({ method: "POST" }));
    });

    it("shows success message after successful insert", async () => {
        expect.hasAssertions();

        renderDialog({ onInsertRows: makeInsertRows() });

        fireEvent.click(screen.getByTestId("gen-rows-generate"));

        await waitFor(() => {
            expect(screen.getByTestId("gen-rows-success").tagName.toLowerCase()).toBe("p");
        });
    });

    it("shows error message when onInsertRows returns an error string", async () => {
        expect.hasAssertions();

        const onInsertRows = makeInsertRows("Insert failed");

        renderDialog({ onInsertRows });

        fireEvent.click(screen.getByTestId("gen-rows-generate"));

        await waitFor(() => {
            expect(screen.getByTestId("gen-rows-error").textContent).toContain("Insert failed");
        });
    });

    it("shows error message when the seed endpoint fails", async () => {
        expect.hasAssertions();

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(false, { error: "schema-not-found", ok: false })),
        );

        const onInsertRows = makeInsertRows();

        renderDialog({ onInsertRows });

        fireEvent.click(screen.getByTestId("gen-rows-generate"));

        await waitFor(() => {
            expect(screen.getByTestId("gen-rows-error").textContent).toContain("schema-not-found");
        });

        expect(onInsertRows).not.toHaveBeenCalled();
    });

    it("marks FK column with empty pool as skippable", () => {
        expect.assertions(1);

        renderDialog({ columns: FK_COLUMNS, fkPools: {} });

        // The empty pool badge should be visible for the FK column.
        expect(screen.getByTestId("gen-rows-fk-empty-userId").tagName.toLowerCase()).toBe("span");
    });

    it("marks FK column with non-empty pool as ok", () => {
        expect.assertions(1);

        renderDialog({ columns: FK_COLUMNS, fkPools: { users: ["u1", "u2"] } });

        expect(screen.getByTestId("gen-rows-fk-ok-userId").tagName.toLowerCase()).toBe("span");
    });

    it("disables generate button while inserting", async () => {
        expect.hasAssertions();

        // Use a slow insert to observe the disabled state.
        let settle!: () => void;
        const onInsertRows = vi.fn<(_rows: ReadonlyArray<Record<string, unknown>>) => Promise<string | undefined>>(
            () =>
                new Promise<undefined>((resolve) => {
                    settle = () => {
                        resolve(undefined);
                    };
                }),
        );

        renderDialog({ onInsertRows });

        fireEvent.click(screen.getByTestId("gen-rows-generate"));

        const btn = await screen.findByTestId<HTMLButtonElement>("gen-rows-generate");

        await waitFor(() => {
            expect(btn.disabled).toBe(true);
        });

        // Settle to avoid dangling promise.
        settle();
    });
});
