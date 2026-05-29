import { type ReactElement, useMemo, useState } from "react";

import { DataBrowser } from "./data-browser.js";
import { ExportImportPanel } from "./export-import.js";
import { FunctionRunner } from "./function-runner.js";
import { MigrationsPanel } from "./migrations.js";
import { ScheduledJobs, type ScheduledJobsProps } from "./scheduled-jobs.js";
import { SchemaViewer } from "./schema-viewer.js";
import type { FunctionDescriptor } from "./types.js";

/** Identifier for each built-in dashboard tab. */
export type DashboardTab = "data" | "export" | "functions" | "migrations" | "schedule" | "schema";

export interface DashboardProps {
    /**
     * Functions exposed in the runner tab. The runner tab only appears when at
     * least one descriptor is supplied (a query/mutation/action's `kind` is
     * compile-time-only, so it must be named here).
     */
    readonly functions?: FunctionDescriptor[];
    /** Shard key every shard-scoped panel targets on first load. */
    readonly initialShardKey?: string;
    /**
     * Cancel a scheduled job. Wired through to {@link ScheduledJobs}; the
     * schedule tab is interactive only when this is supplied.
     */
    readonly scheduledCancel?: ScheduledJobsProps["cancelJob"];
    /**
     * Load pending scheduled jobs. The schedule tab only appears when this is
     * supplied, since the scheduler isn't reachable over the admin-RPC path.
     */
    readonly scheduledLoad?: ScheduledJobsProps["loadJobs"];
}

const TAB_LABELS: Record<DashboardTab, string> = {
    data: "Data",
    export: "Export / Import",
    functions: "Functions",
    migrations: "Migrations",
    schedule: "Scheduled",
    schema: "Schema",
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
export function Dashboard({ functions, initialShardKey, scheduledCancel, scheduledLoad }: DashboardProps): ReactElement {
    const tabs = useMemo<DashboardTab[]>(() => {
        const available: DashboardTab[] = ["data", "schema"];

        if (functions !== undefined && functions.length > 0) {
            available.push("functions");
        }

        available.push("migrations", "export");

        if (scheduledLoad !== undefined) {
            available.push("schedule");
        }

        return available;
    }, [functions, scheduledLoad]);

    const [active, setActive] = useState<DashboardTab>(() => tabs[0] ?? "data");

    // Guard against the active tab disappearing (e.g. `functions` becomes empty).
    const fallbackTab = tabs[0] ?? "data";
    const current = tabs.includes(active) ? active : fallbackTab;

    return (
        <div data-testid="cirrus-dashboard">
            <nav data-testid="dash-tabs" role="tablist">
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
            </nav>

            <div data-testid="dash-panel" role="tabpanel">
                {current === "data" && <DataBrowser initialShardKey={initialShardKey} />}
                {current === "schema" && <SchemaViewer initialShardKey={initialShardKey} />}
                {current === "functions" && functions !== undefined && <FunctionRunner functions={functions} />}
                {current === "migrations" && <MigrationsPanel initialShardKey={initialShardKey} />}
                {current === "export" && <ExportImportPanel initialShardKey={initialShardKey} />}
                {current === "schedule" && scheduledLoad !== undefined && <ScheduledJobs cancelJob={scheduledCancel} loadJobs={scheduledLoad} />}
            </div>
        </div>
    );
}
