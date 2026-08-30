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
 * this). Demonstrates both push paths: `ctx.push.send` (one targeted device) and
 * `ctx.push.broadcast` (fan-out to all).
 */
export const broadcast = action
    .input({ body: v.string(), title: v.string() })
    .action(async ({ args: { body, title }, ctx }): Promise<{ failed: number; pruned: number; sent: number; total: number }> => {
        // A targeted single send. It goes through `ctx.push.send`, which resolves
        // the stored subscription and derives the delivery target from it: a target
        // cannot be rebuilt out here, because `push.list()` strips the delivery
        // secrets (the web-push `keys`, the FCM token). Handing `ctx.notify.send` a
        // bare `endpoint` URL routed the message to FCM — the push router treats
        // any non-`{`-prefixed string as an opaque FCM registration token.
        const [first] = await ctx.push.list();

        if (first !== undefined) {
            await ctx.push.send(first.id, { body, title });
        }

        // Fan out to EVERY stored subscription — the primary broadcast path.
        const { failed, pruned, sent, total } = await ctx.push.broadcast({ body, title });

        return { failed, pruned, sent, total };
    });
