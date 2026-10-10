import type { ReactElement } from "react";

import { TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { COLUMN_LABEL } from "./section-styles";

/**
 * The header row every data table in the studio draws.
 *
 * Seven sections had written the same `TableHeader > TableRow > TableHead` nest
 * by hand — 37 cells across 37 lines, each repeating `className={COLUMN_LABEL}`
 * — which is one styling decision copied thirty-seven times. Restyling a column
 * label meant a seven-file edit, and a cell that forgot the class simply looked
 * different from its neighbours with nothing to catch it.
 *
 * A label alone is the common case; `srOnly` covers the one column that exists
 * for assistive tech only (the actions column, whose visible affordance is the
 * button in each row).
 */
export type ColumnLabel = string | { label: string; srOnly: true };

/** Render one data table's header from its column labels. */
export const ColumnHeader = ({ labels }: { labels: ReadonlyArray<ColumnLabel> }): ReactElement => (
    <TableHeader>
        <TableRow>
            {labels.map((entry) => {
                const label = typeof entry === "string" ? entry : entry.label;
                const srOnly = typeof entry !== "string";

                return (
                    <TableHead className={srOnly ? cn(COLUMN_LABEL, "sr-only") : COLUMN_LABEL} key={label}>
                        {label}
                    </TableHead>
                );
            })}
        </TableRow>
    </TableHeader>
);
