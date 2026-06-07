/**
 * Example internal cron target — added by `cirrus registry add crons`.
 *
 * This file is YOURS: a normal Cirrus module copied into your project. It lives
 * at `cirrus/crons/jobs.ts`, so codegen surfaces its functions under the
 * `crons_jobs` namespace — i.e. `internal.crons_jobs.run` (the ref the sample
 * job in `cirrus/crons.ts` fires).
 *
 * `run` is an **internalMutation**: server-only, so a client can never invoke
 * it directly — only the scheduler (or another server function via
 * `ctx.runMutation` / `ctx.scheduler`) can. Swap the body for whatever periodic
 * work you need (clean up stale rows, roll up counters, enqueue mail…), or
 * delete this file once your crons point at your own functions.
 *
 * Cron handlers should be idempotent: a missed tick may be retried, and a
 * long-running tick can overlap the next one.
 */
import { internalMutation, v } from "@cirrus/server";

/**
 * The example periodic job. Returns the wall-clock time it ran so you can see
 * it firing in the studio's function logs; replace the body with real work.
 */
export const run = internalMutation({
    args: { since: v.optional(v.number()) },
    handler: async (_ctx, { since }): Promise<{ ranAt: number }> => {
        const ranAt = Date.now();

        // TODO: do your periodic work here. `since` is an example arg — pass
        // whatever you need from the cron registration's args object.
        void since;

        return { ranAt };
    },
});
