import { type ReactElement, useState } from "react";

import { DataBrowser } from "./data-browser.js";
import { ErrorBoundary } from "./error-boundary.js";
import { ExportImportPanel } from "./export-import.js";
import { FileBrowser } from "./file-browser.js";
import { FunctionRunner } from "./function-runner.js";
import { GlobalDataBrowser } from "./global-data-browser.js";
import { LogsPanel } from "./logs-panel.js";
import { MetricsPanel } from "./metrics-panel.js";
import { MigrationsPanel } from "./migrations.js";
import { ScheduledJobs, type ScheduledJobsProps } from "./scheduled-jobs.js";
import { SchemaViewer } from "./schema-viewer.js";
import type { FunctionDescriptor } from "./types.js";
import { UsersPanel } from "./users-panel.js";

/** Identifier for each built-in dashboard tab. */
export type DashboardTab = "data" | "export" | "files" | "functions" | "globals" | "logs" | "metrics" | "migrations" | "schedule" | "schema" | "users";

export interface DashboardProps {
    /**
     * Make the data tab editable (insert/edit/delete rows). Off by default so
     * the dashboard is read-only unless the host opts in; see {@link DataBrowser}.
     */
    readonly dataEditable?: boolean;
    /**
     * Functions exposed in the runner tab. The runner tab only appears when at
     * least one descriptor is supplied (a query/mutation/action's `kind` is
     * compile-time-only, so it must be named here).
     */
    readonly functions?: FunctionDescriptor[];
    /** Shard key every shard-scoped panel targets on first load. */
    readonly initialShardKey?: string;
    /**
     * Override how the schedule tab cancels a job. Defaults to the client's
     * scheduler admin endpoint; see {@link ScheduledJobs}.
     */
    readonly scheduledCancel?: ScheduledJobsProps["cancelJob"];
    /**
     * Override how the schedule tab loads jobs. Defaults to the client's
     * scheduler admin endpoint, so the tab works without extra wiring.
     */
    readonly scheduledLoad?: ScheduledJobsProps["loadJobs"];
}

const TAB_LABELS: Record<DashboardTab, string> = {
    data: "Data",
    export: "Export / Import",
    files: "Files",
    functions: "Functions",
    globals: "Global Tables",
    logs: "Logs",
    metrics: "Metrics",
    migrations: "Migrations",
    schedule: "Scheduled",
    schema: "Schema",
    users: "Users",
};

/**
 * A single tabbed shell that composes every dashboard panel — data browser,
 * schema overview, function runner, migrations, export/import and scheduled
 * jobs — behind one `<CirrusProvider>`. Tabs whose data source isn't configured
 * (the function runner without `functions`, the schedule tab without
 * `scheduledLoad`) are omitted rather than rendered empty.
 *
 * Every admin panel reaches the backend over the live `useCirrus` client and is
 * gated server-side by `CIRRUS_ADMIN_TOKEN`; this shell adds no credentials of
 * its own.
 */
export function Dashboard({ dataEditable = false, functions, initialShardKey, scheduledCancel, scheduledLoad }: DashboardProps): ReactElement {
    // Every tab is always shown: the function runner auto-discovers its list
    // from the worker when no `functions` prop is passed, so it's never empty.
    const tabs: DashboardTab[] = ["data", "globals", "schema", "functions", "migrations", "export", "files", "schedule", "users", "metrics", "logs"];

    const [active, setActive] = useState<DashboardTab>("data");
    const current = tabs.includes(active) ? active : "data";

    return (
        <div data-testid="cirrus-dashboard">
            <div aria-label="Dashboard sections" data-testid="dash-tabs" role="tablist">
                {tabs.map((tab) => (
                    <button
                        aria-selected={current === tab}
                        data-testid={`dash-tab-${tab}`}
                        key={tab}
                        onClick={() => {
                            setActive(tab);
                        }}
                        role="tab"
                        type="button"
                    >
                        {TAB_LABELS[tab]}
                    </button>
                ))}
            </div>

            <div data-testid="dash-panel" role="tabpanel">
                {current === "data" && <DataBrowser editable={dataEditable} initialShardKey={initialShardKey} />}
                {current === "globals" && <GlobalDataBrowser />}
                {current === "schema" && <SchemaViewer initialShardKey={initialShardKey} />}
                {current === "functions" && <FunctionRunner functions={functions} />}
                {current === "migrations" && <MigrationsPanel initialShardKey={initialShardKey} />}
                {current === "export" && <ExportImportPanel initialShardKey={initialShardKey} />}
                {current === "files" && <FileBrowser />}
                {current === "schedule" && <ScheduledJobs cancelJob={scheduledCancel} loadJobs={scheduledLoad} />}
                {current === "users" && <UsersPanel />}
                {current === "metrics" && <MetricsPanel initialShardKey={initialShardKey} />}
                {current === "logs" && <LogsPanel initialShardKey={initialShardKey} />}
            </div>
        </div>
    );
}
