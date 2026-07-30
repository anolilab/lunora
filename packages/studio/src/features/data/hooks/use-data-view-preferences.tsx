import { useState } from "react";

import type { MaskStrategy } from "../../../lib/admin";
import { usePersistedValue } from "../../../lib/browser-storage";
import type { MaskView } from "../../../lib/mask-preview";
import { maskColumnsForTable, mergeSensitiveColumns } from "../../../lib/mask-preview";
import type { TableRow } from "../data-browser-grid";
import useMaskPolicies from "./use-mask-policies";

/**
 * Where a browser remembers its per-table pins. The name is load-bearing — it is
 * live in operators' localStorage, so renaming it silently discards every pin
 * they have set. Pinned by a test.
 */
const PINNED_COLUMNS_KEY = "lunora-studio-pinned-columns";

/** Everything {@link useDataViewPreferences} hands back, so consumers can thread it as one prop. */
interface DataViewPreferences {
    closeExpandedCell: () => void;
    closeInspect: () => void;
    /** The cell whose full value the expand dialog is showing, if any. */
    expandedCell: null | { column: string; value: unknown };
    /** The row whose document the detail drawer is showing, if any. */
    inspecting: TableRow | null;
    /** The active table's masked columns (column → strategy). */
    maskColumns: ReadonlyMap<string, MaskStrategy>;
    maskOn: boolean;
    /** The threaded view the grid/JSON/transposed renderers read. */
    maskView: MaskView;
    onExpandCell: (column: string, value: unknown) => void;
    onInspect: (row: TableRow | null) => void;
    onToggleMask: () => void;
    onTogglePin: (column: string) => void;
    onToggleTranspose: () => void;
    pinnedColumns: ReadonlySet<string>;
    transposed: boolean;
}

/**
 * How the operator is currently LOOKING at the loaded table: which columns are
 * pinned, whether masking is on, whether rows are transposed, and which row or
 * cell is open for inspection.
 *
 * One hook because these are all view preferences over the same table and none of
 * them touches the fetch, the writes, or the pagination — they were four
 * independent `useState` clusters interleaved through the component, which is
 * what made it hard to see where the data flow ended and the UI state began.
 */
const useDataViewPreferences = ({
    columns,
    initialPins,
    selectedTable,
}: {
    readonly columns: ReadonlyArray<string>;
    /** Comma-separated pins from the URL, used to seed a table this browser has never pinned. */
    readonly initialPins?: string;
    readonly selectedTable: null | string;
}): DataViewPreferences => {
    const [pinsByTable, setPinsByTable] = usePersistedValue<Record<string, string[]>>(PINNED_COLUMNS_KEY, {});
    // `selectedTable` is null before a table is chosen; key on "" so the lookup
    // is total and no pins are ever attributed to the wrong table.
    const pinKey = selectedTable ?? "";
    // STORAGE wins, with the URL as the seed for a table nobody has pinned on
    // this browser yet. The precedence was the other way round, which made every
    // pin/unpin a no-op for the rest of the session whenever `?pins=` was
    // present — the toggle wrote to storage that was never read again.
    const stored = pinsByTable[pinKey];
    const pinnedColumns = stored === undefined ? new Set((initialPins ?? "").split(",").filter((name) => name !== "")) : new Set(stored);

    const onTogglePin = (columnId: string): void => {
        setPinsByTable((current) => {
            // Seed from whatever is displayed (storage, else the URL) so the
            // first toggle after arriving on a `?pins=` link edits that set
            // rather than starting from empty.
            const existing: string[] = current[pinKey] ?? [...pinnedColumns];
            const next = existing.includes(columnId) ? existing.filter((id) => id !== columnId) : [...existing, columnId];

            return { ...current, [pinKey]: next };
        });
    };

    const [inspecting, setInspecting] = useState<TableRow | null>(null);
    const closeInspect = (): void => {
        setInspecting(null);
    };

    // Whether the table view is transposed (fields as rows, records as columns) —
    // pure view state for reading wide tables; persists across table switches until
    // the operator toggles it back.
    const [transposed, setTransposed] = useState<boolean>(false);
    const onToggleTranspose = (): void => {
        setTransposed((current) => !current);
    };

    // The deployment's codegen-discovered mask policies (table + column + strategy),
    // loaded once. Drives the "Mask sensitive columns" preview: a render-only
    // redaction of what a `.use(mask(...))` caller would see, plus the per-column
    // "masked" header chips. The operator keeps full DB access — this is a preview,

    const maskPolicies = useMaskPolicies();
    // Default the preview ON so plaintext secrets are hidden out of the box (the
    // operator reveals them by toggling). The toggle is only rendered when the
    // active table actually has sensitive columns, so an ordinary table is
    // unaffected; when it does, the safe-by-default state is masked.
    const [maskOn, setMaskOn] = useState<boolean>(true);
    const onToggleMask = (): void => {
        setMaskOn((current) => !current);
    };

    // The active table's masked columns (column → strategy). Explicit codegen
    // policies (`.use(mask(...))`) are layered with a name-heuristic fallback so a
    // plaintext `password` / `api_key` / `token` column with no declared policy is
    // still masked by default (as `"redact"`). Explicit policies always win.
    const explicitMaskColumns = maskColumnsForTable(maskPolicies, selectedTable ?? "");
    const maskColumns = mergeSensitiveColumns(explicitMaskColumns, columns);

    // The threaded view the grid/JSON/transposed renderers read. The chips show
    // whenever a column is covered; cell values are only rewritten when the toggle
    // is on.
    const maskView = { columns: maskColumns, enabled: maskOn };

    // The cell whose full value the expand dialog is showing, if any. Opened from
    // the per-cell expand affordance; pure view state like `inspecting`.
    const [expandedCell, setExpandedCell] = useState<null | { column: string; value: unknown }>(null);
    const onExpandCell = (column: string, value: unknown): void => {
        setExpandedCell({ column, value });
    };
    const closeExpandedCell = (): void => {
        setExpandedCell(null);
    };

    return {
        closeExpandedCell,
        closeInspect,
        expandedCell,
        inspecting,
        maskColumns,
        maskOn,
        maskView,
        onExpandCell,
        onInspect: setInspecting,
        onToggleMask,
        onTogglePin,
        onToggleTranspose,
        pinnedColumns,
        transposed,
    };
};

export type { DataViewPreferences };
export { useDataViewPreferences };
