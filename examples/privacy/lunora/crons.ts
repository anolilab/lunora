import { cronJobs } from "lunorash/server";

import { internal } from "./_generated/internal.js";

const crons = cronJobs();

/** Once a day: the deadline sweep lists requests due within seven days, and any already overdue. */
crons.daily("privacy deadlines", { hourUTC: 6, minuteUTC: 0 }, internal.requests.privacyTick, {});

export default crons;
