import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import { newId, usePersistedList } from "./browser-storage";
import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { EmptyState } from "./components/ui/empty-state";
import { useT } from "./i18n-context";
import SqlResultChart from "./result-chart";
import { useRunSql } from "./use-run-sql";

interface DashboardsPanelProps {
    /** Shard key new widgets default to. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** One browser-persisted chart widget on the dashboard. */
interface Widget {
    readonly id: string;
    /** Optional shard key the widget's query runs against; empty/absent → root shard. */
    readonly shardKey?: string;
    readonly sql: string;
    readonly title: string;
}

/** Draft state for the add/edit form. */
interface WidgetDraft {
    readonly shardKey: string;
    readonly sql: string;
    readonly title: string;
}

const STORAGE_KEY = "cirrus-studio-dashboards";
const EMPTY_DRAFT: WidgetDraft = { shardKey: "", sql: "", title: "" };

interface WidgetCardProps {
    readonly onEdit: (id: string) => void;
    readonly onRemove: (id: string) => void;
    readonly widget: Widget;
}

/**
 * One dashboard tile: a titled card that runs its saved SQL on mount (and when
 * the SQL/shard changes) via the read-only `runSql` admin RPC and charts the
 * result with {@link SqlResultChart}. A failed query renders its message inline
 * rather than throwing, so one broken widget never blanks the grid.
 */
const WidgetCard = ({ onEdit, onRemove, widget }: WidgetCardProps): ReactElement => {
    const t = useT();

    // The shared run/cancel hook owns the query lifecycle; the card is otherwise
    // purely presentational. It re-runs whenever the widget's SQL or shard changes.
    const { error, loading, result } = useRunSql(widget.sql, widget.shardKey ?? "");

    const onEditClick = useCallback((): void => {
        onEdit(widget.id);
    }, [onEdit, widget.id]);

    const onRemoveClick = useCallback((): void => {
        onRemove(widget.id);
    }, [onRemove, widget.id]);

    return (
        <Card className="rounded-md" data-testid={`dashboards-widget-${widget.id}`}>
            <CardHeader className="flex flex-row items-start justify-between gap-2 border-b pb-3">
                <CardTitle className="min-w-0 truncate" title={widget.title}>
                    {widget.title}
                </CardTitle>
                <div className="flex shrink-0 items-center gap-1">
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
                {error === undefined && result !== undefined && <SqlResultChart result={result} />}
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

/** The add/edit form: a title, a SQL textarea, and an optional shard key. */
const WidgetForm = ({ draft, editing, onCancel, onChange, onSubmit }: WidgetFormProps): ReactElement => {
    const t = useT();

    const onTitleChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>): void => {
            onChange({ ...draft, title: event.target.value });
        },
        [draft, onChange],
    );
    const onSqlChange = useCallback(
        (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
            onChange({ ...draft, sql: event.target.value });
        },
        [draft, onChange],
    );
    const onShardChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>): void => {
            onChange({ ...draft, shardKey: event.target.value });
        },
        [draft, onChange],
    );
    const onSubmitClick = useCallback((): void => {
        onSubmit();
    }, [onSubmit]);

    const canSave = draft.title.trim() !== "" && draft.sql.trim() !== "";

    return (
        <Card className="rounded-md" data-testid="dashboards-form">
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

    const openAdd = useCallback((): void => {
        setEditingId(null);
        setDraft({ ...EMPTY_DRAFT, shardKey: initialShardKey ?? "" });
        setFormOpen(true);
    }, [initialShardKey]);

    const closeForm = useCallback((): void => {
        setFormOpen(false);
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
    }, []);

    const onEdit = useCallback(
        (id: string): void => {
            const found = widgets.find((widget) => widget.id === id);

            if (found !== undefined) {
                setEditingId(id);
                setDraft({ shardKey: found.shardKey ?? "", sql: found.sql, title: found.title });
                setFormOpen(true);
            }
        },
        [widgets],
    );

    const onRemove = useCallback(
        (id: string): void => {
            setWidgets((current) => current.filter((widget) => widget.id !== id));
        },
        [setWidgets],
    );

    const onSubmit = useCallback((): void => {
        const title = draft.title.trim();
        const sql = draft.sql.trim();

        if (title === "" || sql === "") {
            return;
        }

        const shardKey = draft.shardKey.trim();

        if (editingId === null) {
            setWidgets((current) => [...current, { id: newId("w"), shardKey, sql, title }]);
        } else {
            setWidgets((current) => current.map((widget) => (widget.id === editingId ? { ...widget, shardKey, sql, title } : widget)));
        }

        closeForm();
    }, [closeForm, draft, editingId, setWidgets]);

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-dashboards">
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
                        <WidgetCard key={widget.id} onEdit={onEdit} onRemove={onRemove} widget={widget} />
                    ))}
                </div>
            )}
        </div>
    );
};

export default DashboardsPanel;

export type { DashboardsPanelProps };
