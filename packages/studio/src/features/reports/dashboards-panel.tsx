import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { useT } from "../../i18n/i18n-context";
import type { AssistantChartConfig, SqlConsoleResult } from "../../lib/admin";
import { newId, usePersistedList } from "../../lib/browser-storage";
import { fireAndForget } from "../../lib/internal";
import { useSqlAssistant } from "../sql/hooks/use-sql-assistant";
import type { ChartKind, Widget, WidgetKind } from "./dashboard-widgets";
import { DashboardWidgetCard, widgetKind } from "./dashboard-widgets";

interface DashboardsPanelProps {
    /** Shard key new widgets default to. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** The picker's options, in the order they are offered. */
const CHART_KINDS: ReadonlyArray<ChartKind> = ["bar", "line", "area"];

/** The tile kinds, in the order they are offered. */
const WIDGET_KINDS: ReadonlyArray<WidgetKind> = ["chart", "kpi", "table", "text"];

/** Draft state for the add/edit form. */
interface WidgetDraft {
    readonly chartKind: ChartKind;
    readonly kind: WidgetKind;
    readonly shardKey: string;
    readonly sql: string;
    readonly text: string;
    readonly title: string;
}

const STORAGE_KEY = "lunora-studio-dashboards";
const EMPTY_DRAFT: WidgetDraft = { chartKind: "bar", kind: "chart", shardKey: "", sql: "", text: "", title: "" };

/**
 * Write an accepted suggestion onto one widget: both the columns the assistant
 * found and, as the operator's own choice, the shape it picked.
 *
 * A module-level updater rather than an inline closure so the handler that uses
 * it stays inside the nesting limit.
 */
const applyInference =
    (id: string, inferred: AssistantChartConfig) =>
    (current: Widget[]): Widget[] =>
        current.map((widget) => (widget.id === id ? { ...widget, chartAxes: inferred, chartKind: inferred.kind } : widget));

/**
 * Move `from` to sit where `to` currently is.
 *
 * A module-level updater for the same reason as {@link applyInference}. An id
 * that is no longer in the list (a widget removed mid-drag) leaves the order
 * untouched rather than appending it back.
 */
const moveWidget =
    (from: string, to: string) =>
    (current: Widget[]): Widget[] => {
        const moved = current.find((widget) => widget.id === from);
        const rest = current.filter((widget) => widget.id !== from);
        const at = rest.findIndex((widget) => widget.id === to);

        if (moved === undefined || at === -1) {
            return current;
        }

        return [...rest.slice(0, at), moved, ...rest.slice(at)];
    };

/** The chart picker's label for one kind. Explicit, so the `t(...)` ids stay statically known. */
const kindLabel = (kind: ChartKind, t: ReturnType<typeof useT>): string => {
    if (kind === "line") {
        return t("Line");
    }

    return kind === "area" ? t("Area") : t("Bar");
};

/** The tile picker's label for one kind. Explicit for the same reason as {@link kindLabel}. */
const widgetKindLabel = (kind: WidgetKind, t: ReturnType<typeof useT>): string => {
    if (kind === "kpi") {
        return t("Single value");
    }

    if (kind === "table") {
        return t("Table");
    }

    return kind === "text" ? t("Text") : t("Chart");
};

interface WidgetFormProps {
    readonly draft: WidgetDraft;
    readonly editing: boolean;
    readonly onCancel: () => void;
    readonly onChange: (draft: WidgetDraft) => void;
    readonly onSubmit: () => void;
}

/**
 * The add/edit form. The tile kind comes first because it decides what the rest
 * of the form even is: a `text` tile has a body and no query, and only a `chart`
 * tile has a shape to pick.
 */
const WidgetForm = ({ draft, editing, onCancel, onChange, onSubmit }: WidgetFormProps): ReactElement => {
    const t = useT();

    const onTitleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        onChange({ ...draft, title: event.target.value });
    };
    const onSqlChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        onChange({ ...draft, sql: event.target.value });
    };
    const onTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        onChange({ ...draft, text: event.target.value });
    };
    const onShardChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        onChange({ ...draft, shardKey: event.target.value });
    };
    const onKindChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        onChange({ ...draft, chartKind: event.target.value as ChartKind });
    };
    const onWidgetKindChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        onChange({ ...draft, kind: event.target.value as WidgetKind });
    };
    const onSubmitClick = (): void => {
        onSubmit();
    };

    const isText = draft.kind === "text";
    // A text tile is saveable on its body; every other kind needs a query. Both
    // need a title, which is the only thing the grid renders before the tile runs.
    const canSave = draft.title.trim() !== "" && (isText ? draft.text.trim() !== "" : draft.sql.trim() !== "");

    return (
        <Card data-testid="dashboards-form">
            <CardContent className="flex flex-col gap-3 py-4">
                <input
                    aria-label={t("Widget title")}
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:border-ring"
                    data-testid="dashboards-form-title"
                    onChange={onTitleChange}
                    placeholder={t("Widget title")}
                    type="text"
                    value={draft.title}
                />
                <select
                    aria-label={t("Widget type")}
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:border-ring"
                    data-testid="dashboards-form-widget-kind"
                    onChange={onWidgetKindChange}
                    value={draft.kind}
                >
                    {WIDGET_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                            {widgetKindLabel(kind, t)}
                        </option>
                    ))}
                </select>
                {isText ? (
                    <textarea
                        aria-label={t("Text")}
                        className="min-h-24 resize-y rounded-md border border-border bg-background p-2 text-xs leading-5 outline-none focus-visible:border-ring"
                        data-testid="dashboards-form-text"
                        onChange={onTextChange}
                        placeholder={t("Notes for whoever reads this dashboard.")}
                        value={draft.text}
                    />
                ) : (
                    <textarea
                        aria-label={t("SQL query")}
                        className="min-h-24 resize-y rounded-md border border-border bg-background p-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring"
                        data-testid="dashboards-form-sql"
                        onChange={onSqlChange}
                        placeholder="SELECT author, COUNT(*) AS messages FROM …"
                        spellCheck={false}
                        value={draft.sql}
                    />
                )}
                {draft.kind === "chart" && (
                    <select
                        aria-label={t("Chart type")}
                        className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:border-ring"
                        data-testid="dashboards-form-kind"
                        onChange={onKindChange}
                        value={draft.chartKind}
                    >
                        {CHART_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                                {kindLabel(kind, t)}
                            </option>
                        ))}
                    </select>
                )}
                {!isText && (
                    <input
                        aria-label={t("Shard key (optional)")}
                        className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs outline-none focus-visible:border-ring"
                        data-testid="dashboards-form-shard"
                        onChange={onShardChange}
                        placeholder={t("Shard key (optional)")}
                        type="text"
                        value={draft.shardKey}
                    />
                )}
                <div className="flex items-center justify-end gap-2">
                    <Button data-testid="dashboards-form-cancel" onClick={onCancel} size="sm" type="button" variant="outline">
                        {t("Cancel")}
                    </Button>
                    <Button data-testid="dashboards-form-save" disabled={!canSave} onClick={onSubmitClick} size="sm" type="button">
                        {editing ? t("Save widget") : t("Add widget")}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
};

/**
 * The Dashboards panel: a single browser-persisted dashboard of tiles — a chart,
 * a single value, a result table, or a note. The first three are a saved
 * read-only SQL query run through the `runSql` admin RPC; the note runs nothing.
 * "Add widget" opens an inline form; each tile can be edited, removed, or dragged
 * to reorder. The list persists to `localStorage`, mirroring the SQL editor's
 * saved queries, so a dashboard survives a reload without any server-side state.
 */
const DashboardsPanel = ({ initialShardKey }: DashboardsPanelProps): ReactElement => {
    const t = useT();

    const [widgets, setWidgets] = usePersistedList<Widget>(STORAGE_KEY);
    const [draft, setDraft] = useState<WidgetDraft>(EMPTY_DRAFT);
    const [editingId, setEditingId] = useState<null | string>(null);
    const [formOpen, setFormOpen] = useState<boolean>(false);
    // One assistant for the whole dashboard, not one per card: the AI binding is
    // a property of the deployment, so N cards would mean N identical
    // availability subscriptions. The shard only decides where the call lands.
    const assistant = useSqlAssistant(initialShardKey ?? "");
    // Which card is waiting, tracked here rather than reading `assistant.pending`
    // — that status is per TASK, so it would spin every card's button at once.
    const [inferringId, setInferringId] = useState<null | string>(null);
    // Carries the dragged tile's id from a card's dragstart to another card's drop.
    const draggedWidget = useRef<null | string>(null);

    const openAdd = (): void => {
        setEditingId(null);
        setDraft({ ...EMPTY_DRAFT, shardKey: initialShardKey ?? "" });
        setFormOpen(true);
    };

    const closeForm = (): void => {
        setFormOpen(false);
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
    };

    const onEdit = (id: string): void => {
        const found = widgets.find((widget) => widget.id === id);

        if (found !== undefined) {
            setEditingId(id);
            setDraft({
                chartKind: found.chartKind ?? "bar",
                kind: widgetKind(found),
                shardKey: found.shardKey ?? "",
                sql: found.sql,
                text: found.text ?? "",
                title: found.title,
            });
            setFormOpen(true);
        }
    };

    /**
     * Ask the assistant to read this widget's result SHAPE and write back both
     * the columns it found and the shape it chose.
     *
     * It writes `chartKind` as well as `chartAxes` because accepting a
     * suggestion IS a choice — the operator clicked the button. Storing only the
     * axes would leave the shape at the mercy of the suggested series surviving
     * `SqlResultChart`'s column gate, which is exactly the silent-fallback this
     * workstream exists to remove.
     */
    const onSuggestChart = (id: string, result: SqlConsoleResult): void => {
        setInferringId(id);

        const apply = async (): Promise<void> => {
            const inferred = await assistant.inferChart({ columns: result.columns, rowCount: result.rowCount });

            if (inferred !== undefined) {
                setWidgets(applyInference(id, inferred));
            }
        };

        /*
         * `.finally()` on the promise, not a `try`/`finally` STATEMENT: React
         * Compiler cannot lower a `TryStatement` here and bails on the whole
         * component, so one spinner reset would cost every other value in this
         * panel its memoization.
         *
         * Nothing is caught because `inferChart` swallows its own failures and
         * answers `undefined` for both an AI error and a degraded reply; the
         * operator sees the cause through the `assistant.reason("chart")` alert
         * below. `.finally()` still runs on a rejection, so the spinner clears
         * either way.
         */
        fireAndForget(
            apply().finally(() => {
                setInferringId((current) => (current === id ? null : current));
            }),
        );
    };

    const onRemove = (id: string): void => {
        setWidgets((current) => current.filter((widget) => widget.id !== id));
    };

    const onReorder = (from: string, to: string): void => {
        setWidgets(moveWidget(from, to));
    };

    const onSubmit = (): void => {
        const title = draft.title.trim();
        const sql = draft.sql.trim();
        const text = draft.text.trim();
        const { chartKind, kind } = draft;

        // The same rule the form's Save button is disabled by, re-checked here:
        // the button is a hint, this is the guard.
        if (title === "" || (kind === "text" ? text === "" : sql === "")) {
            return;
        }

        const saved = { chartKind, kind, shardKey: draft.shardKey.trim(), sql, text, title };

        if (editingId === null) {
            setWidgets((current) => [...current, { ...saved, id: newId("w") }]);
        } else {
            setWidgets((current) => current.map((widget) => (widget.id === editingId ? { ...widget, ...saved } : widget)));
        }

        closeForm();
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-dashboards">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t("Charts, values, tables, and notes. Drag a tile to reorder.")}</p>
                {!formOpen && (
                    <Button data-testid="dashboards-add" onClick={openAdd} size="sm" type="button">
                        {t("Add widget")}
                    </Button>
                )}
            </div>

            {assistant.reason("chart") !== undefined && (
                <Alert className="text-xs" testId="dashboards-suggest-error" variant="destructive">
                    {t("Could not suggest a chart for that result.")}
                </Alert>
            )}

            {formOpen && <WidgetForm draft={draft} editing={editingId !== null} onCancel={closeForm} onChange={setDraft} onSubmit={onSubmit} />}

            {widgets.length === 0 && !formOpen ? (
                <EmptyState
                    description={t("Add a chart, a single value, a table, or a note. Everything is saved on this browser.")}
                    testId="dashboards-empty"
                    title={t("No widgets yet")}
                />
            ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="dashboards-grid">
                    {widgets.map((widget) => (
                        <DashboardWidgetCard
                            draggedRef={draggedWidget}
                            inferring={inferringId === widget.id}
                            key={widget.id}
                            onEdit={onEdit}
                            onRemove={onRemove}
                            onReorder={onReorder}
                            onSuggest={assistant.unavailable ? undefined : onSuggestChart}
                            widget={widget}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

export default DashboardsPanel;

export type { DashboardsPanelProps };
