import { useState } from "react";

import type { TableRow } from "../data-browser-grid";

/** Which overlay is open over the grid, if any. */
interface RowInspection {
    readonly closeExpandedCell: () => void;
    readonly closeInspect: () => void;
    /** The cell whose full value the expand dialog is showing, if any. */
    readonly expandedCell: null | { column: string; value: unknown };
    /** The row whose document the detail drawer is showing, if any. */
    readonly inspecting: TableRow | null;
    readonly onExpandCell: (column: string, value: unknown) => void;
    readonly onInspect: (row: TableRow | null) => void;
}

/**
 * Which overlay the operator has open over the grid: a row's full document in the
 * detail drawer, or one cell's full value in the expand dialog.
 *
 * Separate from `useDataViewPreferences` because an open drawer is not a view
 * preference — it is transient, it does not survive a table switch, and it is read
 * by an entirely different consumer. The two hooks' fields were used by perfectly
 * disjoint sets of code, which is the tell that they were two concerns in one
 * bucket.
 */
const useRowInspection = (): RowInspection => {
    // The row whose full document the detail drawer is showing. Pure view state —
    // kept out of the data hook since it touches no fetch logic.
    const [inspecting, setInspecting] = useState<TableRow | null>(null);
    const closeInspect = (): void => {
        setInspecting(null);
    };

    // The cell whose full value the expand dialog is showing, if any. Opened from
    // the per-cell expand affordance; pure view state like `inspecting`.
    const [expandedCell, setExpandedCell] = useState<null | { column: string; value: unknown }>(null);
    const onExpandCell = (column: string, value: unknown): void => {
        setExpandedCell({ column, value });
    };
    const closeExpandedCell = (): void => {
        setExpandedCell(null);
    };

    return { closeExpandedCell, closeInspect, expandedCell, inspecting, onExpandCell, onInspect: setInspecting };
};

export type { RowInspection };
export { useRowInspection };
