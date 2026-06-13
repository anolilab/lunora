import { cronJobs } from "@cirrus/scheduler";

import { internal } from "./_generated/api.js";

/**
 * Control-plane crons (CLOUD-PLAN.md §2.3). The control-plane Worker is
 * account-level (not in a dispatch namespace), so its cron triggers fire
 * normally — unlike tenant Workers (§2.4). Codegen emits the `wrangler.jsonc`
 * schedule + the dispatcher the `scheduled()` handler consumes.
 */
const crons = cronJobs();

// Tear down expired preview deployments once an hour.
crons.interval("cleanup expired previews", { hours: 1 }, internal.deployments.cleanupExpiredPreviews, {});

export default crons;
