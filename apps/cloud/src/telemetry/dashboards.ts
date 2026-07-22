/**
 * Pure model for **user-defined custom dashboards** (Tier 2 observability). A
 * dashboard is a named, per-org list of panels; each panel is a saved query over
 * telemetry the console already serves — a metric trend sparkline, a single-stat
 * number, or a saved Traces/Logs filter shortcut. No new backend: `metric`/`stat`
 * panels read `metrics.list`, the shortcut panels deep-link the Traces/Logs tabs.
 *
 * This module is the shared, side-effect-free core: the panel types, the CRUD
 * reducers the client mutates panels with (add/remove/reorder are pure array
 * transforms), the per-kind config normalizer, validation, and the stat
 * aggregation. Both `lunora/dashboards.ts` (server validation + wire view) and
 * `DashboardsSection` (the editor) import it, so the shaping is unit-tested once
 * and can't drift between the two.
 */

/** Panel widget kinds. `metric`/`stat` render metric data; `traces`/`logs` are saved-filter shortcuts. */
export type PanelKind = "logs" | "metric" | "stat" | "traces";

/** How a `stat` panel reduces its metric series to one number. */
export type StatAggregation = "count" | "first" | "last";

/** Panel configuration — only the keys the panel's kind uses are set. */
export interface PanelConfig {
    /** `traces`/`logs`: the saved free-text filter the shortcut deep-links with. */
    filter?: string;
    /** `metric`/`stat`: which `ctx.metrics.*` series the panel renders. */
    metricName?: string;
    /** `stat`: which value of the series to show (defaults to `last`). */
    stat?: StatAggregation;
}

/** One saved panel on a dashboard. */
export interface DashboardPanel {
    config: PanelConfig;
    id: string;
    kind: PanelKind;
    title: string;
}

/** The panel kinds, in the order the editor offers them. */
export const PANEL_KINDS: readonly PanelKind[] = ["metric", "stat", "traces", "logs"];

/** Human labels for each panel kind (editor dropdown + widget headers). */
export const PANEL_KIND_LABELS: Record<PanelKind, string> = {
    logs: "Logs shortcut",
    metric: "Metric trend",
    stat: "Single stat",
    traces: "Traces shortcut",
};

/** The stat aggregations, in the order the editor offers them. */
export const STAT_AGGREGATIONS: readonly StatAggregation[] = ["last", "first", "count"];

/** Human labels for each stat aggregation. */
export const STAT_AGGREGATION_LABELS: Record<StatAggregation, string> = {
    count: "Data points",
    first: "First value",
    last: "Latest value",
};

/** `true` for the two kinds that render a metric series (`metric`, `stat`). */
export const isMetricPanel = (kind: PanelKind): boolean => kind === "metric" || kind === "stat";

/**
 * Reduce a raw config to only the keys the kind uses, so a config never carries
 * a stale `metricName` after switching to a shortcut (or a stray `filter` on a
 * metric panel). A `stat` panel always keeps a defined aggregation (`last`).
 */
export const normalizePanelConfig = (kind: PanelKind, raw: PanelConfig): PanelConfig => {
    if (kind === "metric") {
        return raw.metricName === undefined || raw.metricName === "" ? {} : { metricName: raw.metricName };
    }

    if (kind === "stat") {
        return {
            stat: raw.stat ?? "last",
            ...(raw.metricName === undefined || raw.metricName === "" ? {} : { metricName: raw.metricName }),
        };
    }

    // traces / logs shortcut: only the saved filter, and only when non-empty.
    return raw.filter === undefined || raw.filter.trim() === "" ? {} : { filter: raw.filter.trim() };
};

/**
 * Build a panel from editor input. `id` is passed in (the caller mints it in an
 * event handler, keeping this pure and testable); the title falls back to the
 * kind label when blank, and the config is normalized to the kind.
 */
export const createPanel = (input: { config: PanelConfig; id: string; kind: PanelKind; title: string }): DashboardPanel => {
    const title = input.title.trim();

    return {
        config: normalizePanelConfig(input.kind, input.config),
        id: input.id,
        kind: input.kind,
        title: title === "" ? PANEL_KIND_LABELS[input.kind] : title,
    };
};

/** Append a panel to a board (immutably). */
export const addPanel = (panels: readonly DashboardPanel[], panel: DashboardPanel): DashboardPanel[] => [...panels, panel];

/** Remove the panel with `id` from a board (immutably); a no-op when absent. */
export const removePanel = (panels: readonly DashboardPanel[], id: string): DashboardPanel[] => panels.filter((panel) => panel.id !== id);

/**
 * Move a panel one slot toward the front (`up`) or back (`down`) by swapping it
 * with its neighbor. Clamped at the ends (moving the first panel up, or the last
 * down, returns an unchanged copy) and a no-op for an unknown id.
 */
export const movePanel = (panels: readonly DashboardPanel[], id: string, direction: "down" | "up"): DashboardPanel[] => {
    const index = panels.findIndex((panel) => panel.id === id);

    if (index === -1) {
        return [...panels];
    }

    const target = direction === "up" ? index - 1 : index + 1;

    if (target < 0 || target >= panels.length) {
        return [...panels];
    }

    const next = [...panels];

    [next[index], next[target]] = [next[target], next[index]];

    return next;
};

/**
 * Validate a single panel, returning a human error string or `null` when valid.
 * Metric and stat panels require a metric name; shortcut panels are always valid
 * (an empty filter simply deep-links the tab with no pre-set filter).
 */
export const validatePanel = (panel: DashboardPanel): null | string => {
    if (isMetricPanel(panel.kind) && (panel.config.metricName === undefined || panel.config.metricName === "")) {
        return `${PANEL_KIND_LABELS[panel.kind]} panel "${panel.title}" needs a metric name`;
    }

    return null;
};

/** Validate every panel on a board; returns the first error, or `null` when all are valid. */
export const validatePanels = (panels: readonly DashboardPanel[]): null | string => {
    for (const panel of panels) {
        const error = validatePanel(panel);

        if (error !== null) {
            return error;
        }
    }

    return null;
};

/** Minimal shape of a metric series a stat panel reduces (decoupled from `metrics-read`). */
export interface MetricSeriesLike {
    firstValue: number;
    lastValue: number;
    name: string;
    points: readonly unknown[];
}

/**
 * Reduce the metric series a `stat` panel points at to its single number, per the
 * panel's aggregation (`last`/`first`/`count`). Returns `undefined` when the
 * panel has no metric name or the named series isn't in the window (so the widget
 * can render a "no data" state rather than a misleading zero).
 */
export const statValue = (series: readonly MetricSeriesLike[], panel: DashboardPanel): number | undefined => {
    if (panel.config.metricName === undefined || panel.config.metricName === "") {
        return undefined;
    }

    const match = series.find((candidate) => candidate.name === panel.config.metricName);

    if (match === undefined) {
        return undefined;
    }

    switch (panel.config.stat ?? "last") {
        case "count": {
            return match.points.length;
        }
        case "first": {
            return match.firstValue;
        }
        default: {
            return match.lastValue;
        }
    }
};
