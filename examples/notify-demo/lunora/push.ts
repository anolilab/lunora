import type { PushSubscriptionLike } from "@lunora/notify";

import type { Id } from "./_generated/server.js";
import { action, mutation, query, v } from "./_generated/server.js";

interface AnnouncementDoc {
    _id: Id<"announcements">;
    body: string;
    sentAt: number;
    title: string;
}

/**
 * Register a browser/device push subscription. The client obtains the plain
 * subscription via `subscribeToPush` (`@lunora/notify/web`) and hands it here;
 * `ctx.push.register` upserts it into the configured `d1SubscriptionStore` so a
 * later `ctx.push.broadcast` can reach it (and the Studio Notifications page can
 * list it).
 */
export const registerDevice = mutation.input({ subscription: v.any() }).mutation(async ({ args: { subscription }, ctx }): Promise<void> => {
    // `v.any()` types the arg as `unknown`; the register facade accepts a plain
    // Web Push subscription (or an FCM token string) — narrow it here.
    await ctx.push.register({ subscription: subscription as PushSubscriptionLike });
});

/** Record an announcement row — the subscribable log the client renders. */
export const announce = mutation
    .input({ body: v.string(), title: v.string() })
    .mutation(async ({ args: { body, title }, ctx }): Promise<Id<"announcements">> => ctx.db.insert("announcements", { body, sentAt: Date.now(), title }));

/** List announcements, newest first. Subscribers receive deltas as `announce` writes. */
export const listAnnouncements = query.query(async ({ ctx }): Promise<AnnouncementDoc[]> => {
    const rows = await ctx.db.query("announcements").withIndex("by_sent").collect();

    return [...rows].sort((a, b) => b.sentAt - a.sentAt);
});

/**
 * Fan a push out to every registered device. Sends are external I/O, so they
 * live in an **action** (the `notify_send_outside_action` advisor lint enforces
 * this). Demonstrates both facades: `ctx.notify.send` (multi-channel, targeted at
 * the first registered device) and `ctx.push.broadcast` (fan-out to all).
 */
export const broadcast = action
    .input({ body: v.string(), title: v.string() })
    .action(async ({ args: { body, title }, ctx }): Promise<{ failed: number; pruned: number; sent: number; total: number }> => {
        // Multi-channel send through `ctx.notify` — targeted at the first registered
        // device (a push payload requires an explicit `to` target).
        const [first] = await ctx.push.list();

        if (first !== undefined) {
            await ctx.notify.send({ push: { body, title, to: first.endpoint ?? first.id } });
        }

        // Fan out to EVERY stored subscription — the primary broadcast path.
        const { failed, pruned, sent, total } = await ctx.push.broadcast({ body, title });

        return { failed, pruned, sent, total };
    });
