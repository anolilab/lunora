import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GenerateRowsDialog } from "../../../src/features/data/generate-rows-dialog";
import { useGenerateRows } from "../../../src/features/data/hooks/use-generate-rows";
import type { ColumnMeta } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

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

// ── `useGenerateRows`'s `insertBatch` — the bulk `importShard` route (STUDIO-292) ──
// Unlike the dialog tests above (which stub `onInsertRows` as a prop and never
// reach the hook), these mount the REAL hook against a mock `LunoraClient` so
// the actual `client.query` traffic `insertBatch` issues is observable.

const DESCRIBE_TABLE_COLUMNS: ColumnMeta[] = [
    { name: "_id", optional: false, pk: true, type: "id" },
    { name: "title", optional: false, type: "string" },
];

/** A mock client that serves `describeTable` (so `openDialog` can complete) and delegates everything else to `queryImpl`. */
const createGenerateRowsClient = (queryImpl: (reference: string, args: unknown, options: unknown) => unknown): MockClientHooks =>
    createMockClient({
        query: (reference, args, options): unknown => {
            if (reference === ADMIN_FUNCTIONS.describeTable) {
                return { columns: DESCRIBE_TABLE_COLUMNS };
            }

            return queryImpl(reference, args, options);
        },
    });

const wrapWithClient =
    (mock: MockClientHooks) =>
    ({ children }: { children: ReactNode }): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;

/** Open the dialog against `table` and wait for `openDialogAsync`'s `describeTable` round trip to settle. */
const openAndSettle = async (result: { current: ReturnType<typeof useGenerateRows> }, table: string): Promise<void> => {
    await act(async () => {
        result.current.openDialog(table, "");
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
};

describe("useGenerateRows — insertBatch routes through the bulk importShard RPC (STUDIO-292)", () => {
    it("issues exactly ONE importShard call carrying all 200 rows, not 200 writeRow calls", async () => {
        expect.assertions(3);

        const mock = createGenerateRowsClient((reference) => {
            if (reference === ADMIN_FUNCTIONS.importShard) {
                return { conflicts: 0, errors: [], inserted: { posts: 200 } };
            }

            return undefined;
        });

        const { result } = renderHook(() => useGenerateRows(vi.fn()), { wrapper: wrapWithClient(mock) });

        await openAndSettle(result, "posts");

        const rows = Array.from({ length: 200 }, (_, index) => {
            return { _id: `id-${index.toString()}`, title: `row ${index.toString()}` };
        });
        let outcome: string | undefined;

        await act(async () => {
            outcome = await result.current.insertBatch(rows, vi.fn());
        });

        expect(outcome).toBeUndefined();

        const importCalls = mock.query.mock.calls.filter((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.importShard);
        const writeRowCalls = mock.query.mock.calls.filter((call) => (call[0] as { __lunoraRef: string }).__lunoraRef === ADMIN_FUNCTIONS.writeRow);

        expect(importCalls).toHaveLength(1);
        expect(writeRowCalls).toHaveLength(0);
    });

    it("surfaces a string naming the failing row's line and table when errors is non-empty", async () => {
        expect.assertions(1);

        const mock = createGenerateRowsClient((reference) => {
            if (reference === ADMIN_FUNCTIONS.importShard) {
                return {
                    conflicts: 0,
                    errors: [{ code: "VALIDATION_ERROR", line: 3, message: "bad title", table: "posts" }],
                    inserted: { posts: 2 },
                };
            }

            return undefined;
        });

        const { result } = renderHook(() => useGenerateRows(vi.fn()), { wrapper: wrapWithClient(mock) });

        await openAndSettle(result, "posts");

        let outcome: string | undefined;

        await act(async () => {
            outcome = await result.current.insertBatch([{ title: "a" }, { title: "b" }, { title: "c" }], vi.fn());
        });

        expect(outcome).toContain("row 3 (posts): bad title");
    });

    it("treats conflicts alone (no errors) as success", async () => {
        expect.assertions(1);

        const mock = createGenerateRowsClient((reference) => {
            if (reference === ADMIN_FUNCTIONS.importShard) {
                return { conflicts: 2, errors: [], inserted: { posts: 0 } };
            }

            return undefined;
        });

        const { result } = renderHook(() => useGenerateRows(vi.fn()), { wrapper: wrapWithClient(mock) });

        await openAndSettle(result, "posts");

        let outcome: string | undefined;

        await act(async () => {
            outcome = await result.current.insertBatch([{ title: "a" }, { title: "b" }], vi.fn());
        });

        expect(outcome).toBeUndefined();
    });

    it("still returns the error message when the transport throws (today's catch path)", async () => {
        expect.assertions(1);

        const mock = createGenerateRowsClient((reference) => {
            if (reference === ADMIN_FUNCTIONS.importShard) {
                throw new Error("network down");
            }

            return undefined;
        });

        const { result } = renderHook(() => useGenerateRows(vi.fn()), { wrapper: wrapWithClient(mock) });

        await openAndSettle(result, "posts");

        let outcome: string | undefined;

        await act(async () => {
            outcome = await result.current.insertBatch([{ title: "a" }], vi.fn());
        });

        expect(outcome).toBe("network down");
    });
});
