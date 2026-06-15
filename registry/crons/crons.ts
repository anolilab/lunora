/**
 * Code-first cron definitions — added by `lunora registry add crons`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. `@lunora/codegen` discovers the `cronJobs()` builder
 * registrations below by AST (not a runtime brand) and emits two things from
 * them:
 *
 *   - the wrangler.jsonc `triggers.crons` schedule array, and
 *   - a dispatcher map the Worker's `scheduled()` handler consumes.
 *
 * So you never hand-edit `wrangler.jsonc` — declare crons here and run
 * `lunora codegen`.
 *
 * Every job points at an **internal** function (server-only — clients can't
 * call it) referenced statically via the generated `internal` proxy, e.g.
 * `internal.crons_jobs.run`. The reference MUST be a two-segment property
 * access (`internal.<file>.<fn>`) so codegen can resolve it to the
 * `namespace:fn` dispatch ref; a dynamic reference won't be discovered.
 *
 * Schedule helpers (all UTC):
 *   - `crons.interval(name, { seconds | minutes | hours }, fn, args?)`
 *   - `crons.daily(name, { hourUTC, minuteUTC }, fn, args?)`
 *   - `crons.weekly(name, { dayOfWeek, hourUTC, minuteUTC }, fn, args?)`
 *   - `crons.monthly(name, { day, hourUTC, minuteUTC }, fn, args?)`
 *   - `crons.cron(name, "0 * * * *", fn, args?)`  // raw 5/6-field escape hatch
 *
 * Job names must be unique across the whole project (the runtime keys the
 * dispatcher by name).
 */
import { cronJobs } from "@lunora/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Illustrative: run the example internal mutation in lunora/crons/jobs.ts every
// hour. Replace the function ref (and the schedule) with your own — e.g.
//   crons.daily("send digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest, {});
//   crons.interval("sweep presence", { minutes: 5 }, internal.presence.sweep, { roomId: "lobby" });
crons.interval("heartbeat", { hours: 1 }, internal.crons_jobs.run, {});

export default crons;
