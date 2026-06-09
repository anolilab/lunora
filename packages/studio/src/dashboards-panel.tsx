import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import type { SqlConsoleResult } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { EmptyState } from "./components/ui/empty-state";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";
import SqlResultChart from "./result-chart";

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

const RUN_SQL = adminRef(ADMIN_FUNCTIONS.runSql);
const STORAGE_KEY = "cirrus-studio-dashboards";
const EMPTY_DRAFT: WidgetDraft = { shardKey: "", sql: "", title: "" };

/** Read the persisted widget list (browser-local, best-effort). */
const loadWidgets = (): Widget[] => {
    if (!("localStorage" in globalThis)) {
        return [];
    }

    try {
        const raw = globalThis.localStorage.getItem(STORAGE_KEY);
        const parsed = raw === null ? [] : (JSON.parse(raw) as unknown);

        return Array.isArray(parsed) ? (parsed as Widget[]) : [];
    } catch {
        return [];
    }
};

/** A best-effort unique id for a new widget. */
const newId = (): string =>
    (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.() ?? `w-${globalThis.performance.now().toString(36)}`;

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
    const client = useCirrus();
    const t = useT();

    const [result, setResult] = useState<null | SqlConsoleResult>(null);
    const [error, setError] = useState<null | string>(null);
    const [loading, setLoading] = useState<boolean>(true);

    // Run the widget's query. Kept in a callback (not inline in the effect) so the
    // setState calls aren't flagged as synchronous effect writes; the `token` lets
    // a re-run/unmount discard a stale in-flight result.
    const run = useCallback(
        async (token: { cancelled: boolean }): Promise<void> => {
            setLoading(true);

            try {
                const next = (await client.query(RUN_SQL, { sql: widget.sql }, callOptions(widget.shardKey ?? ""))) as SqlConsoleResult;

                if (!token.cancelled) {
                    setResult(next);
                    setError(null);
                }
            } catch (error_) {
                if (!token.cancelled) {
                    setResult(null);
                    setError(errorMessage(error_));
                }
            } finally {
                if (!token.cancelled) {
                    setLoading(false);
                }
            }
        },
        [client, widget.sql, widget.shardKey],
    );

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(run(token));

        return () => {
            token.cancelled = true;
        };
    }, [run]);

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
                {error !== null && (
                    <p
                        className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive"
                        data-testid={`dashboards-widget-error-${widget.id}`}
                        role="alert"
                    >
                        {error}
                    </p>
                )}
                {error === null && loading && result === null && (
                    <p className="p-4 text-sm text-muted-foreground" data-testid={`dashboards-widget-loading-${widget.id}`}>
                        {t("Running…")}
                    </p>
                )}
                {error === null && result !== null && <SqlResultChart result={result} />}
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

    const [widgets, setWidgets] = useState<Widget[]>(loadWidgets);
    const [draft, setDraft] = useState<WidgetDraft>(EMPTY_DRAFT);
    const [editingId, setEditingId] = useState<null | string>(null);
    const [formOpen, setFormOpen] = useState<boolean>(false);

    // Persist the widget list to the browser whenever it changes.
    useEffect(() => {
        if ("localStorage" in globalThis) {
            globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
        }
    }, [widgets]);

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

    const onRemove = useCallback((id: string): void => {
        setWidgets((current) => current.filter((widget) => widget.id !== id));
    }, []);

    const onSubmit = useCallback((): void => {
        const title = draft.title.trim();
        const sql = draft.sql.trim();

        if (title === "" || sql === "") {
            return;
        }

        const shardKey = draft.shardKey.trim();

        if (editingId === null) {
            setWidgets((current) => [...current, { id: newId(), shardKey, sql, title }]);
        } else {
            setWidgets((current) => current.map((widget) => (widget.id === editingId ? { ...widget, shardKey, sql, title } : widget)));
        }

        closeForm();
    }, [closeForm, draft, editingId]);

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
                <EmptyState
                    description={t("Add a widget to chart a saved SQL query on this browser.")}
                    testId="dashboards-empty"
                    title={t("No widgets yet")}
                />
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
