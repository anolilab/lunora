/**
 * Recurring jobs — codegen emits `_generated/crons.ts` and the Worker's
 * `scheduled()` handler; `lunora dev` / deploy reconcile `triggers.crons`.
 */
import { cronJobs } from "lunorash/server";

import { internal } from "./_generated/internal.js";

const crons = cronJobs();

crons.interval("headline-refresh", { hours: 1 }, internal.crons.jobs.fanOutMaintenance, {});
crons.daily("tenant-maintenance", { hourUTC: 3, minuteUTC: 15 }, internal.crons.jobs.fanOutMaintenance, {});

export default crons;
