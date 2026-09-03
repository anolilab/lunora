import { webPushId } from "@lunora/notify";
import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { ActionCtx, Id, MutationCtx } from "./_generated/server.js";
import { action, mutation, query, v } from "./_generated/server.js";

/**
 * This demo has no sign-in, so a deployed instance is reachable by anyone and
 * the limit keyed on the caller's server-trusted `ctx.ip` is the only thing
 * standing between it and a script. Never key on a value out of `args`: the
 * caller could rotate it per request and never share a bucket with themselves.
 */
const actionLimiter = (ctx: ActionCtx) => makeRateLimiter(ctx);
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byCaller = { key: (ctx: { ip?: string }): string => ctx.ip ?? "anon" };

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
export const registerDevice = mutation
    .input({
        // Set only after a VAPID rotation — the endpoint of the subscription the
        // browser just replaced. Its server row is keyed on that endpoint, so
        // nothing else will ever overwrite or prune it.
        replacedEndpoint: v.optional(v.string().max(2048)),
        // The exact Web Push subscription shape, declared rather than `v.any()`:
        // this is a trust boundary (the endpoint is a URL the server will later
        // POST to), so the validator rejects anything else before it reaches the
        // store, and the handler needs no cast.
        subscription: v.object({
            endpoint: v.string().max(2048),
            keys: v.object({
                auth: v.string().max(256),
                p256dh: v.string().max(256),
            }),
        }),
    })
    .use(rateLimit(mutationLimiter, "write", byCaller))
    .mutation(async ({ args: { replacedEndpoint, subscription }, ctx }): Promise<void> => {
        if (replacedEndpoint !== undefined) {
            await ctx.push.unregister(webPushId(replacedEndpoint));
        }

        await ctx.push.register({ subscription });
    });

/** Record an announcement row — the subscribable log the client renders. */
export const announce = mutation
    .input({ body: v.string().max(2048), title: v.string().max(256) })
    .use(rateLimit(mutationLimiter, "write", byCaller))
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
 *
 * This is the sharpest edge in the demo: a public procedure that delivers
 * caller-supplied text to every device anyone has registered. It carries the
 * tightest bucket of the three for that reason. An app with sign-in should gate
 * it on an operator role (`ctx.auth.userId` against your own admin list), not
 * merely rate-limit it.
 */
export const broadcast = action
    .input({ body: v.string().max(2048), title: v.string().max(256) })
    .use(rateLimit(actionLimiter, "broadcast", byCaller))
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
