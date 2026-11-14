/**
 * Recurring jobs — codegen emits `_generated/crons.ts` and the Worker's
 * `scheduled()` handler; `lunora dev` / deploy reconcile `triggers.crons`.
 */
import { cronJobs } from "lunorash/server";

import { internal } from "./_generated/internal";

const crons = cronJobs();

crons.interval("headline-refresh", { hours: 1 }, internal.crons.jobs.fanOutMaintenance, { kind: "headline.refresh" });
crons.interval("billing-cancel-sweep", { hours: 1 }, internal.payment.sweepPendingCancels, {});
crons.daily("tenant-maintenance", { hourUTC: 3, minuteUTC: 15 }, internal.crons.jobs.fanOutMaintenance, { kind: "maintenance.sweep" });

export default crons;
