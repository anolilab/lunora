import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { useAssistant } from "../../components/assistant-provider";
import { useAssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import type { SchemaFact, SqlConsoleResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { usePersistedValue } from "../../lib/browser-storage";
import { adminRef, callOptions, errorMessage, fireAndForget, formatCell } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import formatSql from "./format-sql";
import { useSqlDiagnostics } from "./hooks/use-sql-diagnostics";
import { useSqlEditorSurface } from "./hooks/use-sql-editor-surface";
import type { ScriptRun } from "./hooks/use-sql-editor-tabs";
import { useSqlEditorTabs } from "./hooks/use-sql-editor-tabs";
import { useSqlLibrary } from "./hooks/use-sql-library";
import { classifyOne, splitStatements } from "./split-statements";
import type { SqlSchema } from "./sql-autocomplete";
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
 * Starter questions for a freshly opened console session.
 *
 * Built from the probed schema so they name real tables. A generic prompt list is
 * only marginally better than a blank box — the point of a suggestion is that it
 * is answerable HERE.
 */
const consoleSuggestions = (schema: SqlSchema, t: ReturnType<typeof useT>): string[] => {
    const table = schema.tables[0];

    return table === undefined
        ? [t("What tables does this app have?")]
        : [t("What tables does this app have?"), t("Show me the most recent rows in {table}", { table }), t("Is anything wrong with my schema?")];
};

/**
 * The editor's schema, as the chat engine's grounding block wants it.
 *
 * A table whose columns have not been probed yet still contributes its NAME — the
 * system prompt tells the model to invent nothing, so knowing a table exists is
 * worth more than omitting it until its columns arrive.
 */
const groundingFacts = (schema: SqlSchema): SchemaFact[] =>
    schema.tables.map((table) => {
        return { columns: [...(schema.columns[table] ?? [])], table };
    });

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
    /*
     * The assistant is the SHELL's, not this panel's.
     *
     * It used to be a column inside this component with its own transcript, which
     * meant navigating away threw the conversation out and no other page could
     * reach it. Now the console opens the shared one and hands it the grounding it
     * has; the panel renders in the layout beside whatever page is open.
     *
     * `undefined` when no provider is mounted (a bare-composed Studio panel), in
     * which case every affordance below is simply not offered.
     */
    const t = useT();
    const assistantShell = useAssistant();

    const { probe, schema } = useSqlSchema(shardKey);

    // Set the active tab's draft and keep the linked saved query in sync (auto-save).
    const setDraft = (value: string): void => {
        patchActiveTab({ sql: value });

        if (activeId !== null) {
            updateQuerySql(activeId, value);
        }
    };

    /*
     * Tell the assistant this page can accept an insert, and withdraw on the way
     * out. A boolean rather than a callback: `setDraft` closes over the active tab
     * and is re-created every render, so registering IT would either re-run this
     * effect on every keystroke or pin the target to the first render's tab.
     */
    const setHasEditor = assistantShell?.setHasEditor;

    useEffect(() => {
        if (setHasEditor === undefined) {
            return undefined;
        }

        setHasEditor(true);

        return () => {
            setHasEditor(false);
        };
    }, [setHasEditor]);

    /*
     * Collect a statement the assistant offered.
     *
     * An effect because the trigger is outside this component — the operator
     * pressed Insert in the shell-wide panel — and this runs with the CURRENT
     * render's `setDraft`, so it always writes to the tab that is actually open.
     * That is what the mirrored ref used to buy, and it is free once what crosses
     * the boundary is a value rather than a closure. `takeInsert` clears it by id,
     * so a re-render never re-inserts and the same statement can be inserted twice.
     */
    const insertRequest = assistantShell?.insertRequest;
    const takeInsert = assistantShell?.takeInsert;

    useEffect(() => {
        if (insertRequest === undefined || takeInsert === undefined) {
            return;
        }

        takeInsert(insertRequest.id);
        setDraft(insertRequest.sql);
        // `setDraft` is re-created every render and is not a meaningful dependency —
        // the request's identity is what decides whether to insert.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [insertRequest, takeInsert]);

    const diagnostics = useSqlDiagnostics(draft, schema, shardKey);
    const rpc = useAssistantRpc(shardKey);

    const inferChart = (): void => {
        if (result === null) {
            return;
        }

        const apply = async (): Promise<void> => {
            // The result's SHAPE only — never its rows (plan 202 Phase 0).
            const chart = await rpc.inferChart({
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
        const statements = mode === "explain" ? classifyOne(`EXPLAIN QUERY PLAN ${draft}`, 0) : splitStatements(draft);
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

    const toggleChat = (): void => {
        if (assistantShell === undefined) {
            return;
        }

        // A toggle closes as well as opens. `openAssistant` only ever opens — it is
        // what a seeded question calls — so pressing this button twice left the
        // panel showing and the `aria-pressed` state lying about it.
        if (assistantShell.open) {
            assistantShell.close();

            return;
        }

        // Grounding travels with the toggle, not just with a seeded question: an
        // operator who opens the assistant and types their own question should get
        // the same schema the "Debug with AI" path does.
        assistantShell.openAssistant({
            schema: groundingFacts(schema),
            shardKey,
            // Named from the schema this console has actually probed, so the
            // starters mention the operator's own tables rather than a generic
            // "ask me about your data".
            suggestions: consoleSuggestions(schema, t),
            title: t("SQL console"),
        });
    };

    /*
     * Open the assistant on the failing statement.
     *
     * The statement and the error travel in the QUESTION rather than as separate
     * fields, because the transcript is what the model reads — a turn the operator
     * can then follow up on ("why does that column not exist?") instead of a
     * one-shot repair that rewrites their draft and explains nothing.
     */
    const debugError = (): void => {
        if (failedRun === undefined) {
            return;
        }

        assistantShell?.openAssistant({
            ask: `This statement failed:\n${failedRun.sql}\n\nThe database said: ${failedRun.error}\n\nWhy, and what should it be?`,
            schema: groundingFacts(schema),
            shardKey,
            title: t("Debug query"),
        });
    };

    /*
     * Explain the draft, rather than write a new one.
     *
     * The statement travels verbatim inside the question so the answer lands in a
     * transcript the operator can follow up in — the same shape `debugError` uses,
     * and the reason neither of them rewrites the editor.
     */
    const explainSql = (): void => {
        const statement = draft.trim();

        if (statement === "") {
            return;
        }

        assistantShell?.openAssistant({
            ask: `Explain what this query does, step by step:\n${statement}`,
            schema: groundingFacts(schema),
            shardKey,
            title: t("Explain query"),
        });
    };

    /*
     * Read the plan the Explain tab is showing.
     *
     * The plan ROWS travel, not just the statement — a plan the operator can see
     * and the model cannot is the whole thing they are asking about. They are
     * `EXPLAIN QUERY PLAN` output (operation descriptions), not table data, so
     * this carries no end-user rows regardless of the deployment's opt-in level.
     */
    const explainPlan = (): void => {
        if (result === null || result.rows.length === 0) {
            return;
        }

        const plan = result.rows.map((row) => result.columns.map((column) => formatCell(row[column])).join(" | ")).join("\n");

        assistantShell?.openAssistant({
            ask: `SQLite planned this query:\n${draft.trim()}\n\nas:\n${plan}\n\nWhat is it doing, and is anything here slow?`,
            schema: groundingFacts(schema),
            shardKey,
            title: t("Read plan"),
        });
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
                        rpc={rpc}
                    />

                    {/*
                     * Below the editor, above the results: a reply that suggests a
                     * statement is one Insert away from the editor it sits under.
                     * Renders nothing without an `AI` binding, on the same latch as
                     * the prompt bar.
                     */}
                    <SqlResultsPane
                        chart={inferredChart}
                        chatOpen={assistantShell?.open === true}
                        className={resultsClass}
                        error={error}
                        onDebugError={failedRun === undefined ? undefined : debugError}
                        onExplainPlan={assistantShell === undefined || assistantShell.unavailable || tab !== "explain" ? undefined : explainPlan}
                        onExplainSql={assistantShell === undefined || assistantShell.unavailable ? undefined : explainSql}
                        onFormat={formatDraft}
                        onInferChart={inferChart}
                        onRun={onRun}
                        onSelectStatement={onSelectStatement}
                        onShardKeyChange={setShardKey}
                        onShowChart={showChart}
                        onShowExplain={showExplain}
                        onShowResults={showResults}
                        onToggleChat={assistantShell === undefined || assistantShell.unavailable ? undefined : toggleChat}
                        onToggleSplit={toggleSplit}
                        pane={tab}
                        result={result}
                        rpc={rpc}
                        running={running}
                        script={output.script}
                        shardKey={shardKey}
                        splitView={splitView}
                    />
                </div>
            </div>

            {/*
             * The assistant panel itself is rendered by the shell, beside this
             * page — see `StudioLayoutShell`. What the console registers here is
             * the one thing only it can do: put a suggested statement in the
             * editor. The shell hands `onInsert` to the panel, so the Insert
             * button appears on this page and nowhere it could not work.
             */}
        </div>
    );
};

export type { SqlEditorPanelProps };
