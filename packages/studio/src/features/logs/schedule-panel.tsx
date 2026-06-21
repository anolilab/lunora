import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";
import type { CronTriggersPanelProps } from "./cron-triggers-panel";
import { CronTriggersPanel } from "./cron-triggers-panel";
import { DeadLetterJobs } from "./dead-letter-jobs";
import type { ScheduledJobsProps } from "./scheduled-jobs";
import { ScheduledJobs } from "./scheduled-jobs";
import { SchedulerPoolsPanel } from "./scheduler-pools-panel";

interface SchedulePanelProps {
    /** Override how the Cron triggers sub-view loads triggers; see {@link CronTriggersPanel}. */
    readonly loadCronJobs?: CronTriggersPanelProps["loadCronJobs"];

    /** Override how the Scheduled jobs sub-view cancels a job; see {@link ScheduledJobs}. */
    readonly scheduledCancel?: ScheduledJobsProps["cancelJob"];

    /** Override how the Scheduled jobs sub-view loads jobs; see {@link ScheduledJobs}. */
    readonly scheduledLoad?: ScheduledJobsProps["loadJobs"];
}

/** The complementary schedule surfaces the tab toggles between. */
type ScheduleView = "cron" | "dead" | "jobs" | "pools";

const VIEW_KEYS: ReadonlyArray<ScheduleView> = ["jobs", "dead", "pools", "cron"];

/**
 * The studio's Schedule tab. Hosts complementary surfaces behind a segmented
 * toggle. **Scheduled jobs** is the dynamic, in-flight queue — functions enqueued
 * via `runAfter` / `runAt`, live-updating and cancellable. **Dead letter** is the
 * recovery surface for jobs that exhausted their retries (retry or drop them).
 * **Pools** shows the workpool backlog / concurrency (`createWorkpool`). **Cron
 * triggers** is the static `cronJobs()` map compiled into the worker: fixed for
 * the deployment and read-only (Cloudflare exposes no runtime cron
 * introspection). Jobs is the default — it is the surface an operator acts on.
 */

export const SchedulePanel = ({ loadCronJobs, scheduledCancel, scheduledLoad }: SchedulePanelProps = {}): ReactElement => {
    const t = useT();
    const [view, setView] = useState<ScheduleView>("jobs");

    const viewLabel = { cron: t("Cron triggers"), dead: t("Dead letter"), jobs: t("Scheduled jobs"), pools: t("Pools") };

    const selectView = (event: React.MouseEvent<HTMLButtonElement>): void => {
        setView(event.currentTarget.dataset.view as ScheduleView);
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-schedule">
            <div aria-label={t("Schedule view")} className="flex gap-1.5" data-testid="schedule-view-toggle" role="tablist">
                {VIEW_KEYS.map((key) => (
                    <Button
                        aria-selected={view === key}
                        data-testid={`schedule-view-${key}`}
                        data-view={key}
                        key={key}
                        onClick={selectView}
                        role="tab"
                        size="sm"
                        type="button"
                        variant={view === key ? "default" : "outline"}
                    >
                        {viewLabel[key]}
                    </Button>
                ))}
            </div>

            {view === "jobs" && <ScheduledJobs cancelJob={scheduledCancel} loadJobs={scheduledLoad} />}
            {view === "dead" && <DeadLetterJobs />}
            {view === "pools" && <SchedulerPoolsPanel />}
            {view === "cron" && <CronTriggersPanel loadCronJobs={loadCronJobs} />}
        </div>
    );
};

export type { SchedulePanelProps };
