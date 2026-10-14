import { action, v } from "./_generated/server.js";

/**
 * Calls both services: the fetch service the way an existing HTTP client would
 * (its `fetch` handed over detached), and the RPC service by method.
 */
export const summarise = action.input({ prompt: v.string() }).action(async ({ ctx, args }) => {
    const client = { fetch: ctx.services.parser.fetch };
    const response = await client.fetch("https://parser/documents/7");
    const { parsed } = await response.json<{ parsed: string }>();
    const completed = await ctx.services.gateway.complete(args.prompt);

    return { completed, parsed };
});
