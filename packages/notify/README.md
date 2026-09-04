# @lunora/notify

Multi-channel notifications for Lunora, wrapping the [`@visulima/notification`](https://visulima.com/packages/notification) engine. Web Push + FCM first (both edge-safe under workerd), plus chat, in-app inbox, and webhook channels — with device-subscription storage and queue-backed fan-out.

- `ctx.notify` — the multi-channel facade (`send`, `chat`, `inApp`, `webhook`, `push`).
- `ctx.push` — the device-push sub-facade (`register`, `send`, `broadcast`, `list`, `unregister`).

## Edge safety

Web Push (VAPID + RFC 8291) and FCM (HTTP v1) run on `fetch` + Web Crypto — no `node:*`. **APNs** (`node:http2`) and the **BullMQ / pg-boss / SQS** queue adapters are Node-only and are **not** wired into this facade; route heavy fan-out through `@lunora/queue`.

## Configure

```ts
// lunora/notify.ts
import { defineNotify, webPushFromEnv, fcmFromEnv, d1SubscriptionStore } from "@lunora/notify";

export default defineNotify({
    webPush: (env) => webPushFromEnv(env), // reads VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
    fcm: (env) => fcmFromEnv(env), // reads FCM_PROJECT_ID / FCM_ACCESS_TOKEN (prefer a getAccessToken in prod)
    store: (env) => d1SubscriptionStore(env.DB),
});
```

`.dev.vars` (scaffolded by `lunora dev` from `@lunora/config`'s package-secrets registry):

```
VAPID_PUBLIC_KEY=<your-vapid-public-key>
VAPID_PRIVATE_KEY=<your-vapid-private-key>
VAPID_SUBJECT=mailto:you@example.com
FCM_PROJECT_ID=<your-firebase-project-id>
FCM_ACCESS_TOKEN=<your-fcm-access-token>
```

Generate a VAPID keypair once: `npx web-push generate-vapid-keys`.

## Register a device (browser)

```ts
import { subscribeToPush } from "@lunora/notify/web";

const { replacedEndpoint, subscription } = await subscribeToPush({ serviceWorkerUrl: "/sw.js", vapidPublicKey });
await client.mutation("registerDevice", { replacedEndpoint, subscription });
```

`replacedEndpoint` is set only after a **VAPID key rotation**: the stale browser
subscription is dropped and a new one minted, and the new one has a new endpoint
— hence a new store id — so it never upserts over the old row. Every send to that
row now answers `403 VapidPkHashMismatch`, which is (correctly) not a "gone"
signal, so nothing prunes it either. Forward it and unregister it:

```ts
// lunora/registerDevice.ts (a mutation — storage write is fine here)
import { webPushId } from "@lunora/notify";

export const registerDevice = mutation
    .input({ replacedEndpoint: v.optional(v.string()), subscription: v.any() })
    .mutation(async ({ ctx, args: { replacedEndpoint, subscription } }) => {
        if (replacedEndpoint !== undefined) {
            await ctx.push.unregister(webPushId(replacedEndpoint), { userId: ctx.auth?.userId });
        }

        await ctx.push.register({ subscription, userId: ctx.auth?.userId });
    });
```

`unregister`'s owner argument is **required**, and the row is removed only when
it carries that same owner. A subscription id is derived from the endpoint, so
`replacedEndpoint` is a caller-controlled key and nothing about it proves the
browser that sent it ever held the subscription it names — without the scope,
anyone who could guess or observe another user's endpoint could silence that
device. A row owned by someone else is left alone silently, so the call cannot be
used to probe which endpoints exist. Register with the same `userId` you
unregister with; devices registered anonymously (`userId` absent) all share the
one anonymous scope and get no separation from this check.

`register` is scoped the same way, because an unguarded upsert closes only half
of that: re-registering a victim's endpoint under your own `userId` (with keys of
your choosing) takes their device dark just as effectively, and hands you
`unregister` over it. An endpoint already registered to another user is
**refused** (`FORBIDDEN`) rather than re-owned — unowned rows stay claimable (the
device signed in), and a device that legitimately changes hands unregisters as
its current owner first.

## Send (from an action)

Notification sends are external I/O, so they belong in **actions** (the `notify_send_outside_action` advisor lint enforces this):

```ts
export const announce = action.input({ title: v.string(), body: v.string() }).action(async ({ ctx, args: { title, body } }) => {
    const result = await ctx.push.broadcast({ title, body });
    // result: { total, sent, pruned, failed, outcomes }
});
```

`broadcast` reuses the engine's retry + circuit-breaker middleware and prunes subscriptions the push service reports as gone (Web Push HTTP 404/410; FCM's `NOT_FOUND` answer for a dead token, plus the `UNREGISTERED`/`NotRegistered` codes a legacy transport sends). A single targeted send:

```ts
await ctx.push.send(subscriptionId, { title: "Hi", body: "…" });
```

Multi-channel through `ctx.notify.send`:

```ts
await ctx.notify.send({
    push: { title: "New drop", body: "…", to: pushTarget },
    chat: { text: "New drop shipped" },
});
```

## Queue-backed fan-out

Move a large broadcast off the request path with `@lunora/queue`:

```ts
// producer (mutation/action)
await enqueuePushBroadcast(ctx.queues.push, { payload: { title: "New drop", body: "…" } });

// lunora/notify-fanout.ts — an INTERNAL ACTION, because that is where
// `ctx.push` and `ctx.queues` exist.
export const deliverPage = internalAction.input({ job: v.any() }).action(async ({ args: { job }, ctx }) => {
    const { failedIds, nextFilter } = await runPushBroadcastPage(ctx.push, job);

    // One message = ONE bounded page. Discarding `nextFilter` delivers only the
    // first page (default 250 devices) and reports success for the whole audience.
    // Pass it verbatim — it carries the cursor AND the remaining `filter.limit`.
    if (nextFilter !== undefined) {
        await enqueuePushBroadcast(ctx.queues.push, { payload: job.payload, filter: nextFilter });
    }

    // Redeliver ONLY the recipients that failed — a retry of the whole page would
    // re-POST everyone it already reached.
    if (failedIds.length > 0) {
        await enqueuePushBroadcast(ctx.queues.push, { payload: job.payload, retryIds: failedIds });
    }
});

// lunora/queues.ts — a `QueueRunContext` is exactly `{ env, log, run }`: no
// `ctx.push`, no `ctx.queues`. The consumer hands each message to the action above.
// (Note the handler signature: `(context, batch)`, in that order.)
export const push = defineQueue<PushBroadcastJob>({
    handler: async (context, batch) => {
        for (const message of batch.messages) {
            await message.run(internal.notifyFanout.deliverPage, { job: message.body });
            message.ack();
        }
    },
});
```

## Subscription storage

`SubscriptionStore` implementations: `memorySubscriptionStore()` (non-durable default, tests/dev) and `d1SubscriptionStore(db)` (durable, edge-safe, lazy table creation). Lifecycle: register (upsert), list/filter (by kind or user), status marking, and automatic prune of gone subscriptions on send/broadcast.

## Security

`ctx.push.register(...)` and the browser `subscribeToPush` helper both accept
client-supplied data, so the facade enforces two boundaries:

- **Endpoint validation (anti-SSRF).** Every later `send`/`broadcast` POSTs to a
  subscription's stored Web Push `endpoint`, so a hostile `endpoint` would turn the
  worker into an SSRF / amplification primitive. `register()` validates the endpoint
  **at storage time** (the durable boundary): it must be an absolute `https:` URL
  with a non-private / non-loopback / non-link-local / non-CGNAT host. To hard-pin
  the boundary to the push services you actually use, set `allowedPushOrigins` on
  `defineNotify` — when present, an endpoint's origin must match one of the listed
  origins **exactly** (no wildcards), which also closes DNS rebinding:

    ```ts
    export default defineNotify({
        webPush: (env) => webPushFromEnv(env),
        allowedPushOrigins: ["https://fcm.googleapis.com", "https://updates.push.services.mozilla.com"],
        store: (env) => d1SubscriptionStore(env.DB),
    });
    ```

- **No secrets on the app facade.** `ctx.push.list()`
  returns the registered devices with the delivery **secrets stripped** — the Web
  Push `keys` (`auth`/`p256dh`) and the FCM `token`, which together with the
  endpoint are enough to deliver arbitrary push to a device. Every other facade
  read is projected the same way; the broadcast path uses the store directly. The
  one place a handler does see a raw row is the return of `ctx.push.register(...)`,
  which echoes back the record the caller just supplied — nothing it did not
  already hold, and never another device's.

## Delivery observability

Every send is counted onto `ctx.metrics` and failures onto `ctx.log` for you — codegen threads the request's logger/metrics into `ctx.notify` (`createNotify(notifyConfig, env, { log, metrics })`), so there is nothing to wire. Two low-cardinality metric series feed the durable metric history + trend charts:

- **`notify.send`** `{ channel, provider, status }` — attempted sends. `status` is `accepted` (the provider took it), `failed`, or `gone` (endpoint unregistered — Web Push 404/410, or FCM's `NOT_FOUND` for a dead token — and pruned). A single send counts 1; a **broadcast aggregates** into one count per `(provider, status)` bucket (value = the bucket's count), not one per recipient — each `ctx.metrics.count` is a durable write.
- **`notify.skipped`** `{ channel, reason }` — a send that reached nobody: `no-subscriptions-matched` (empty broadcast) or `channel-not-configured`.

A **failed** send also emits one `ctx.log.warn` line carrying the error and, for push, the subscription/user ids — trace-correlated to the enclosing action and durably archived. Successes and prunes stay off the log; failure logs stay per-recipient even in a broadcast (they have no durable write).

`accepted` means the provider **accepted** the message, not that it was delivered or opened: Web Push and FCM give no delivery/open receipts, so the status stops at the send attempt. See [Observability → Delivery metrics](/docs/concepts/observability#delivery-metrics-notify).

## Status

Shipped: Web Push + FCM channels, chat / in-app / webhook senders, device-subscription storage (memory + D1), queue-backed fan-out, the codegen ctx-splice that auto-wires `ctx.notify` / `ctx.push` from `lunora/notify.ts` (via `createNotify`, mirroring `defineFlags` → `ctx.flags`), the `notify_send_outside_action` advisor lint, the Studio **Notifications** page (registered-device inspector), and [delivery observability](#delivery-observability).

Deferred: a filterable per-delivery **activity feed** and per-device history (a Novu-style drill-down). Web Push / FCM give no delivery/open receipts, so it would report only the send-attempt outcome; it needs a field-level predicate on the durable log reader (or a dedicated store) and is not planned until asked for.
