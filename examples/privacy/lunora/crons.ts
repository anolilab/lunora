import { cronJobs } from "lunorash/server";

import { internal } from "./_generated/internal.js";

const crons = cronJobs();

/** Once a day: the deadline sweep lists requests due within seven days, and any already overdue. */
crons.daily("privacy deadlines", { hourUTC: 6, minuteUTC: 0 }, internal.requests.privacyTick, {});

/**
 * Once a day: expired exports lose their files and are marked `expired`, and the archive is purged.
 * Its own job, so a failing sweep cannot hide the deadline check: each job runs on its own.
 */
crons.daily("privacy housekeeping", { hourUTC: 6, minuteUTC: 0 }, internal.requests.privacySweep, {});

export default crons;
