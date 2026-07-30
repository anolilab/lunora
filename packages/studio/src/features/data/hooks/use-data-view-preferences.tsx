import { useState } from "react";

import type { MaskStrategy } from "../../../lib/admin";
import { usePersistedValue } from "../../../lib/browser-storage";
import type { MaskView } from "../../../lib/mask-preview";
import { maskColumnsForTable, mergeSensitiveColumns } from "../../../lib/mask-preview";
import useMaskPolicies from "./use-mask-policies";

/**
 * Where a browser remembers its per-table pins. The name is load-bearing — it is
 * live in operators' localStorage, so renaming it silently discards every pin
 * they have set. Pinned by a test.
 */
const PINNED_COLUMNS_KEY = "lunora-studio-pinned-columns";

/** Everything {@link useDataViewPreferences} hands back, so consumers can thread it as one prop. */
interface DataViewPreferences {
    /** The active table's masked columns (column → strategy). */
    readonly maskColumns: ReadonlyMap<string, MaskStrategy>;
    readonly maskOn: boolean;
    /** The threaded view the grid/JSON/transposed renderers read. */
    readonly maskView: MaskView;
    readonly onToggleMask: () => void;
    readonly onTogglePin: (column: string) => void;
    readonly onToggleTranspose: () => void;
    readonly pinnedColumns: ReadonlySet<string>;
    readonly transposed: boolean;
}

/**
 * How the operator is currently LOOKING at the loaded table: which columns are
 * pinned, whether masking is on, and whether rows are transposed.
 *
 * One hook because all three describe how the grid RENDERS the rows it has, and
 * none of them touches the fetch, the writes, or the pagination — they were
 * independent `useState` clusters interleaved through the component, which is what
 * made it hard to see where the data flow ended and the UI state began. Which
 * overlay is open lives in `useRowInspection`, whose consumers are disjoint from
 * these.
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
    // not enforcement.
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

    return { maskColumns, maskOn, maskView, onToggleMask, onTogglePin, onToggleTranspose, pinnedColumns, transposed };
};

export type { DataViewPreferences };
export { useDataViewPreferences };
