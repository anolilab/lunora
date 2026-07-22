import type { ReactElement } from "react";
import { useState } from "react";

import type { DashboardPanel, PanelKind, StatAggregation } from "../telemetry/dashboards";
import { createPanel, isMetricPanel, PANEL_KIND_LABELS, PANEL_KINDS, STAT_AGGREGATION_LABELS, STAT_AGGREGATIONS } from "../telemetry/dashboards";

interface AddPanelFormProps {
    /** Metric names to offer as suggestions for metric/stat panels. */
    metricNames: readonly string[];
    /** Append the built panel to the board. */
    onAdd: (panel: DashboardPanel) => void;
}

/**
 * The add-panel form for a dashboard. Picks a kind and its kind-specific config
 * (a metric name for metric/stat, an aggregation for stat, a saved filter for the
 * Traces/Logs shortcuts), then builds a validated panel with the pure model. The
 * panel id is minted in the submit handler (an event handler — the sanctioned
 * place for impurity), never in render.
 */
export const AddPanelForm = ({ metricNames, onAdd }: AddPanelFormProps): ReactElement => {
    const [title, setTitle] = useState("");
    const [kind, setKind] = useState<PanelKind>("metric");
    const [metricName, setMetricName] = useState("");
    const [stat, setStat] = useState<StatAggregation>("last");
    const [filter, setFilter] = useState("");
    const [error, setError] = useState<null | string>(null);

    const usesMetric = isMetricPanel(kind);

    return (
        <form
            className="inline-form"
            onSubmit={(event) => {
                event.preventDefault();
                setError(null);

                if (usesMetric && metricName.trim() === "") {
                    setError("Pick a metric for this panel.");

                    return;
                }

                onAdd(
                    createPanel({
                        config: { filter, metricName, stat },
                        id: crypto.randomUUID(),
                        kind,
                        title,
                    }),
                );
                setTitle("");
                setMetricName("");
                setFilter("");
            }}
        >
            <input
                aria-label="Panel title"
                onChange={(event) => {
                    setTitle(event.target.value);
                }}
                placeholder="Panel title"
                value={title}
            />
            <select
                aria-label="Panel kind"
                onChange={(event) => {
                    setKind(event.target.value as PanelKind);
                }}
                value={kind}
            >
                {PANEL_KINDS.map((value) => (
                    <option key={value} value={value}>
                        {PANEL_KIND_LABELS[value]}
                    </option>
                ))}
            </select>
            {usesMetric ? (
                <>
                    <input
                        aria-label="Metric name"
                        list="dashboard-metric-names"
                        onChange={(event) => {
                            setMetricName(event.target.value);
                        }}
                        placeholder="metric name"
                        value={metricName}
                    />
                    <datalist id="dashboard-metric-names">
                        {metricNames.map((name) => (
                            <option key={name} value={name} />
                        ))}
                    </datalist>
                </>
            ) : null}
            {kind === "stat" ? (
                <select
                    aria-label="Stat aggregation"
                    onChange={(event) => {
                        setStat(event.target.value as StatAggregation);
                    }}
                    value={stat}
                >
                    {STAT_AGGREGATIONS.map((value) => (
                        <option key={value} value={value}>
                            {STAT_AGGREGATION_LABELS[value]}
                        </option>
                    ))}
                </select>
            ) : null}
            {usesMetric ? null : (
                <input
                    aria-label="Saved filter"
                    onChange={(event) => {
                        setFilter(event.target.value);
                    }}
                    placeholder="saved filter (optional)"
                    value={filter}
                />
            )}
            <button className="primary" type="submit">
                Add panel
            </button>
            {error ? (
                <p className="error" role="alert">
                    {error}
                </p>
            ) : null}
        </form>
    );
};
