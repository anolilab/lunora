import type { CSSProperties, ReactElement } from "react";
import { useMemo } from "react";

import { useT } from "../i18n/i18n-context";
import type { SqlConsoleResult } from "../lib/admin";
import { formatCell } from "../lib/internal";

/** Most bars rendered, so a large result stays readable (and the DOM bounded). */
const MAX_BARS = 50;

/**
 * Choose the columns to chart: the first column whose values are all numbers is
 * the bar value; the first other column is the label (falling back to the row
 * index). Returns `null` for `value` when nothing numeric is present.
 */
const pickColumns = (result: SqlConsoleResult): { label: null | string; value: null | string } => {
    const value = result.columns.find((column) => result.rows.length > 0 && result.rows.every((row) => typeof row[column] === "number")) ?? null;
    const label = result.columns.find((column) => column !== value) ?? null;

    return { label, value };
};

/** One labelled bar, scaled to the column's max. Its width style is per-bar, so it's built as a const (not an inline literal). */
const Bar = ({ label, max, value }: { readonly label: string; readonly max: number; readonly value: number }): ReactElement => {
    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- per-bar width is intrinsically dynamic (scales to the column max)
    const width: CSSProperties = { width: `${Math.max(0, (value / max) * 100).toString()}%` };

    return (
        <div className="flex items-center gap-2 text-xs" data-testid="sql-chart-bar">
            <span className="w-36 shrink-0 truncate text-end text-muted-foreground" title={label}>
                {label}
            </span>
            <div className="flex h-5 min-w-0 flex-1 items-center">
                <div className="h-full rounded-sm bg-primary/70" style={width} />
                <span className="ms-1.5 shrink-0 tabular-nums text-muted-foreground">{value}</span>
            </div>
        </div>
    );
};

/**
 * A lightweight bar chart of a SQL result — the first numeric column plotted
 * against the first label column (or the row index). CSS bars rather than a chart
 * dependency, matching the studio's hand-rolled sparkline. Capped at {@link MAX_BARS}
 * rows; shows a hint when the result has no numeric column to plot.
 */
const SqlResultChart = ({ result }: { readonly result: SqlConsoleResult }): ReactElement => {
    const t = useT();
    const { label, value } = useMemo(() => pickColumns(result), [result]);

    if (value === null) {
        return (
            <p className="p-4 text-sm text-muted-foreground" data-testid="sql-chart-empty">
                {t("No numeric column to chart.")}
            </p>
        );
    }

    const rows = result.rows.slice(0, MAX_BARS);
    const max = Math.max(1, ...rows.map((row) => Number(row[value]) || 0));

    return (
        <div className="flex flex-col gap-1 p-3" data-testid="sql-chart">
            {rows.map((row, index) => (
                <Bar
                    // eslint-disable-next-line react-x/no-array-index-key -- a raw SQL result row has no stable identity; position is the only key
                    key={index}
                    label={label === null ? `#${(index + 1).toString()}` : formatCell(row[label])}
                    max={max}
                    value={Number(row[value]) || 0}
                />
            ))}
        </div>
    );
};

export default SqlResultChart;
