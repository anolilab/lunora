import type { ReactElement } from "react";

import SqlResultChart from "../../components/result-chart";
import { ShardInput } from "../../components/shard-input";
import { Alert } from "../../components/ui/alert";
import type { AssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import type { AssistantChartConfig, SqlConsoleResult } from "../../lib/admin";
import { ExportMenu } from "../data/grid-features";
import type { ScriptRun } from "./hooks/use-sql-editor-tabs";
import SqlResultTable from "./sql-result-table";
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
    rpc,
    chart,
    className,
    error,
    onFormat,
    onInferChart,
    onRun,
    onSelectStatement,
    onShardKeyChange,
    onShowChart,
    onShowExplain,
    onShowResults,
    chatOpen,
    onDebugError,
    onExplainPlan,
    onExplainSql,
    onToggleChat,
    onToggleSplit,
    pane,
    result,
    running,
    script,
    shardKey,
    splitView,
}: {
    /** Model-inferred axes for this result, or undefined for the manual chart. */
    readonly chart?: AssistantChartConfig;
    /** Whether the assistant panel is showing. */
    readonly chatOpen: boolean;
    /** Layout classes from the panel, which owns the stacked/split decision. */
    readonly className: string;
    readonly error: null | string;
    /** Open the assistant on the failing statement. Omitted when there is nothing to debug. */
    readonly onDebugError?: () => void;
    /** Ask the assistant to read the query plan currently shown. Omitted when there is no plan or no rpc. */
    readonly onExplainPlan?: () => void;
    /** Ask the assistant to explain the draft in the editor. Omitted when there is nothing to explain or no rpc. */
    readonly onExplainSql?: () => void;
    readonly onFormat: () => void;
    readonly onInferChart: () => void;
    readonly onRun: () => void;
    /** Show statement `index` of an already-run script. */
    readonly onSelectStatement: (index: number) => void;
    readonly onShardKeyChange: (shardKey: string) => void;
    readonly onShowChart: () => void;
    readonly onShowExplain: () => void;
    readonly onShowResults: () => void;
    /** Absent when no assistant is mounted above this tree — the toggle is then not rendered. */
    readonly onToggleChat?: () => void;
    readonly onToggleSplit: () => void;
    readonly pane: ResultTab;
    readonly result: null | SqlConsoleResult;
    readonly rpc: AssistantRpc;
    readonly running: boolean;
    /** Every statement of a multi-statement script; absent for a single one. */
    readonly script?: { readonly runs: ReadonlyArray<ScriptRun>; readonly selected: number };
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
                {!rpc.unavailable && pane === "chart" && result !== null && (
                    <button className={tabClass(false)} data-testid="sql-infer-chart" disabled={rpc.pending("chart")} onClick={onInferChart} type="button">
                        {rpc.pending("chart") ? t("Thinking…") : t("Suggest chart")}
                    </button>
                )}
                <button className={tabClass(pane === "explain")} data-testid="sql-tab-explain" onClick={onShowExplain} type="button">
                    {t("Explain")}
                </button>
                <div className="ms-auto flex items-center gap-2">
                    {/*
                     * The assistant panel's only affordance. Hidden without an `AI`
                     * binding, like every other assistant control — and a toggle
                     * rather than an always-open bar, which read as part of the
                     * results toolbar and took vertical space whether or not
                     * anyone was talking to it.
                     */}
                    {onToggleChat !== undefined && (
                        <button
                            aria-label={t("Ask about your data")}
                            aria-pressed={chatOpen}
                            className={`inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 outline-none transition-colors hover:bg-accent focus-visible:bg-accent ${chatOpen ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                            data-testid="sql-chat-toggle"
                            onClick={onToggleChat}
                            title={t("Ask about your data")}
                            type="button"
                        >
                            <svg
                                aria-hidden="true"
                                className="size-4"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.6}
                                viewBox="0 0 24 24"
                            >
                                <path d="M21 12a8 8 0 0 1-8 8H7l-4 3 1.2-4.2A8 8 0 1 1 21 12Z" />
                            </svg>
                            <span className="text-xs">{t("Assistant")}</span>
                        </button>
                    )}
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
                    {/*
                     * Reading a query is the other half of writing one, and the console
                     * only ever did the writing half. Sits beside Format because it is
                     * the same kind of action — something done TO the draft — rather
                     * than beside Run, which changes the database's state.
                     *
                     * On the Explain tab it asks about the PLAN instead: the operator
                     * is looking at a plan, so that is what "explain this" means there.
                     */}
                    {pane === "explain" && onExplainPlan !== undefined && (
                        <button
                            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
                            data-testid="sql-explain-plan"
                            disabled={running || rpc.pending("chat")}
                            onClick={onExplainPlan}
                            type="button"
                        >
                            {t("Read this plan")}
                        </button>
                    )}
                    {pane !== "explain" && onExplainSql !== undefined && (
                        <button
                            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
                            data-testid="sql-explain-query"
                            disabled={running || rpc.pending("chat")}
                            onClick={onExplainSql}
                            type="button"
                        >
                            {t("Explain this query")}
                        </button>
                    )}
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

            {script !== undefined && (
                // Only for a script. A single statement has nothing to choose
                // between, and a one-button strip would be pure chrome.
                <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5" data-testid="sql-statements">
                    {script.runs.map((statement, index) => (
                        <button
                            aria-pressed={index === script.selected}
                            className={`rounded-md border px-2 py-0.5 font-mono text-[11px] outline-none transition-colors ${
                                index === script.selected ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                            } ${statement.error === null ? "" : "border-destructive/50 text-destructive"}`}
                            data-testid={`sql-statement-${index.toString()}`}
                            key={`${index.toString()}:${statement.sql}`}
                            onClick={() => {
                                onSelectStatement(index);
                            }}
                            title={statement.sql}
                            type="button"
                        >
                            {index + 1}
                        </button>
                    ))}
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto">
                {error !== null && (
                    <div className="m-3 flex flex-col items-start gap-2">
                        <Alert className="w-full font-mono text-xs" testId="sql-error" variant="destructive">
                            {error}
                        </Alert>

                        {/*
                         * The debug affordance belongs HERE, on the failure.
                         * "Fix this" already existed in the prompt bar at the top of
                         * the editor — the one place an operator reading an error at
                         * the bottom of a full-height editor cannot see it.
                         *
                         * It explains rather than silently rewriting the draft: an
                         * error you do not understand is not fixed by a statement you
                         * did not read either.
                         */}
                        {!rpc.unavailable && onDebugError !== undefined && (
                            <button
                                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                                data-testid="sql-debug-error"
                                disabled={rpc.pending("chat")}
                                onClick={onDebugError}
                                type="button"
                            >
                                <svg
                                    aria-hidden="true"
                                    className="size-3.5"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.6}
                                    viewBox="0 0 24 24"
                                >
                                    <path d="M21 12a8 8 0 0 1-8 8H7l-4 3 1.2-4.2A8 8 0 1 1 21 12Z" />
                                </svg>
                                {rpc.pending("chat") ? t("Thinking…") : t("Debug with AI")}
                            </button>
                        )}
                    </div>
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

export default SqlResultsPane;
