import type { ReactElement } from "react";

import type { DashboardPanel } from "../telemetry/dashboards";
import { movePanel, PANEL_KIND_LABELS, removePanel } from "../telemetry/dashboards";
import { AddPanelForm } from "./AddPanelForm";
import { PanelWidget } from "./DashboardPanel";
import type { MetricSeries } from "./use-metrics-series";

interface DashboardBoardProps {
    metricNames: ReadonlyArray<string>;
    name: string;
    onRemoveDashboard: () => void;
    /** Persist a new ordered panel list (the reducers compute it; the parent mutates). */
    onUpdatePanels: (panels: DashboardPanel[]) => void;
    panels: ReadonlyArray<DashboardPanel>;
}

/** One panel tile — its widget body plus the reorder/remove chrome. */
const PanelCard = ({
    isFirst,
    isLast,
    onMove,
    onRemove,
    panel,
    series,
}: {
    isFirst: boolean;
    isLast: boolean;
    onMove: (direction: "down" | "up") => void;
    onRemove: () => void;
    panel: DashboardPanel;
    series: MetricSeries[] | undefined;
}): ReactElement => (
    <div className="card dash-panel">
        <div className="dash-panel-head">
            <div className="dash-panel-id">
                <span className="row-title">{panel.title}</span>
                <span className="metric-kind">{PANEL_KIND_LABELS[panel.kind]}</span>
            </div>
            <div className="dash-panel-controls">
                <button
                    aria-label="Move panel up"
                    className="link"
                    disabled={isFirst}
                    onClick={() => {
                        onMove("up");
                    }}
                    type="button"
                >
                    ↑
                </button>
                <button
                    aria-label="Move panel down"
                    className="link"
                    disabled={isLast}
                    onClick={() => {
                        onMove("down");
                    }}
                    type="button"
                >
                    ↓
                </button>
                <button aria-label="Remove panel" className="link danger" onClick={onRemove} type="button">
                    ✕
                </button>
            </div>
        </div>
        <PanelWidget panel={panel} series={series} />
    </div>
);

/**
 * The selected dashboard's board: a grid of panel widgets plus the add-panel
 * form. Add/remove/reorder are pure reducers over the panel list; each produces a
 * new array the parent persists via `dashboards.update`. `series` is fetched once
 * by the parent and shared across every metric/stat panel.
 */
export const DashboardBoard = ({
    metricNames,
    name,
    onRemoveDashboard,
    onUpdatePanels,
    panels,
    series,
}: DashboardBoardProps & { series: MetricSeries[] | undefined }): ReactElement => (
    <div className="stack">
        <section className="card">
            <div className="metrics-head">
                <h3>{name}</h3>
                <button className="link danger" onClick={onRemoveDashboard} type="button">
                    Delete dashboard
                </button>
            </div>
            <AddPanelForm
                metricNames={metricNames}
                onAdd={(panel) => {
                    onUpdatePanels([...panels, panel]);
                }}
            />
        </section>

        {panels.length === 0 ? (
            <section className="card">
                <p className="muted">No panels yet — add a metric trend, a single stat, or a Traces/Logs shortcut above.</p>
            </section>
        ) : (
            <div className="dash-grid">
                {panels.map((panel, index) => (
                    <PanelCard
                        isFirst={index === 0}
                        isLast={index === panels.length - 1}
                        key={panel.id}
                        onMove={(direction) => {
                            onUpdatePanels(movePanel(panels, panel.id, direction));
                        }}

                        onRemove={() => {
                            onUpdatePanels(removePanel(panels, panel.id));
                        }}
                        panel={panel}
                        series={series}
                    />
                ))}
            </div>
        )}
    </div>
);
