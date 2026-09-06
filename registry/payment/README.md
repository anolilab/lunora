# payment

Provider-agnostic payments for Lunora — checkout, metered usage tracking, entitlement checks, a billing portal, and a reactive subscription list, built on [`@lunora/payment`](../../packages/payment). Stripe is the first-class adapter; Polar and others plug in through the `PaymentAdapter` contract.

## Install

```bash
lunora registry add payment
```

This:

1. Adds `@lunora/payment`, `@lunora/server`, and `stripe` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/payment/schema.ts` (the payment tables to declare) and `lunora/payment/index.ts` (the `checkout` / `track` / `check` / `portal` / `mySubscriptions` / `processWebhook` functions) into your project — these are **yours** to edit.
3. Scaffolds `APP_BASE_URL`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` into `.dev.vars`.

## 1. Declare the payment tables — do this first

**Copy the five table declarations from `lunora/payment/schema.ts` into your own `lunora/schema.ts`, inline.** Until you do, the first `ctx.payments.*` call — and `mySubscriptions` — fails with `UNKNOWN_TABLE`.

```ts
// lunora/schema.ts
export default defineSchema({
    // ... your app tables

    customers: defineTable({ … }).index("by_provider_customer", ["provider", "providerCustomerId"], { unique: true }).index("by_reference", ["referenceId"]),
    events: defineTable({ … }).index("by_provider_event", ["provider", "providerEventId"], { unique: true }),
    paymentSessions: defineTable({ … }),
    subscriptions: defineTable({ … }),
    usageEvents: defineTable({ … }),
});
```

Two shortcuts that look like they should work and don't:

- **`defineSchema({ ...paymentTables })`** — codegen discovers tables by parsing `lunora/schema.ts` as an AST. A spread is not a property assignment, so it is skipped in silence and you get a schema with no payment tables at all.
- **`.extend(payment.extension)`** — the schema-extension merge auto-prefixes extension tables with the plugin key (`payment_subscriptions`), while `@lunora/payment`'s store reads the bare names. A prefixed merge leaves `ctx.payments` reading tables that don't exist.

Declaring them inline is also what lets you chain `.global()` on a read-heavy table (`subscriptions`) so cross-region reads are served from D1.

## 2. Wire the adapter

In your Worker entry's `createShardDO({ … })` call. Note that `createStripeAdapter` takes a **single options object** — not positional `(client, webhookSecret)`:

```ts
import { createStripeAdapter } from "@lunora/payment/stripe";
import Stripe from "stripe";

createShardDO({
    payment: (env) => ({
        adapter: createStripeAdapter({
            client: new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() }),
            webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        }),
        authorize: (ref) => ref === ctx.auth.userId,
        entitlements: { plans: { pro: { features: ["export"], limits: { api_calls: 1000 }, priceIds: ["price_xxx"] } } },
    }),
});
```

## 3. Add the webhook route

`processWebhook` is an `internalAction`, so it runs inside the shard where `ctx.payments` and its store exist. The HTTP route at the Worker edge forwards the raw body and the signature headers to it:

```ts
import { webhookResponse } from "@lunora/payment";

// Which header carries the signature is the provider's choice — `stripe-signature`,
// `creem-signature`, the Standard-Webhooks `webhook-*` trio (Polar, Dodo Payments), or `svix-*`
// (Autumn) — so forward all of them and let the adapter read the one it verifies with. Add yours
// if you wire an adapter that signs with another header.
const SIGNATURE_HEADERS = [
    "creem-signature",
    "stripe-signature",
    "svix-id",
    "svix-signature",
    "svix-timestamp",
    "webhook-id",
    "webhook-signature",
    "webhook-timestamp",
];

app.post(
    "/payment/webhook",
    httpAction(async (ctx, request) => {
        const body = await request.text();
        const headers = Object.fromEntries(
            SIGNATURE_HEADERS.flatMap((name) => {
                const value = request.headers.get(name);

                return value === null ? [] : [[name, value]];
            }),
        );
        return webhookResponse(await ctx.runAction(processWebhook, { body, headers }));
    }),
);
```

An allowlist rather than `Object.fromEntries(request.headers)`: the whole header set puts a hostile POST's `cookie` / `authorization` into the RPC argument for no reason, and re-attaches entity headers (`content-encoding`, `content-length`) to a `Request` whose body has already been decoded to text.

Answer with `webhookResponse`, never `Response.json(result)`: only the JSON payload crosses the `runAction` boundary, so the HTTP status has to be re-applied at the edge. Without it an **orphaned** event — one patching a row whose create event has not arrived yet — answers `200` instead of its deliberate `500`, the provider never retries it, and the out-of-order update is lost for good.

## 4. Set the env vars

| Var                     | Secret | Notes                                                                                                                       |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `APP_BASE_URL`          | no     | Public origin of the deployment, e.g. `https://app.example.com`. Builds the checkout success/cancel and portal return URLs. |
| `STRIPE_SECRET_KEY`     | yes    | Stripe secret key (`sk_test_…` in test mode).                                                                               |
| `STRIPE_WEBHOOK_SECRET` | yes    | Stripe webhook signing secret (`whsec_…`) for your `/payment/webhook` endpoint.                                             |

`APP_BASE_URL` is read from env rather than derived from the request because a Lunora context carries no `Request` — a mutation can be replayed and a query re-run from a live subscription, so there is no request to read an origin from at handler time.

Then run `lunora codegen` to wire `ctx.payments` onto `ActionCtx`.

## What you own

Everything under `lunora/payment/` is copied into your repo. Change the feature ids, the plan shape, the return URLs, or add your own payment-adjacent functions. `@lunora/payment` provides the adapters, the store, and the entitlement engine; this item is the idiomatic Lunora glue that turns them into `api.payment.*`.
