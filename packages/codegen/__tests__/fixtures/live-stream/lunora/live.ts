// The declaration flips codegen's `liveStreams` signal, which puts `ctx.live` on the
// action ctx. The test drives the shard's own connect and control routes, so the
// stream's authorization handler is never consulted here.
import { defineLiveStream } from "@lunora/server";

import { internalAction, v } from "./_generated/server.js";

export const feed = defineLiveStream({ id: "feed", onSubscribe: () => true });

// A scheduled job's action. The scheduler dispatches it to its shard as a trusted
// system call, and the publish lands on that shard's own subscribers.
export const announce = internalAction.input({ text: v.string() }).action(async ({ args, ctx }) => {
    // `ctx.live` is typed optional: codegen omits it on a target without live streams.
    if (!ctx.live) {
        throw new Error("ctx.live is not wired on this shard");
    }

    await ctx.live.publish("feed:news", { text: args.text }, { stream: "feed" });
});
