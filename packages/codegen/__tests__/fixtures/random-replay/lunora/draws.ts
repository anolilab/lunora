import { api } from "./_generated/api.js";
import { action, mutation } from "./_generated/server.js";

// Two draws in one handler: the second must continue the first's sequence, not restart it.
export const twice = mutation.input({}).mutation(async ({ ctx }) => [ctx.random(), ctx.random()]);

// Two composed mutations from one action: they must draw from one shared sequence, as their ids do.
export const composed = action.input({}).action(async ({ ctx }) => [
    await ctx.runMutation(api.draws.twice, {}),
    await ctx.runMutation(api.draws.twice, {}),
]);
