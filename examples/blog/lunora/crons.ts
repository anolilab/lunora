/**
 * Code-first cron definitions.
 *
 * `lunora codegen` discovers these registrations by AST and emits
 * `_generated/crons.ts`: `LUNORA_CRON_TRIGGERS` (what belongs in wrangler's
 * `triggers.crons`) and `LUNORA_CRONS` (the dispatcher map the Worker's
 * `scheduled()` entry consumes — see `src/server/index.ts`). So the schedule is
 * declared once, here, and never hand-copied into `wrangler.jsonc`.
 *
 * The target must be an **internal** function reached through a two-segment
 * `internal.<file>.<fn>` property access — that is what codegen resolves to a
 * dispatch ref, and internal functions are the ones a client cannot call.
 */
import { cronJobs } from "lunorash/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.daily("purge stale drafts", { hourUTC: 3, minuteUTC: 0 }, internal.cleanup.purgeStaleDrafts, {});

export default crons;
