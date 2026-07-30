import type { ReactElement } from "react";

import SqlResultChart from "../../components/result-chart";
import { ShardInput } from "../../components/shard-input";
import { Alert } from "../../components/ui/alert";
import { useT } from "../../i18n/i18n-context";
import type { AssistantChartConfig, SqlConsoleResult } from "../../lib/admin";
import { ExportMenu } from "../data/grid-features";
import type { SqlAssistant } from "./hooks/use-sql-assistant";
import { SqlResultTable } from "./sql-result-table";
import type { ResultTab } from "./sql-tabs";

/** One result-pane tab's classes, selected or not. */
const tabClass = (selected: boolean): string =>
    `border-b-2 px-3 py-2 text-sm outline-none transition-colors ${selected ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;

/**
 * The results pane: the Results / Chart / Explain tab bar with the Run, Format,
 * export, split and shard controls, and whichever of the three views is showing.
 *
 * Owns no state — `pane` and the run/format handlers come from the panel, so the
 * pane can be rendered stacked or side-by-side purely by its `className`.
 */
const SqlResultsPane = ({
    assistant,
    chart,
    className,
    error,
    onFormat,
    onInferChart,
    onRun,
    onShardKeyChange,
    onShowChart,
    onShowExplain,
    onShowResults,
    onToggleSplit,
    pane,
    result,
    running,
    shardKey,
    splitView,
}: {
    readonly assistant: SqlAssistant;
    /** Model-inferred axes for this result, or undefined for the manual chart. */
    readonly chart?: AssistantChartConfig;
    /** Layout classes from the panel, which owns the stacked/split decision. */
    readonly className: string;
    readonly error: null | string;
    readonly onFormat: () => void;
    readonly onInferChart: () => void;
    readonly onRun: () => void;
    readonly onShardKeyChange: (shardKey: string) => void;
    readonly onShowChart: () => void;
    readonly onShowExplain: () => void;
    readonly onShowResults: () => void;
    readonly onToggleSplit: () => void;
    readonly pane: ResultTab;
    readonly result: null | SqlConsoleResult;
    readonly running: boolean;
    readonly shardKey: string;
    readonly splitView: boolean;
}): ReactElement => {
    const t = useT();

    return (
        <div className={className}>
            <div className="flex shrink-0 items-center gap-2 border-b border-border pe-2">
                <button className={tabClass(pane === "results")} data-testid="sql-tab-results" onClick={onShowResults} type="button">
                    {t("Results")}
                </button>
                <button className={tabClass(pane === "chart")} data-testid="sql-tab-chart" onClick={onShowChart} type="button">
                    {t("Chart")}
                </button>
                {/* Chart inference, hidden without an AI binding. */}
                {!assistant.unavailable && pane === "chart" && result !== null && (
                    <button
                        className={tabClass(false)}
                        data-testid="sql-infer-chart"
                        disabled={assistant.pending("chart")}
                        onClick={onInferChart}
                        type="button"
                    >
                        {assistant.pending("chart") ? t("Thinking…") : t("Suggest chart")}
                    </button>
                )}
                <button className={tabClass(pane === "explain")} data-testid="sql-tab-explain" onClick={onShowExplain} type="button">
                    {t("Explain")}
                </button>
                <div className="ms-auto flex items-center gap-2">
                    <button
                        aria-label={t("Split editor and results")}
                        aria-pressed={splitView}
                        className={`inline-flex items-center rounded-md border border-border px-2 py-1.5 outline-none transition-colors hover:bg-accent focus-visible:bg-accent ${splitView ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                        data-testid="sql-split-toggle"
                        onClick={onToggleSplit}
                        title={t("Split editor and results")}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="size-4"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.7}
                            viewBox="0 0 24 24"
                        >
                            <rect height="16" rx="2" width="18" x="3" y="4" />
                            <path d="M12 4v16" />
                        </svg>
                    </button>
                    {result !== null && result.columns.length > 0 && <ExportMenu columns={result.columns} name="query-result" rows={result.rows} />}
                    <button
                        className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
                        data-testid="sql-format"
                        disabled={running}
                        onClick={onFormat}
                        type="button"
                    >
                        {t("Format")}
                    </button>
                    <ShardInput onChange={onShardKeyChange} testId="sql-shard-input" value={shardKey} />
                    <button
                        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
                        data-testid="sql-run"
                        disabled={running}
                        onClick={onRun}
                        type="button"
                    >
                        {running ? t("Running…") : t("Run")}
                        <kbd className="rounded border border-primary-foreground/30 px-1 font-sans text-[10px]">⌘↵</kbd>
                    </button>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
                {error !== null && (
                    <Alert className="m-3 font-mono text-xs" testId="sql-error" variant="destructive">
                        {error}
                    </Alert>
                )}

                {error === null && result === null && (
                    <p className="p-4 text-sm text-muted-foreground" data-testid="sql-empty">
                        {t("Click Run to execute your query.")}
                    </p>
                )}

                {error === null && result !== null && (
                    <div data-testid="sql-result">
                        {pane === "chart" ? <SqlResultChart axes={chart} result={result} /> : <SqlResultTable result={result} />}
                        <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground" data-testid="sql-count">
                            {result.truncated
                                ? t("Showing the first {max} of {count} rows.", { count: result.rowCount, max: result.rows.length })
                                : t("{count} rows", { count: result.rowCount })}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export { SqlResultsPane };
