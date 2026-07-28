import type { ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import type { DashboardPanel } from "../telemetry/dashboards";
import { DashboardBoard } from "./DashboardBoard";
import { COLUMN_LABEL, Field, FieldForm, FormError } from "./section-ui";
import type { SectionProps } from "./tabs";
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
 *
 * Hierarchy: the BOARD is the primary object, so the picker names it at reading
 * size while the panel count sits under it in the tertiary mono voice, and the
 * selected board's canvas takes the whole right column. Selection is marked by a
 * value step plus one edge rule — no chip, no colour — because a list of boards is
 * structurally identical rows and only one of them is current. Loading is bracket
 * text, not a skeleton.
 */
export const DashboardsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.dashboards.list>>): ReactElement => {
    const dashboards = usePreloadedQuery(preloaded);
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
        void update.mutate({ id: id as never, organizationId, panels }).catch((error_: unknown) => {
            setError(error_ instanceof Error ? error_.message : "could not save panels");
        });
    };

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div className="flex flex-col gap-1.5">
                        <CardTitle>Dashboards</CardTitle>
                        <CardDescription>
                            Saved boards over your telemetry. Compose panels from the metrics the console already collects — a trend sparkline, a single stat,
                            or a saved Traces/Logs shortcut. Panel windows follow the shared time range above.
                        </CardDescription>
                    </div>
                    <TimeRangePicker />
                </CardHeader>
                <CardContent>
                    <FieldForm
                        action={() => {
                            setError(null);

                            void create
                                .mutate({ name, organizationId })
                                .then((id) => {
                                    setSelectedId(id);
                                    setName("");
                                })
                                .catch((error_: unknown) => {
                                    setError(error_ instanceof Error ? error_.message : "could not create dashboard");
                                });
                        }}
                    >
                        <Field htmlFor="dashboard-name" label="Dashboard name">
                            <Input
                                id="dashboard-name"
                                onChange={(event) => {
                                    setName(event.target.value);
                                }}
                                placeholder="New dashboard name"
                                required
                                value={name}
                            />
                        </Field>
                        <Button className="justify-self-start" type="submit">
                            Create dashboard
                        </Button>
                        <FormError message={error} />
                    </FieldForm>
                </CardContent>
            </Card>

            {dashboards === undefined ? (
                <Card>
                    <CardContent className={cn(COLUMN_LABEL, "text-muted-foreground py-8 text-center")}>[Loading…]</CardContent>
                </Card>
            ) : null}

            {dashboards?.length === 0 ? (
                <Card>
                    <CardContent className="text-muted-foreground py-8 text-center text-sm">
                        No dashboards yet — create one above, then add panels to it.
                    </CardContent>
                </Card>
            ) : null}

            {dashboards !== undefined && dashboards.length > 0 ? (
                <div className="grid gap-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:items-start">
                    <nav aria-label="Dashboards" className="flex flex-col border border-border">
                        {dashboards.map((board) => (
                            <button
                                className={cn(
                                    "flex cursor-pointer flex-col gap-1 border-b border-border border-l-2 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent",
                                    board._id === selected?._id ? "border-l-foreground bg-accent" : "border-l-transparent",
                                )}
                                key={board._id}
                                onClick={() => {
                                    setSelectedId(board._id);
                                }}
                                type="button"
                            >
                                <span className="truncate text-sm font-medium">{board.name}</span>
                                <span className={cn(COLUMN_LABEL, "text-muted-foreground tabular-nums")}>
                                    {board.panels.length} panel{board.panels.length === 1 ? "" : "s"}
                                </span>
                            </button>
                        ))}
                    </nav>

                    {selected ? (
                        <DashboardBoard
                            metricNames={metricNames}
                            name={selected.name}
                            onRemoveDashboard={() => {
                                setError(null);
                                void remove.mutate({ id: selected._id, organizationId }).catch((error_: unknown) => {
                                    setError(error_ instanceof Error ? error_.message : "could not delete dashboard");
                                });
                            }}
                            onUpdatePanels={(panels) => {
                                persistPanels(selected._id, panels);
                            }}
                            panels={selected.panels}
                            series={series}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};
