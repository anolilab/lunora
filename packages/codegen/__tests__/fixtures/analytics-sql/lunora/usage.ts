// `ctx.analyticsSql` is read here and nowhere else, so this file alone is what
// flips the usage probe: no `@lunora/bindings/analytics-sql` import, exactly how
// an app written against the generated `server.ts` reaches it.
import { action, query, v } from "./_generated/server.js";

export const callsSince = action.input({ since: v.string() }).action(async ({ args, ctx }) => {
    const result = await ctx.analyticsSql.query<{ calls: number }>(
        `SELECT COUNT(*) AS calls FROM events.analyticsEngine."ANALYTICS" WHERE timestamp >= $since AND blob1 = 'function_call'`,
        { since: args.since },
    );

    return result.rows[0]?.calls ?? 0;
});

export const count = query.input({}).query(async ({ ctx }) => {
    // @ts-expect-error -- `ctx.analyticsSql` is ActionCtx-only: billed, non-deterministic network I/O never rides a query.
    void ctx.analyticsSql;

    return (await ctx.db.query("questions").collect()).length;
});
