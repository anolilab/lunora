/**
 * Example durable workflow: a per-channel welcome sequence.
 *
 * Start it from a mutation/action with `context.workflows.get("channelWelcome")
 * .create({ params: { channelId } })` (the typed `context.workflows` handle is
 * codegen-wired once this file exists; see `channels.create` for the call site).
 * It posts a greeting, waits a minute, then posts a
 * follow-up tip. Each `context.step.do` is a durable, memoized, retried step and the
 * `context.step.sleep` survives Worker evictions and redeploys — the whole sequence
 * resumes exactly where it left off. Every `context.run` targets the channel's shard
 * via `shardKey`, so the writes land on the same DO that owns the channel.
 */
import { defineWorkflow } from "@lunora/workflow";

import { api } from "./_generated/api.js";
import type { Id } from "./_generated/server.js";

export const channelWelcome = defineWorkflow<{ channelId: Id<"channels"> }, { channelId: Id<"channels">; posted: number }>({
    handler: async (context) => {
        const { channelId } = context.params;

        // `createdAt` is stamped inside the durable step (which runs once and
        // memoizes its result) — `messages.send` is a deterministic mutation that
        // takes the timestamp as an arg rather than calling `Date.now()` itself.
        await context.step.do("greet", () =>
            context.run(
                api.messages.send,
                { channelId, createdAt: Date.now(), text: "👋 Welcome to the channel! Say hi to get started." },
                { shardKey: channelId },
            ),
        );

        // Durable wait — the workflow hibernates here and resumes after a minute.
        await context.step.sleep("settle", "1 minute");

        await context.step.do("tips", () =>
            context.run(
                api.messages.send,
                { channelId, createdAt: Date.now(), text: "Tip: messages stream in real time over a WebSocket subscription." },
                { shardKey: channelId },
            ),
        );

        context.log.info("channel welcome sequence complete", { channelId });

        return { channelId, posted: 2 };
    },
});
