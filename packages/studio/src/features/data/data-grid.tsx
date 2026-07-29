import type { ReactElement, ReactNode } from "react";

import { useT } from "../../i18n/i18n-context";
import { formatCell } from "../../lib/internal";
import { highlightSegments } from "./highlight-segments";

/**
 * One grid cell's value, rendered Outerbase/Supabase-style: a `null`/`undefined`
 * shows a muted italic `NULL` (so an absent value reads differently from an empty
 * string), everything else goes through {@link formatCell}. The raw text is set as
 * the cell `title` so a truncated value is recoverable on hover.
 */
const CellValue = ({ highlight, value }: { readonly highlight?: string; readonly value: unknown }): ReactElement => {
    if (value === null || value === undefined) {
        return <span className="text-muted-foreground/50 italic">NULL</span>;
    }

    const text = formatCell(value);

    if (highlight === undefined || highlight === "") {
        return <span title={text}>{text}</span>;
    }

    return (
        <span title={text}>
            {highlightSegments(text, highlight).map((segment) => (
                <mark className={segment.match ? "rounded-sm bg-warning/40 text-foreground" : "bg-transparent text-inherit"} key={segment.offset}>
                    {segment.text}
                </mark>
            ))}
        </span>
    );
};

/**
 * The loaded page flipped on its diagonal: each column becomes a row (the field
 * name in a sticky leading column) and each record becomes a column. The readable
 * shape for a wide table with only a handful of rows, where the normal grid would
 * scroll horizontally forever. Read-only — a view transform over the same rows.
 */
const TransposedTable = ({
    columns,
    rows,
}: {
    readonly columns: ReadonlyArray<string>;
    readonly rows: ReadonlyArray<Record<string, unknown>>;
}): ReactElement => {
    const t = useT();

    return (
        <div className="min-h-0 flex-1 overflow-auto" data-testid="db-transposed">
            <table className="border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-muted">
                    <tr>
                        <th className="border-b border-e border-border px-3 py-1.5 text-start font-mono text-[11px] tracking-wide uppercase text-muted-foreground">
                            {t("Field")}
                        </th>
                        {rows.map((_, index) => (
                            <th
                                className="border-b border-border px-3 py-1.5 text-start font-mono text-[11px] tracking-wide uppercase tabular-nums text-muted-foreground"
                                /* eslint-disable react-x/no-array-index-key -- raw row has no stable id; position is the only key */
                                // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- these rows are positional — the index IS the identity, because the underlying record carries no domain id (see the matching eslint-disable)
                                key={index}
                                /* eslint-enable react-x/no-array-index-key */
                            >
                                {t("Row {n}", { n: index + 1 })}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {columns.map((column) => (
                        <tr className="hover:bg-muted/40" key={column}>
                            <th className="border-b border-e border-border px-3 py-1.5 text-start font-mono font-medium whitespace-nowrap" scope="row">
                                {column}
                            </th>
                            {rows.map((row, index) => (
                                <td
                                    className="max-w-md truncate border-b border-border px-3 py-1.5 font-mono"
                                    /* eslint-disable react-x/no-array-index-key -- raw row has no stable id; position is the only key */
                                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- raw row has no stable id; position is the only key
                                    key={index}
                                    /* eslint-enable react-x/no-array-index-key */
                                >
                                    <CellValue value={row[column]} />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

/**
 * Container that frames a data grid (the table is passed as `children`). The
 * `"card"` layout (the default) is a bordered, rounded, horizontally-scrolling
 * card — the look Supabase's Table Editor uses, instead of a bare table bleeding
 * into the page. The `"fill"` layout instead grows to fill its flex parent
 * (`flex-1 min-h-0`) and lets the child own scrolling, so a full-height table
 * editor's grid stretches to the bottom of the panel rather than being pinned to
 * a fixed height.
 */
const GridContainer = ({
    children,
    layout = "card",
    testId,
}: {
    readonly children: ReactNode;
    readonly layout?: "card" | "fill";
    readonly testId?: string;
}): ReactElement => (
    <div
        className={layout === "fill" ? "flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border" : "overflow-x-auto border border-border bg-card"}
        data-testid={testId}
    >
        {children}
    </div>
);

export { CellValue, GridContainer, TransposedTable };
