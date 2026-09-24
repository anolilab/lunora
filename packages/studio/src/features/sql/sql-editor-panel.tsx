import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { explainQueryPlan } from "../../../../../shared/sql-readonly";
import { classifyOne, splitStatements } from "../../../../../shared/sql-split-statements";
import type { SqlConsoleResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { usePersistedValue } from "../../lib/browser-storage";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import formatSql from "./format-sql";
import { useSqlAssistant } from "./hooks/use-sql-assistant";
import { useSqlDiagnostics } from "./hooks/use-sql-diagnostics";
import { useSqlEditorSurface } from "./hooks/use-sql-editor-surface";
import type { ScriptRun } from "./hooks/use-sql-editor-tabs";
import { useSqlEditorTabs } from "./hooks/use-sql-editor-tabs";
import { useSqlLibrary } from "./hooks/use-sql-library";
import SqlEditorPane from "./sql-editor-pane";
import { SqlQuerySidebar, TEMPLATES } from "./sql-query-sidebar";
import SqlResultsPane from "./sql-results-pane";
import { useSqlSchema } from "./sql-schema";
import SqlTabStrip from "./sql-tab-strip";
import type { ResultTab, SqlTab } from "./sql-tabs";
import { makeTab } from "./sql-tabs";

interface SqlEditorPanelProps {
    /** Shard key the query runs against on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const RUN_SQL = adminRef(ADMIN_FUNCTIONS.runSql);
/** Persisted editor↔results layout: `false` stacks them (default), `true` splits side by side for wide screens. */
const SPLIT_VIEW_KEY = "lunora-studio-sql-split-view";

/** The tab the editor opens with on a fresh browser: the first template. */
const seedTab = (): SqlTab => makeTab(TEMPLATES[0]?.sql ?? "");

/**
 * A full-height, Supabase-style SQL editor: a left query sidebar (search + new,
 * a browser-persisted PRIVATE list, and REFERENCE templates), a line-numbered
 * editor pane, and a Results / Explain pane with a Run control + shard selector.
 * Read-only — the `__lunora_admin__:runSql` RPC rejects everything but
 * SELECT / WITH / EXPLAIN, so raw writes can't desync the doc-store's shadow
 * tables (use the Data grid's inline edit for mutations).
 */
export const SqlEditorPanel = ({ initialShardKey }: SqlEditorPanelProps): ReactElement => {
    const client = useLunora();

    // Multiple editor tabs: each persisted tab owns its draft + the saved-query it
    // mirrors, plus an ephemeral per-tab output, so a reload restores the open tabs
    // (and their text) but re-runs for results.
    const editorTabs = useSqlEditorTabs(seedTab);
    const { activeTab, output, patchActiveOutput, patchActiveTab, setActiveTabId, unlinkQuery } = editorTabs;

    // Load `sql` into the active tab as a fresh draft, link it to `savedId` (or
    // unlink with `null`), and clear that tab's stale result/error.
    const loadIntoActiveTab = (sql: string, savedId: null | string): void => {
        patchActiveTab({ activeId: savedId, sql });
        // `script` too: without it the previous run's statement strip survives into
        // a new draft, and selecting one of its entries shows a result belonging to
        // a query the editor no longer holds.
        patchActiveOutput({ chart: undefined, error: null, failed: undefined, result: null, script: undefined });
    };

    const library = useSqlLibrary({ loadIntoActiveTab, unlinkQuery });
    const { recordHistory, updateQuerySql } = library;
    const draft = activeTab.sql;
    const { activeId } = activeTab;
    const { chart: inferredChart, error, failed: failedRun, result, running } = output;
    const tab = output.pane;

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    // Editor↔results layout: stacked (default) or side-by-side, persisted across reloads.
    const [splitView, setSplitView] = usePersistedValue<boolean>(SPLIT_VIEW_KEY, false);

    const { probe, schema } = useSqlSchema(shardKey);

    // Set the active tab's draft and keep the linked saved query in sync (auto-save).
    const setDraft = (value: string): void => {
        patchActiveTab({ sql: value });

        if (activeId !== null) {
            updateQuerySql(activeId, value);
        }
    };

    const diagnostics = useSqlDiagnostics(draft, schema, shardKey);
    const assistant = useSqlAssistant(shardKey);

    const inferChart = (): void => {
        if (result === null) {
            return;
        }

        const apply = async (): Promise<void> => {
            // The result's SHAPE only — never its rows (plan 202 Phase 0).
            const chart = await assistant.inferChart({
                columns: result.columns,
                rowCount: result.rowCount,
                types: Object.fromEntries(result.columns.map((column) => [column, typeof (result.rows[0]?.[column] ?? "")])),
            });

            patchActiveOutput({ chart });
        };

        fireAndForget(apply());
    };

    /** Run one statement, never a script: the gate refuses a `;`-joined string. */
    const runOne = async (sql: string): Promise<ScriptRun> => {
        try {
            const next = (await client.query(RUN_SQL, { sql }, callOptions(shardKey))) as SqlConsoleResult;

            recordHistory(sql);

            return { error: null, result: next, sql };
        } catch (error_: unknown) {
            return { error: errorMessage(error_), result: null, sql };
        }
    };

    /**
     * Run the draft.
     *
     * A multi-statement draft is split ABOVE the read-only gate and submitted as
     * N separate `runSql` calls, never as one `;`-joined string — the classifier
     * is the console's enforcement point and stays exactly as strict. A statement
     * the gate would refuse is reported without being sent, and the ones after it
     * still run, so a script says what happened to every part of itself.
     */
    const run = async (mode: ResultTab): Promise<void> => {
        if (draft.trim() === "") {
            return;
        }

        // `patchActiveOutput` closes over the tab that's active AT THIS CALL —
        // the same closure used below to land the result, even if the operator
        // switches to a different tab while this query is in flight. That's what
        // keeps `running` (and the result it guards) scoped to the tab that
        // actually ran the query, not whichever tab happens to be active when the
        // response lands.
        patchActiveOutput({ running: true });

        // EXPLAIN wraps the whole draft, so the wrapper must be gated as ONE
        // statement — `classifyOne`, never `splitStatements`. Splitting it turned
        // `EXPLAIN QUERY PLAN SELECT 1; SELECT 2` into an explained prefix plus a
        // `SELECT 2` that simply ran, which is the opposite of what asking for a
        // plan means. Gated as one, a script the operator asks to explain is
        // refused with the same message the editor's own diagnostic shows.
        //
        // `explainQueryPlan` rather than a bare template: a draft that already
        // leads with `EXPLAIN` (which the gate allows) would otherwise be
        // double-prefixed into `EXPLAIN QUERY PLAN EXPLAIN …` — a syntax error
        // on a statement Run executes happily.
        const statements = mode === "explain" ? classifyOne(explainQueryPlan(draft), 0) : splitStatements(draft);
        const runs: ScriptRun[] = [];

        for (const statement of statements) {
            const refused: ScriptRun = { error: statement.rejection?.message ?? "", result: null, sql: statement.sql };

            // Both suppressions say the same thing, and BOTH must sit adjacent to the
            // statement — a disable comment separated from its line by another
            // comment silently does nothing. Hence one above, one trailing.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- ordering is the contract: a script's statements run in sequence, and `Promise.all` would fire a later one against state an earlier one has not established
            runs.push(statement.rejection === undefined ? await runOne(statement.sql) : refused); // eslint-disable-line no-await-in-loop -- sequential on purpose: see above
        }

        recordShard(shardKey);

        // The last statement is what the panes show — the one an operator writing
        // a script is looking for. Everything before it stays reachable through
        // the statement strip.
        const selected = Math.max(runs.length - 1, 0);
        const shown = runs[selected];

        patchActiveOutput({
            chart: undefined,
            error: shown?.error ?? null,
            failed: shown?.error === null || shown === undefined ? undefined : { error: shown.error, sql: shown.sql },
            pane: mode,
            result: shown?.result ?? null,
            running: false,
            script: runs.length > 1 ? { runs, selected } : undefined,
        });
    };

    /** Show statement `index` of the script already run, without re-running anything. */
    const onSelectStatement = (index: number): void => {
        const runs = output.script?.runs;
        const shown = runs?.[index];

        if (runs === undefined || shown === undefined) {
            return;
        }

        patchActiveOutput({
            chart: undefined,
            error: shown.error,
            failed: shown.error === null ? undefined : { error: shown.error, sql: shown.sql },
            result: shown.result,
            script: { runs, selected: index },
        });
    };

    const onRun = (): void => {
        fireAndForget(run("results"));
    };

    const surface = useSqlEditorSurface({
        onSubmit: () => {
            fireAndForget(run(output.pane));
        },
        probe,
        schema,
        setDraft,
    });
    const { closeAutocomplete } = surface;

    // Pretty-print the current draft in place (auto-saving the active query too).
    const formatDraft = (): void => {
        setDraft(formatSql(draft));
    };

    const selectTab = (id: string): void => {
        closeAutocomplete();
        setActiveTabId(id);
    };

    const showResults = (): void => {
        patchActiveOutput({ pane: "results" });
    };

    const showExplain = (): void => {
        fireAndForget(run("explain"));
    };

    const showChart = (): void => {
        patchActiveOutput({ pane: "chart" });
    };

    const toggleSplit = (): void => {
        setSplitView(!splitView);
    };

    // Editor + results share a flex container; `splitView` flips its axis (and the
    // results pane from a bottom band to a right column) — the only layout change.
    const workspaceClass = splitView ? "flex min-h-0 flex-1 flex-row" : "flex min-h-0 flex-1 flex-col";
    const resultsClass = splitView
        ? "flex w-2/5 min-h-0 min-w-0 shrink-0 flex-col border-s border-border"
        : "flex h-2/5 min-h-0 shrink-0 flex-col border-t border-border";

    return (
        <div className="flex h-full min-w-0" data-testid="lunora-sql-editor">
            <SqlQuerySidebar
                activeId={activeId}
                history={library.history}
                listRef={library.listRef}
                onClearHistory={library.clearHistory}
                onDelete={library.deleteQuery}
                onLoadHistory={library.loadFromHistory}
                onLoadTemplate={library.loadTemplate}
                onNew={library.newQuery}
                onSearchChange={library.onSearchChange}
                onSelect={library.selectQuery}
                onToggleRememberHistory={library.setRememberHistory}
                queries={library.queries}
                rememberHistory={library.rememberHistory}
                search={library.search}
            />

            {/* Editor + results. */}
            <div className="flex min-w-0 flex-1 flex-col">
                <SqlTabStrip model={editorTabs} onSelect={selectTab} />

                {/* Editor + results workspace — stacked, or split side-by-side. */}
                <div className={workspaceClass}>
                    <SqlEditorPane
                        assistant={assistant}
                        autocomplete={surface.autocompleteState}
                        diagnostics={diagnostics}
                        draft={draft}
                        editorRef={surface.editorRef}
                        failed={failedRun}
                        gutterRef={surface.gutterRef}
                        handlers={surface.handlers}
                        listboxId={surface.listboxId}
                        onGenerated={setDraft}
                        onPickSuggestion={surface.onPickSuggestion}
                        onRevealDiagnostic={surface.revealDiagnostic}
                        overlayRef={surface.overlayRef}
                    />

                    <SqlResultsPane
                        assistant={assistant}
                        chart={inferredChart}
                        className={resultsClass}
                        error={error}
                        onFormat={formatDraft}
                        onInferChart={inferChart}
                        onRun={onRun}
                        onSelectStatement={onSelectStatement}
                        onShardKeyChange={setShardKey}
                        onShowChart={showChart}
                        onShowExplain={showExplain}
                        onShowResults={showResults}
                        onToggleSplit={toggleSplit}
                        pane={tab}
                        result={result}
                        running={running}
                        script={output.script}
                        shardKey={shardKey}
                        splitView={splitView}
                    />
                </div>
            </div>
        </div>
    );
};

export type { SqlEditorPanelProps };
