import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";
import type { CronTriggersPanelProps } from "./cron-triggers-panel";
import { CronTriggersPanel } from "./cron-triggers-panel";
import type { ScheduledJobsProps } from "./scheduled-jobs";
import { ScheduledJobs } from "./scheduled-jobs";

interface SchedulePanelProps {
    /** Override how the Cron triggers sub-view loads triggers; see {@link CronTriggersPanel}. */
    readonly loadCronJobs?: CronTriggersPanelProps["loadCronJobs"];

    /** Override how the Scheduled jobs sub-view cancels a job; see {@link ScheduledJobs}. */
    readonly scheduledCancel?: ScheduledJobsProps["cancelJob"];

    /** Override how the Scheduled jobs sub-view loads jobs; see {@link ScheduledJobs}. */
    readonly scheduledLoad?: ScheduledJobsProps["loadJobs"];
}

/** The two complementary schedule surfaces the tab toggles between. */
type ScheduleView = "cron" | "jobs";

const VIEW_KEYS: ReadonlyArray<ScheduleView> = ["jobs", "cron"];

/**
 * The studio's Schedule tab. Hosts two complementary surfaces behind a segmented
 * toggle. **Scheduled jobs** is the dynamic, in-flight queue — functions enqueued
 * via `runAfter` / `runAt`, live-updating and cancellable. **Cron triggers** is
 * the static `cronJobs()` map compiled into the worker: fixed for the deployment
 * and read-only (Cloudflare exposes no runtime cron introspection). Jobs is the
 * default — it is the surface an operator acts on.
 */

export const SchedulePanel = ({ loadCronJobs, scheduledCancel, scheduledLoad }: SchedulePanelProps = {}): ReactElement => {
    const t = useT();
    const [view, setView] = useState<ScheduleView>("jobs");

    const viewLabel = useMemo<Record<ScheduleView, string>>(() => {
        return { cron: t("Cron triggers"), jobs: t("Scheduled jobs") };
    }, [t]);

    const selectView = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
        setView(event.currentTarget.dataset.view as ScheduleView);
    }, []);

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-schedule">
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
            {view === "cron" && <CronTriggersPanel loadCronJobs={loadCronJobs} />}
        </div>
    );
};

export type { SchedulePanelProps };
