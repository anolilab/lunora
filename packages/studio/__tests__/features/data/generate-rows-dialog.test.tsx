import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../../../shared/wire-codec";
import { GenerateRowsDialog } from "../../../src/features/data/generate-rows-dialog";
import type { InsertBatchOutcome } from "../../../src/features/data/hooks/use-generate-rows";
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

const makeInsertRows = (error?: string) =>
    vi.fn<(_rows: ReadonlyArray<Record<string, unknown>>) => Promise<InsertBatchOutcome>>(async (rows) => {
        return { conflicts: 0, error, inserted: error === undefined ? rows.length : 0 };
    });

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

    it("reports the REAL inserted count when every row conflicted, not the requested count (STUDIO-292 M5)", async () => {
        expect.hasAssertions();

        // Every generated row's planned `_id` collided with an existing row —
        // `onInsertRows` (the hook's `insertBatch`) treats this as `error ===
        // undefined` (still success), but NOTHING was actually written.
        const onInsertRows = vi.fn<(_rows: ReadonlyArray<Record<string, unknown>>) => Promise<InsertBatchOutcome>>(async (rows) => {
            return { conflicts: rows.length, error: undefined, inserted: 0 };
        });

        renderDialog({ onInsertRows });

        fireEvent.click(screen.getByTestId("gen-rows-generate"));

        const success = await screen.findByTestId("gen-rows-success");

        // Must never read as if the row landed — that's the exact "reports
        // success when nothing was written" bug.
        expect(success.textContent).not.toContain("Inserted 1 rows successfully");
        expect(success.textContent).toContain("Inserted 0 of 1 rows");
        expect(success.textContent).toContain("1 skipped as id conflicts");
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

    it("marks an FK column whose parent table has no rows", () => {
        expect.assertions(1);

        renderDialog({ columns: FK_COLUMNS, fkPools: {} });

        // The empty pool badge should be visible for the FK column.
        expect(screen.getByTestId("gen-rows-fk-empty-userId").tagName.toLowerCase()).toBe("span");
    });

    it("blocks generation when an FK parent has no rows, and says so instead of claiming the column was skipped", () => {
        expect.assertions(3);

        // The endpoint refuses this request: `seedPlan` links the FK to freshly
        // FABRICATED parent rows that the endpoint then drops, so every inserted
        // child carried a reference to a row nobody inserted — while the dialog
        // reported "Inserted N rows. Skipped FK columns: userId".
        renderDialog({ columns: FK_COLUMNS, fkPools: {} });

        const blocked = screen.getByTestId("gen-rows-blocked");

        expect(blocked.textContent).toContain("userId");
        expect(blocked.textContent).toContain("Seed those tables first");
        expect(screen.getByTestId<HTMLButtonElement>("gen-rows-generate").disabled).toBe(true);
    });

    it("decodes wire-encoded rows so a bigint cell reaches the insert as a bigint", async () => {
        expect.hasAssertions();

        // The endpoint hands back `encodeWire`d rows; `importShard` parses each
        // cell against the declared validator, and `v.bigint().parse(number)`
        // throws — so a JSON-narrowed payload got every row rejected.
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(true, { ok: true, rows: encodeWire([{ amount: 42n, blob: Uint8Array.from([1, 2]).buffer }]) })),
        );

        const onInsertRows = makeInsertRows();

        renderDialog({ onInsertRows });

        fireEvent.click(screen.getByTestId("gen-rows-generate"));

        await waitFor(() => {
            expect(onInsertRows).toHaveBeenCalledTimes(1);
        });

        const [rows] = onInsertRows.mock.calls[0] ?? [];

        expect(rows?.[0]?.["amount"]).toBe(42n);
        expect(rows?.[0]?.["blob"]).toBeInstanceOf(ArrayBuffer);
    });

    it("surfaces the endpoint's fk-parents-empty refusal naming the tables to seed first", async () => {
        expect.hasAssertions();

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => jsonResponse(false, { error: "fk-parents-empty", ok: false, tables: ["users"] })),
        );

        const onInsertRows = makeInsertRows();

        renderDialog({ columns: SIMPLE_COLUMNS, onInsertRows });

        fireEvent.click(screen.getByTestId("gen-rows-generate"));

        await waitFor(() => {
            expect(screen.getByTestId("gen-rows-error").textContent).toContain("no rows to reference in users");
        });

        expect(onInsertRows).not.toHaveBeenCalled();
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
        const onInsertRows = vi.fn<(_rows: ReadonlyArray<Record<string, unknown>>) => Promise<InsertBatchOutcome>>(
            (rows) =>
                new Promise<InsertBatchOutcome>((resolve) => {
                    settle = () => {
                        resolve({ conflicts: 0, error: undefined, inserted: rows.length });
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
        let outcome: InsertBatchOutcome | undefined;

        await act(async () => {
            outcome = await result.current.insertBatch(rows, vi.fn());
        });

        expect(outcome?.error).toBeUndefined();

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

        let outcome: InsertBatchOutcome | undefined;

        await act(async () => {
            outcome = await result.current.insertBatch([{ title: "a" }, { title: "b" }, { title: "c" }], vi.fn());
        });

        expect(outcome?.error).toContain("row 3 (posts): bad title");
    });

    it("treats conflicts alone (no errors) as success, but reports the REAL inserted/conflicts counts — not the requested row count (STUDIO-292 M5)", async () => {
        expect.assertions(3);

        // Every row's planned `_id` collides with an existing one (a re-click
        // with an unchanged seed) — nothing actually lands, but `errors` is
        // empty, so this must still resolve as "success" per the Export/Import
        // panel's semantics.
        const mock = createGenerateRowsClient((reference) => {
            if (reference === ADMIN_FUNCTIONS.importShard) {
                return { conflicts: 2, errors: [], inserted: {} };
            }

            return undefined;
        });

        const { result } = renderHook(() => useGenerateRows(vi.fn()), { wrapper: wrapWithClient(mock) });

        await openAndSettle(result, "posts");

        let outcome: InsertBatchOutcome | undefined;

        await act(async () => {
            outcome = await result.current.insertBatch([{ title: "a" }, { title: "b" }], vi.fn());
        });

        expect(outcome?.error).toBeUndefined();

        // The whole point: a conflict-only batch must report ZERO inserted, not
        // the two requested rows — "success" and "everything landed" are NOT
        // the same claim.
        expect(outcome?.inserted).toBe(0);
        expect(outcome?.conflicts).toBe(2);
    });

    it("reports the real inserted count alongside conflicts when a batch partially collides", async () => {
        expect.assertions(2);

        const mock = createGenerateRowsClient((reference) => {
            if (reference === ADMIN_FUNCTIONS.importShard) {
                return { conflicts: 3, errors: [], inserted: { posts: 197 } };
            }

            return undefined;
        });

        const { result } = renderHook(() => useGenerateRows(vi.fn()), { wrapper: wrapWithClient(mock) });

        await openAndSettle(result, "posts");

        let outcome: InsertBatchOutcome | undefined;

        await act(async () => {
            outcome = await result.current.insertBatch(
                Array.from({ length: 200 }, () => {
                    return { title: "row" };
                }),
                vi.fn(),
            );
        });

        expect(outcome?.inserted).toBe(197);
        expect(outcome?.conflicts).toBe(3);
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

        let outcome: InsertBatchOutcome | undefined;

        await act(async () => {
            outcome = await result.current.insertBatch([{ title: "a" }], vi.fn());
        });

        expect(outcome?.error).toBe("network down");
    });
});
