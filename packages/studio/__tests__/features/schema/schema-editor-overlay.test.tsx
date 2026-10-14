import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SchemaEditorOverlay } from "../../../src/features/schema/schema-editor-overlay";
import type { SchemaEditTable } from "../../../src/lib/schema-edit";

// The overlay calls `useNavigate()` to jump to the migrations route on a
// destructive edit. Its own tests don't assert on that navigation — they only
// check the local handoff UI — so a no-op `useNavigate` keeps the component
// mounting under a plain `render()` (no `RouterProvider` needed) instead of
// emitting "useRouter must be used inside a <RouterProvider>" on every render.
// The factory preserves the rest of the module.
vi.mock(import("@tanstack/react-router"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/react-router")>();

    return {
        ...actual,
        useNavigate: (): (() => Promise<void>) => () => Promise.resolve(),
    };
});

const TABLE = (name: string): SchemaEditTable => {
    return { columns: [], global: false, indexes: [], name };
};

const TODOS_ONLY: ReadonlyArray<string> = ["todos"];
const NO_TABLES: ReadonlyArray<string> = [];

/** Stub `fetch` with a single JSON response. */
const stubFetch = (status: number, body: unknown): ReturnType<typeof vi.fn> => {
    const mock = vi.fn<() => Promise<{ json: () => Promise<unknown>; ok: boolean; status: number }>>(async () => {
        return { json: async () => body, ok: status >= 200 && status < 300, status };
    });

    vi.stubGlobal("fetch", mock);

    return mock;
};

describe("schemaEditorOverlay", () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("renders the three add controls", () => {
        expect.assertions(3);

        render(<SchemaEditorOverlay onApplied={vi.fn<(tables: ReadonlyArray<SchemaEditTable>) => void>()} tableNames={TODOS_ONLY} />);

        expect(screen.getByTestId("sc-editor-add-table")).toBeDefined();
        expect(screen.getByTestId("sc-editor-add-column")).toBeDefined();
        expect(screen.getByTestId("sc-editor-add-index")).toBeDefined();
    });

    it("disables the column/index controls when there are no tables", () => {
        expect.assertions(2);

        render(<SchemaEditorOverlay onApplied={vi.fn<(tables: ReadonlyArray<SchemaEditTable>) => void>()} tableNames={NO_TABLES} />);

        const column = screen.getByTestId<HTMLButtonElement>("sc-editor-add-column");
        const index = screen.getByTestId<HTMLButtonElement>("sc-editor-add-index");

        expect(column.disabled).toBe(true);
        expect(index.disabled).toBe(true);
    });

    it("posts an addTable edit and hands the new table list back on success", async () => {
        expect.assertions(3);

        const mock = stubFetch(200, { diagnostics: [], ok: true, tables: [TABLE("todos"), TABLE("notes")] });
        const onApplied = vi.fn<(tables: ReadonlyArray<SchemaEditTable>) => void>();

        render(<SchemaEditorOverlay onApplied={onApplied} tableNames={TODOS_ONLY} />);

        fireEvent.click(screen.getByTestId("sc-editor-add-table"));
        fireEvent.change(screen.getByTestId("sc-editor-table-name"), { target: { value: "notes" } });
        fireEvent.click(screen.getByTestId("sc-editor-table-apply"));

        await vi.waitFor(() => {
            if (onApplied.mock.calls.length === 0) {
                throw new Error("onApplied not called yet");
            }
        });

        const [, request] = mock.mock.calls[0] as [string, { body: string }];
        const [appliedTables] = onApplied.mock.calls[0] as [ReadonlyArray<SchemaEditTable>];

        expect(onApplied).toHaveBeenCalledTimes(1);
        expect(JSON.parse(request.body)).toStrictEqual({ kind: "addTable", table: "notes" });
        expect(appliedTables).toStrictEqual([TABLE("todos"), TABLE("notes")]);
    });

    it("surfaces codegen diagnostics on an otherwise-applied edit", async () => {
        expect.assertions(1);

        stubFetch(200, { diagnostics: ["schema.ts(3,1): bad validator"], ok: true, tables: [TABLE("todos")] });

        render(<SchemaEditorOverlay onApplied={vi.fn<(tables: ReadonlyArray<SchemaEditTable>) => void>()} tableNames={TODOS_ONLY} />);

        fireEvent.click(screen.getByTestId("sc-editor-add-table"));
        fireEvent.change(screen.getByTestId("sc-editor-table-name"), { target: { value: "notes" } });
        fireEvent.click(screen.getByTestId("sc-editor-table-apply"));

        const diagnostics = await screen.findByTestId("sc-editor-diagnostics");

        expect(diagnostics.textContent).toContain("bad validator");
    });

    it("shows the migration handoff for a destructive edit and never calls onApplied", async () => {
        expect.assertions(2);

        // The endpoint answers 409 needsMigration for destructive edits; the
        // overlay only ever POSTs additive edits, but the handoff surfaces
        // whatever needsMigration the host returns (plan 024 Item 5).
        stubFetch(409, {
            message: "This edit changes stored data and must go through a migration. Review the migration before applying.",
            needsMigration: true,
        });
        const onApplied = vi.fn<(tables: ReadonlyArray<SchemaEditTable>) => void>();

        render(<SchemaEditorOverlay onApplied={onApplied} tableNames={TODOS_ONLY} />);

        fireEvent.click(screen.getByTestId("sc-editor-add-table"));
        fireEvent.change(screen.getByTestId("sc-editor-table-name"), { target: { value: "notes" } });
        fireEvent.click(screen.getByTestId("sc-editor-table-apply"));

        await screen.findByTestId("sc-editor-needs-migration");

        expect(screen.getByTestId("sc-editor-open-migrations")).toBeDefined();
        expect(onApplied).not.toHaveBeenCalled();
    });

    it("surfaces an error response", async () => {
        expect.assertions(1);

        stubFetch(409, { error: "duplicate-table", ok: false });

        render(<SchemaEditorOverlay onApplied={vi.fn<(tables: ReadonlyArray<SchemaEditTable>) => void>()} tableNames={TODOS_ONLY} />);

        fireEvent.click(screen.getByTestId("sc-editor-add-table"));
        fireEvent.change(screen.getByTestId("sc-editor-table-name"), { target: { value: "todos" } });
        fireEvent.click(screen.getByTestId("sc-editor-table-apply"));

        const error = await screen.findByTestId("sc-editor-error");

        expect(error.textContent).toContain("duplicate-table");
    });

    it("routes a destructive change to the migration handoff without posting (item 5)", () => {
        expect.assertions(3);

        const mock = stubFetch(200, { diagnostics: [], ok: true, tables: [TABLE("todos")] });

        render(<SchemaEditorOverlay onApplied={vi.fn<(tables: ReadonlyArray<SchemaEditTable>) => void>()} tableNames={TODOS_ONLY} />);

        // A rename/drop/type-change never POSTs to the additive endpoint; it
        // surfaces the migration handoff locally and links to Migrations.
        fireEvent.click(screen.getByTestId("sc-editor-destructive"));

        expect(screen.getByTestId("sc-editor-needs-migration")).toBeDefined();
        expect(screen.getByTestId("sc-editor-open-migrations")).toBeDefined();
        expect(mock).not.toHaveBeenCalled();
    });

    it("posts an addOptionalColumn edit with the selected validator", async () => {
        expect.assertions(2);

        const mock = stubFetch(200, { diagnostics: [], ok: true, tables: [TABLE("todos")] });

        render(<SchemaEditorOverlay onApplied={vi.fn<(tables: ReadonlyArray<SchemaEditTable>) => void>()} tableNames={TODOS_ONLY} />);

        fireEvent.click(screen.getByTestId("sc-editor-add-column"));
        fireEvent.change(screen.getByTestId("sc-editor-column-name"), { target: { value: "due" } });
        fireEvent.change(screen.getByTestId("sc-editor-column-type"), { target: { value: "v.number()" } });
        fireEvent.click(screen.getByTestId("sc-editor-column-apply"));

        await vi.waitFor(() => {
            if (mock.mock.calls.length === 0) {
                throw new Error("fetch not called yet");
            }
        });

        const [, request] = mock.mock.calls[0] as [string, { body: string }];

        expect(mock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(request.body)).toStrictEqual({ column: "due", kind: "addOptionalColumn", table: "todos", validator: "v.number()" });
    });

    it("sends v.bigint() for the bigint palette entry — the validator the server allow-lists and `@lunora/values` exports", async () => {
        expect.assertions(2);

        // `v.int64()` is neither exported by `@lunora/values` nor on the
        // server's allow-list, so every bigint column the palette offered came
        // back `400 invalid-validator`.
        const mock = stubFetch(200, { diagnostics: [], ok: true, tables: [TABLE("todos")] });

        render(<SchemaEditorOverlay onApplied={vi.fn<(tables: ReadonlyArray<SchemaEditTable>) => void>()} tableNames={TODOS_ONLY} />);

        fireEvent.click(screen.getByTestId("sc-editor-add-column"));
        fireEvent.change(screen.getByTestId("sc-editor-column-name"), { target: { value: "amount" } });

        const select = screen.getByTestId<HTMLSelectElement>("sc-editor-column-type");
        const bigintOption = [...select.options].find((option) => option.textContent === "bigint");

        expect(bigintOption?.value).toBe("v.bigint()");

        fireEvent.change(select, { target: { value: bigintOption?.value } });
        fireEvent.click(screen.getByTestId("sc-editor-column-apply"));

        await vi.waitFor(() => {
            if (mock.mock.calls.length === 0) {
                throw new Error("fetch not called yet");
            }
        });

        const [, bigintRequest] = mock.mock.calls[0] as [string, { body: string }];

        expect(JSON.parse(bigintRequest.body)).toStrictEqual({ column: "amount", kind: "addOptionalColumn", table: "todos", validator: "v.bigint()" });
    });
});
