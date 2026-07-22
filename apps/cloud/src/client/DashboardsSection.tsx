import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import type { DashboardPanel } from "../telemetry/dashboards";
import { api } from "../../lunora/_generated/api.js";
import { DashboardBoard } from "./DashboardBoard";
import type { SectionProps } from "./OrganizationDashboard";
import { TimeRangePicker, useTimeRange } from "./TimeRangeProvider";
import { useMetricsSeries } from "./use-metrics-series";

/**
 * Dashboards tab (Tier 2 observability) — user-defined, Grafana-style boards over
 * the org's telemetry. A dashboard is a named list of panels; each panel is a
 * saved query over data the console already serves (`metrics.list`, or a saved
 * Traces/Logs deep-link). Owners/admins create boards and edit panels; the metric
 * series backing every metric/stat panel is fetched once here and shared down.
 *
 * The selected board is *derived* (the clicked id, falling back to the first),
 * never synced through an effect — a deleted board just falls back, and creating
 * one selects it from the mutation's resolve (an event handler). Panel edits are
 * pure reducers (`DashboardBoard`) whose result is persisted via `update`.
 */
export const DashboardsSection = ({ onOpenTab, organizationId }: SectionProps): ReactElement => {
    const dashboards = useQuery(api.dashboards.list, { organizationId });
    const { from, to } = useTimeRange();
    const { series } = useMetricsSeries(organizationId, from, to);

    const create = useMutation(api.dashboards.create);
    const update = useMutation(api.dashboards.update);
    const remove = useMutation(api.dashboards.remove);

    const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
    const [name, setName] = useState("");
    const [error, setError] = useState<null | string>(null);

    const metricNames = series === undefined ? [] : series.map((metric) => metric.name);
    const selected = dashboards?.find((board) => board._id === selectedId) ?? dashboards?.[0];

    const persistPanels = (id: string, panels: DashboardPanel[]): void => {
        setError(null);
        void update.mutate({ id: id as never, organizationId, panels }).catch((caught: unknown) => {
            setError(caught instanceof Error ? caught.message : "could not save panels");
        });
    };

    return (
        <div className="stack">
            <section className="card">
                <div className="metrics-head">
                    <h3>Dashboards</h3>
                    <TimeRangePicker />
                </div>
                <p className="muted">
                    Saved boards over your telemetry. Compose panels from the metrics the console already collects — a trend sparkline, a single stat, or a
                    saved Traces/Logs shortcut. Panel windows follow the shared time range above.
                </p>
                <form
                    className="inline-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setError(null);

                        void create
                            .mutate({ name, organizationId })
                            .then((id) => {
                                setSelectedId(id as unknown as string);
                                setName("");
                            })
                            .catch((caught: unknown) => {
                                setError(caught instanceof Error ? caught.message : "could not create dashboard");
                            });
                    }}
                >
                    <input
                        aria-label="Dashboard name"
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                        placeholder="New dashboard name"
                        required
                        value={name}
                    />
                    <button className="primary" type="submit">
                        Create dashboard
                    </button>
                    {error ? (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </form>
            </section>

            {dashboards === undefined ? <p className="muted">Loading…</p> : null}

            {dashboards !== undefined && dashboards.length === 0 ? (
                <section className="card">
                    <p className="muted">No dashboards yet — create one above, then add panels to it.</p>
                </section>
            ) : null}

            {dashboards !== undefined && dashboards.length > 0 ? (
                <div className="dash-layout">
                    <nav aria-label="Dashboards" className="dash-list">
                        {dashboards.map((board) => (
                            <button
                                className={board._id === selected?._id ? "dash-list-item active" : "dash-list-item"}
                                key={board._id}
                                onClick={() => setSelectedId(board._id)}
                                type="button"
                            >
                                <span className="row-title">{board.name}</span>
                                <span className="muted">
                                    {board.panels.length} panel{board.panels.length === 1 ? "" : "s"}
                                </span>
                            </button>
                        ))}
                    </nav>

                    {selected ? (
                        <DashboardBoard
                            metricNames={metricNames}
                            name={selected.name}
                            onOpenTab={onOpenTab}
                            onRemoveDashboard={() => {
                                setError(null);
                                void remove.mutate({ id: selected._id, organizationId }).catch((caught: unknown) => {
                                    setError(caught instanceof Error ? caught.message : "could not delete dashboard");
                                });
                            }}
                            onUpdatePanels={(panels) => persistPanels(selected._id, panels)}
                            panels={selected.panels}
                            series={series}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};
