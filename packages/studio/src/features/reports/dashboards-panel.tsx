import type { ReactElement } from "react";
import { useState } from "react";

import SqlResultChart from "../../components/result-chart";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { useT } from "../../i18n/i18n-context";
import type { AssistantChartConfig, SqlConsoleResult } from "../../lib/admin";
import { newId, usePersistedList } from "../../lib/browser-storage";
import { fireAndForget } from "../../lib/internal";
import { useRunSql } from "../sql/hooks/use-run-sql";
import { useSqlAssistant } from "../sql/hooks/use-sql-assistant";

interface DashboardsPanelProps {
    /** Shard key new widgets default to. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** The three shapes {@link SqlResultChart} can draw. */
type ChartKind = AssistantChartConfig["kind"];

/** The picker's options, in the order they are offered. */
const CHART_KINDS: ReadonlyArray<ChartKind> = ["bar", "line", "area"];

/**
 * One browser-persisted chart widget on the dashboard.
 *
 * The two chart fields have different writers and are deliberately separate.
 * `chartKind` is the operator's pick and is the only thing the form edits;
 * `chartAxes` is whatever "Suggest chart" last inferred. Keeping them apart is
 * what lets an operator say "keep those columns, but draw it as an area" —
 * folding them into one config would make every pick discard the columns.
 *
 * Both are optional, so a widget saved before this existed reads back as the
 * heuristic bar chart it already was.
 */
interface Widget {
    /** Columns last inferred by the assistant, when it has been asked. */
    readonly chartAxes?: AssistantChartConfig;
    /** The shape the operator picked; absent → heuristic (see {@link SqlResultChart}). */
    readonly chartKind?: ChartKind;
    readonly id: string;
    /** Optional shard key the widget's query runs against; empty/absent → root shard. */
    readonly shardKey?: string;
    readonly sql: string;
    readonly title: string;
}

/** Draft state for the add/edit form. */
interface WidgetDraft {
    readonly chartKind: ChartKind;
    readonly shardKey: string;
    readonly sql: string;
    readonly title: string;
}

const STORAGE_KEY = "lunora-studio-dashboards";
const EMPTY_DRAFT: WidgetDraft = { chartKind: "bar", shardKey: "", sql: "", title: "" };

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

/** The picker's label for one kind. Explicit, so the `t(...)` ids stay statically known. */
const kindLabel = (kind: ChartKind, t: ReturnType<typeof useT>): string => {
    if (kind === "line") {
        return t("Line");
    }

    return kind === "area" ? t("Area") : t("Bar");
};

interface WidgetCardProps {
    /** True while THIS card's suggestion is in flight — the panel tracks it per widget. */
    readonly inferring: boolean;
    readonly onEdit: (id: string) => void;
    readonly onRemove: (id: string) => void;
    /** Absent when the deployment has no AI binding, which is what hides the affordance. */
    readonly onSuggest?: (id: string, result: SqlConsoleResult) => void;
    readonly widget: Widget;
}

/**
 * One dashboard tile: a titled card that runs its saved SQL on mount (and when
 * the SQL/shard changes) via the read-only `runSql` admin RPC and charts the
 * result with {@link SqlResultChart}. A failed query renders its message inline
 * rather than throwing, so one broken widget never blanks the grid.
 *
 * The suggest affordance lives HERE rather than in the form because this is the
 * only place that holds a result: inferring a chart needs the result's column
 * shape, and the form has never run the query it is editing.
 */
const WidgetCard = ({ inferring, onEdit, onRemove, onSuggest, widget }: WidgetCardProps): ReactElement => {
    const t = useT();

    // The shared run/cancel hook owns the query lifecycle; the card is otherwise
    // purely presentational. It re-runs whenever the widget's SQL or shard changes.
    const { error, loading, result } = useRunSql(widget.sql, widget.shardKey ?? "");

    const onEditClick = (): void => {
        onEdit(widget.id);
    };

    const onRemoveClick = (): void => {
        onRemove(widget.id);
    };

    const onSuggestClick = (): void => {
        if (result !== undefined) {
            onSuggest?.(widget.id, result);
        }
    };

    return (
        <Card data-testid={`dashboards-widget-${widget.id}`}>
            <CardHeader className="flex flex-row items-start justify-between gap-2 border-b pb-3">
                <CardTitle className="min-w-0 truncate" title={widget.title}>
                    {widget.title}
                </CardTitle>
                <div className="flex shrink-0 items-center gap-1">
                    {onSuggest !== undefined && result !== undefined && (
                        <Button
                            aria-label={t("Suggest chart")}
                            data-testid={`dashboards-widget-suggest-${widget.id}`}
                            disabled={inferring}
                            onClick={onSuggestClick}
                            size="icon-xs"
                            title={inferring ? t("Suggesting…") : t("Suggest chart")}
                            type="button"
                            variant="ghost"
                        >
                            <svg
                                aria-hidden="true"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.6}
                                viewBox="0 0 24 24"
                            >
                                <path d="m12 3 1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3ZM18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9L18 15Z" />
                            </svg>
                        </Button>
                    )}
                    <Button
                        aria-label={t("Edit widget")}
                        data-testid={`dashboards-widget-edit-${widget.id}`}
                        onClick={onEditClick}
                        size="icon-xs"
                        title={t("Edit widget")}
                        type="button"
                        variant="ghost"
                    >
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M4 20h4L18 10l-4-4L4 16v4ZM14 6l4 4" />
                        </svg>
                    </Button>
                    <Button
                        aria-label={t("Remove widget")}
                        data-testid={`dashboards-widget-remove-${widget.id}`}
                        onClick={onRemoveClick}
                        size="icon-xs"
                        title={t("Remove widget")}
                        type="button"
                        variant="ghost"
                    >
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M5 7h14M9 7V5h6v2m-1 0v12H10V7M7 7v13h10V7" />
                        </svg>
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="min-h-32 py-2">
                {error !== undefined && (
                    <Alert className="font-mono text-xs" testId={`dashboards-widget-error-${widget.id}`} variant="destructive">
                        {error}
                    </Alert>
                )}
                {error === undefined && loading && result === undefined && (
                    <p className="p-4 text-sm text-muted-foreground" data-testid={`dashboards-widget-loading-${widget.id}`}>
                        {t("Running…")}
                    </p>
                )}
                {error === undefined && result !== undefined && <SqlResultChart axes={widget.chartAxes} kind={widget.chartKind} result={result} />}
            </CardContent>
        </Card>
    );
};

interface WidgetFormProps {
    readonly draft: WidgetDraft;
    readonly editing: boolean;
    readonly onCancel: () => void;
    readonly onChange: (draft: WidgetDraft) => void;
    readonly onSubmit: () => void;
}

/** The add/edit form: a title, a SQL textarea, a chart type, and an optional shard key. */
const WidgetForm = ({ draft, editing, onCancel, onChange, onSubmit }: WidgetFormProps): ReactElement => {
    const t = useT();

    const onTitleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        onChange({ ...draft, title: event.target.value });
    };
    const onSqlChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        onChange({ ...draft, sql: event.target.value });
    };
    const onShardChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        onChange({ ...draft, shardKey: event.target.value });
    };
    const onKindChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        onChange({ ...draft, chartKind: event.target.value as ChartKind });
    };
    const onSubmitClick = (): void => {
        onSubmit();
    };

    const canSave = draft.title.trim() !== "" && draft.sql.trim() !== "";

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
                <textarea
                    aria-label={t("SQL query")}
                    className="min-h-24 resize-y rounded-md border border-border bg-background p-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring"
                    data-testid="dashboards-form-sql"
                    onChange={onSqlChange}
                    placeholder="SELECT author, COUNT(*) AS messages FROM …"
                    spellCheck={false}
                    value={draft.sql}
                />
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
                <input
                    aria-label={t("Shard key (optional)")}
                    className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs outline-none focus-visible:border-ring"
                    data-testid="dashboards-form-shard"
                    onChange={onShardChange}
                    placeholder={t("Shard key (optional)")}
                    type="text"
                    value={draft.shardKey}
                />
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
 * The Dashboards panel: a single browser-persisted dashboard of chart widgets.
 * Each widget is a saved read-only SQL query, run through the `runSql` admin RPC
 * and charted with the studio's {@link SqlResultChart}. "Add widget" opens an
 * inline form (title + SQL + optional shard); each tile can be edited or removed.
 * The widget list persists to `localStorage`, mirroring the SQL editor's saved
 * queries, so a dashboard survives a reload without any server-side state.
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
            setDraft({ chartKind: found.chartKind ?? "bar", shardKey: found.shardKey ?? "", sql: found.sql, title: found.title });
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
            try {
                const inferred = await assistant.inferChart({ columns: result.columns, rowCount: result.rowCount });

                if (inferred !== undefined) {
                    setWidgets(applyInference(id, inferred));
                }
            } finally {
                setInferringId((current) => (current === id ? null : current));
            }
        };

        fireAndForget(apply());
    };

    const onRemove = (id: string): void => {
        setWidgets((current) => current.filter((widget) => widget.id !== id));
    };

    const onSubmit = (): void => {
        const title = draft.title.trim();
        const sql = draft.sql.trim();

        if (title === "" || sql === "") {
            return;
        }

        const shardKey = draft.shardKey.trim();

        const { chartKind } = draft;

        if (editingId === null) {
            setWidgets((current) => [...current, { chartKind, id: newId("w"), shardKey, sql, title }]);
        } else {
            setWidgets((current) => current.map((widget) => (widget.id === editingId ? { ...widget, chartKind, shardKey, sql, title } : widget)));
        }

        closeForm();
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-dashboards">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t("Chart widgets backed by saved read-only SQL queries.")}</p>
                {!formOpen && (
                    <Button data-testid="dashboards-add" onClick={openAdd} size="sm" type="button">
                        {t("Add widget")}
                    </Button>
                )}
            </div>

            {formOpen && <WidgetForm draft={draft} editing={editingId !== null} onCancel={closeForm} onChange={setDraft} onSubmit={onSubmit} />}

            {widgets.length === 0 && !formOpen ? (
                <EmptyState description={t("Add a widget to chart a saved SQL query on this browser.")} testId="dashboards-empty" title={t("No widgets yet")} />
            ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="dashboards-grid">
                    {widgets.map((widget) => (
                        <WidgetCard
                            inferring={inferringId === widget.id}
                            key={widget.id}
                            onEdit={onEdit}
                            onRemove={onRemove}
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
