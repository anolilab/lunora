import { cronJobs } from "@lunora/scheduler";

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

// Compact closed-period platform-usage events once an hour (§4 metering rollup).
crons.interval("rollup platform usage", { hours: 1 }, internal.usage.rollup, {});

// Suspend orgs whose estimated period spend breached their cap; unsuspend the
// recovered ones (GAPS.md C1 abuse/bill-shock control).
crons.interval("enforce spend caps", { hours: 1 }, internal.usage.enforceSpendCaps, {});

// Every-minute heartbeat that emits the `*/1 * * * *` trigger the edge cron
// fan-out rides on (§2.4) — the job itself is a no-op; see lunora/fanout.ts.
crons.interval("tenant cron fan-out tick", { minutes: 1 }, internal.fanout.tick, {});

export default crons;
