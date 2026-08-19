import type { ReactElement, ReactNode, RefObject } from "react";

import SqlResultChart from "../../components/result-chart";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { useT } from "../../i18n/i18n-context";
import type { AssistantChartConfig, SqlConsoleResult } from "../../lib/admin";
import { formatCell } from "../../lib/internal";
import { useRunSql } from "../sql/hooks/use-run-sql";
import SqlResultTable from "../sql/sql-result-table";

/** The three shapes {@link SqlResultChart} can draw. */
type ChartKind = AssistantChartConfig["kind"];

/**
 * What a dashboard tile IS. Three of the four run the widget's SQL and differ
 * only in how they render the result; `text` runs nothing at all, which is why
 * the two card components below are separate rather than one with a branch — a
 * text tile must not mount the query hook.
 */
type WidgetKind = "chart" | "kpi" | "table" | "text";

/**
 * One browser-persisted tile on the dashboard.
 *
 * The two chart fields have different writers and are deliberately separate.
 * `chartKind` is the operator's pick and is the only thing the form edits;
 * `chartAxes` is whatever "Suggest chart" last inferred. Keeping them apart is
 * what lets an operator say "keep those columns, but draw it as an area" —
 * folding them into one config would make every pick discard the columns.
 *
 * Every field added after the first release is optional, so a widget saved
 * before it existed reads back as what it already was: no `kind` is the chart
 * tile that was once the only kind.
 */
interface Widget {
    /** Columns last inferred by the assistant, when it has been asked. */
    readonly chartAxes?: AssistantChartConfig;
    /** The shape the operator picked; absent → heuristic (see {@link SqlResultChart}). */
    readonly chartKind?: ChartKind;
    readonly id: string;
    /** What this tile is; absent → `chart`, the only kind that used to exist. */
    readonly kind?: WidgetKind;
    /** Optional shard key the widget's query runs against; empty/absent → root shard. */
    readonly shardKey?: string;
    readonly sql: string;
    /** The body of a `text` tile. Unused by every other kind. */
    readonly text?: string;
    readonly title: string;
}

/** Accepting a drop requires cancelling the default. Module scope: it closes over nothing. */
const allowDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
};

/** A widget's kind, defaulting the tiles saved before there was more than one. */
const widgetKind = (widget: Widget): WidgetKind => widget.kind ?? "chart";

interface FrameProps {
    /** Extra header controls (the suggest button), rendered before edit/remove. */
    readonly actions?: ReactNode;
    readonly children: ReactNode;
    /** Carries the drag source between a dragstart and the drop that reads it. */
    readonly draggedRef: RefObject<null | string>;
    readonly onEdit: (id: string) => void;
    readonly onRemove: (id: string) => void;
    /** Move the dragged widget to sit before this one. */
    readonly onReorder: (from: string, to: string) => void;
    readonly widget: Widget;
}

/**
 * The chrome every tile shares: the title, the edit/remove controls, and the
 * drag handling that reorders the dashboard. Kind-specific rendering is the
 * `children`.
 *
 * Reordering writes straight through to the persisted list rather than keeping a
 * separate order array — there is one list, and a second one would be a second
 * thing to keep in step for no benefit at this size.
 */
const WidgetFrame = ({ actions, children, draggedRef, onEdit, onRemove, onReorder, widget }: FrameProps): ReactElement => {
    const t = useT();

    const onEditClick = (): void => {
        onEdit(widget.id);
    };

    const onRemoveClick = (): void => {
        onRemove(widget.id);
    };

    const onDragStart = (): void => {
        // eslint-disable-next-line no-param-reassign -- a ref's `.current` is mutable by design; it carries the drag source across handlers
        draggedRef.current = widget.id;
    };

    const onDrop = (): void => {
        const from = draggedRef.current;

        // eslint-disable-next-line no-param-reassign -- clearing the drag ref after the drop; refs are mutable by design
        draggedRef.current = null;

        if (from !== null && from !== widget.id) {
            onReorder(from, widget.id);
        }
    };

    return (
        <Card data-testid={`dashboards-widget-${widget.id}`} draggable onDragOver={allowDrop} onDragStart={onDragStart} onDrop={onDrop}>
            <CardHeader className="flex flex-row items-start justify-between gap-2 border-b pb-3">
                <CardTitle className="min-w-0 cursor-grab truncate" title={widget.title}>
                    {widget.title}
                </CardTitle>
                <div className="flex shrink-0 items-center gap-1">
                    {actions}
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
            <CardContent className="min-h-32 py-2">{children}</CardContent>
        </Card>
    );
};

/**
 * The single headline number of a `kpi` tile: the first cell of the first row.
 *
 * Deliberately positional rather than named — a KPI query is written to return
 * one value, and asking the operator to also name the column would be a second
 * field that can only ever disagree with the query they just wrote.
 */
const KpiValue = ({ result }: { readonly result: SqlConsoleResult }): ReactElement => {
    const t = useT();
    const column = result.columns[0];
    const cell = column === undefined ? undefined : result.rows[0]?.[column];

    return (
        <div className="flex h-full flex-col justify-center gap-1 p-4" data-testid="dashboards-kpi">
            <p className="truncate font-mono text-3xl font-semibold text-foreground">{cell === undefined ? t("—") : formatCell(cell)}</p>
            {column !== undefined && <p className="truncate text-xs text-muted-foreground">{column}</p>}
        </div>
    );
};

/** Everything a tile card needs regardless of kind. */
interface CardProps {
    /** Carries the drag source between a dragstart and the drop that reads it. */
    readonly draggedRef: RefObject<null | string>;
    /** True while THIS card's suggestion is in flight — the panel tracks it per widget. */
    readonly inferring: boolean;
    readonly onEdit: (id: string) => void;
    readonly onRemove: (id: string) => void;
    /** Move the dragged widget to sit before this one. */
    readonly onReorder: (from: string, to: string) => void;
    /** Absent when the deployment has no AI binding, which is what hides the affordance. */
    readonly onSuggest?: (id: string, result: SqlConsoleResult) => void;
    readonly widget: Widget;
}

/** A `text` tile: the operator's own note, no query involved. */
const TextWidgetCard = ({ draggedRef, onEdit, onRemove, onReorder, widget }: Omit<CardProps, "inferring" | "onSuggest">): ReactElement => (
    <WidgetFrame draggedRef={draggedRef} onEdit={onEdit} onRemove={onRemove} onReorder={onReorder} widget={widget}>
        {/* Plain text, not markdown: the studio ships no markdown renderer and a
            dashboard note does not justify adding one. `whitespace-pre-wrap` keeps
            the operator's own line breaks, which is most of what they wanted. */}
        <p className="p-2 text-sm whitespace-pre-wrap text-muted-foreground" data-testid="dashboards-text">
            {widget.text ?? ""}
        </p>
    </WidgetFrame>
);

/**
 * A tile that runs its saved SQL on mount (and when the SQL/shard changes) via
 * the read-only `runSql` admin RPC, then renders the result as a chart, a single
 * number, or a table. A failed query renders its message inline rather than
 * throwing, so one broken widget never blanks the grid.
 *
 * The suggest affordance lives HERE rather than in the form because this is the
 * only place that holds a result: inferring a chart needs the result's column
 * shape, and the form has never run the query it is editing.
 */
const QueryWidgetCard = ({ draggedRef, inferring, onEdit, onRemove, onReorder, onSuggest, widget }: CardProps): ReactElement => {
    const t = useT();

    // The shared run/cancel hook owns the query lifecycle; the card is otherwise
    // purely presentational. It re-runs whenever the widget's SQL or shard changes.
    const { error, loading, result } = useRunSql(widget.sql, widget.shardKey ?? "");
    const kind = widgetKind(widget);

    const onSuggestClick = (): void => {
        if (result !== undefined) {
            onSuggest?.(widget.id, result);
        }
    };

    // Only a chart tile has a shape to infer; a KPI and a table have one reading each.
    const suggest =
        kind === "chart" && onSuggest !== undefined && result !== undefined ? (
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
                <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} viewBox="0 0 24 24">
                    <path d="m12 3 1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3ZM18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9L18 15Z" />
                </svg>
            </Button>
        ) : undefined;

    return (
        <WidgetFrame actions={suggest} draggedRef={draggedRef} onEdit={onEdit} onRemove={onRemove} onReorder={onReorder} widget={widget}>
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
            {error === undefined && result !== undefined && kind === "chart" && (
                <SqlResultChart axes={widget.chartAxes} kind={widget.chartKind} result={result} />
            )}
            {error === undefined && result !== undefined && kind === "kpi" && <KpiValue result={result} />}
            {error === undefined && result !== undefined && kind === "table" && (
                <div className="max-h-72 overflow-auto">
                    <SqlResultTable result={result} />
                </div>
            )}
        </WidgetFrame>
    );
};

/** One tile, dispatched on its kind. */
const DashboardWidgetCard = ({ draggedRef, inferring, onEdit, onRemove, onReorder, onSuggest, widget }: CardProps): ReactElement =>
    widgetKind(widget) === "text" ? (
        <TextWidgetCard draggedRef={draggedRef} onEdit={onEdit} onRemove={onRemove} onReorder={onReorder} widget={widget} />
    ) : (
        <QueryWidgetCard
            draggedRef={draggedRef}
            inferring={inferring}
            onEdit={onEdit}
            onRemove={onRemove}
            onReorder={onReorder}
            onSuggest={onSuggest}
            widget={widget}
        />
    );

export { DashboardWidgetCard, widgetKind };
export type { ChartKind, Widget, WidgetKind };
