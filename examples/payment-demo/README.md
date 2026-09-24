# payment-demo

A minimal Lunora app wiring [`@lunora/payment`](../../packages/payment) end-to-end: Stripe Checkout, webhook-synced subscriptions, and a reactive subscription list. Scoped to the providers Convex ships components for (Stripe + Polar) — this demo uses Stripe.

## What it shows

- **`lunora/schema.ts`** declares the payment tables **inline** (codegen discovers tables by parsing this file — it can't resolve a cross-package `...paymentTables` spread; `@lunora/payment`'s `paymentTables` is the canonical column reference). Payment state lives in the app's ShardDO and is read with the same reactive `ctx.db` — **no separate payment Durable Object**. Read-heavy tables can chain `.global()` for D1-backed cross-region reads.
- **`lunora/billing.ts`**
    - `checkout` (action) calls `ctx.payments.createCheckout(...)` and returns the hosted-checkout `{ url }`. Reaching for `ctx.payments` is what tells codegen to wire the typed facade onto `ActionCtx`.
    - `mySubscriptions` (query) reads the synced `subscriptions` table — re-renders the instant a webhook lands.
    - `processWebhook` (internal action) reconstructs the request and calls `ctx.payments.handleWebhook(...)` inside the shard, where the store exists.
- **`lunora/http.ts`** mounts `POST /payment/webhook` as an `httpAction` — it runs at the Worker edge with the **raw** request (needed for signature verification) and forwards the body + signature into the shard via `ctx.runAction(processWebhook, …)`, then answers with `webhookResponse(result)` — only the JSON payload crosses that hop, so the status has to be re-applied or an orphaned event's deliberate `500` becomes a `200` and Stripe never retries it.
- **`src/server/index.ts`** passes `payment: (env) => ({ adapter: createStripeAdapter({ client: new Stripe(env.STRIPE_SECRET_KEY), webhookSecret: env.STRIPE_WEBHOOK_SECRET }) })` to `createShardDO`. The generated ShardDO assembles `ctx.payments` per request with the store on `ctx.db`.
- **`src/client/App.tsx`** uses `@lunora/react/payment`'s `CheckoutButton` (redirect-on-URL) wired to the `checkout` action, plus a reactive `useQuery(api.billing.mySubscriptions)`.

## Run it

```sh
cp .dev.vars.example .dev.vars        # then fill STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
pnpm --filter @lunora-example/payment-demo codegen
pnpm --filter @lunora-example/payment-demo dev
```

Point a Stripe webhook (test mode) at `<your-url>/payment/webhook` for the `checkout.session.completed`, `customer.subscription.*`, and `payment_intent.*` events.

> **Auth note:** the demo uses a fixed `referenceId` and an allow-all `authorize` for brevity. A real app drops both — the default authorizer ties the `referenceId` to `ctx.auth.userId`, so a caller can only act on their own subscriptions.
