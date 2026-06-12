# Plan: `@cirrus/payment` — provider-agnostic billing for Cirrus

> Status: **Proposal / research** · Owner: TBD · Target branch base: `alpha`

## 1. Goal

Add a first-class payments/billing add-on to Cirrus that:

- Supports **multiple payment providers** (Stripe first, then Polar, Lemon Squeezy, Paddle).
- Lets an app **switch providers via configuration**, not code rewrites.
- Fits the Cirrus model: webhook ingestion on `@cirrus/runtime`, durable state in a DO,
  reactive reads via `@cirrus/server` queries/subscriptions, and end-to-end types via `@cirrus/codegen`.
- Links subscriptions/customers to `@cirrus/auth` entities (user / org / workspace) via a `referenceId`.

## 2. Landscape research (npm, GitHub, Convex)

### 2a. Generic "unified payment" SDKs on npm — _reference only, do not depend_

| Package | Providers | Maturity | Verdict |
| --- | --- | --- | --- |
| `@paylayer/core` (PayLayer) | Stripe, Paddle, PayPal, Lemon Squeezy, Polar | ~1★, v0.1.x, Dec 2025, MIT | Cleanest API design; far too immature to depend on |
| `@unify-payment/node` / `unify-payment` | Stripe, Lemon Squeezy | low★, early | Webhook-verify + thin wrapper only |
| `unify-pay-flex`, UnipayConnect, `@ciscode/paymentkit` | Stripe, Razorpay, PayPal | hobby | Not production-grade |

**Pattern worth stealing (PayLayer):** an **adapter-per-provider** behind a unified facade selected by an env var
(`PAYLAYER_PROVIDER`), with a `webhook.process()` that does _verify → normalize event → dispatch handler_, producing
a `NormalizedEvent` (`type`, `amount`, `currency`, `provider`, ids, metadata). Facade methods: `charge`, `checkout`,
`subscribe`, `cancel`/`pause`/`resume`, `portal`. We will reimplement this shape natively rather than depend on it.

> Conclusion: there is **no mature, drop-in multi-provider npm package** we'd want as a runtime dependency.
> Every credible "unified" SDK is a solo hobby project. The right move is to own a thin abstraction and wrap each
> provider's **official** SDK (`stripe`, `@polar-sh/sdk`, `@lemonsqueezy/lemonsqueezy.js`, `@paddle/paddle-node-sdk`).

### 2b. Convex components — _the architecture to mirror_ (Cirrus is Convex-style)

- **`@convex-dev/stripe`** ([get-convex/stripe](https://github.com/get-convex/stripe)) — official. Registers via
  `app.use(stripe)`; webhook routes via `registerRoutes(http, components.stripe, { webhookPath })`; **syncs Stripe
  webhook events into typed tables** (`customers`, `subscriptions`, `checkout_sessions`, `payments`, `invoices`).
  Client surface: `createCheckoutSession`, `createCustomerPortalSession`, `getOrCreateCustomer`,
  `cancelSubscription`, `reactivateSubscription`, `updateSubscriptionQuantity`; reactive reads via
  `listSubscriptionsByUserId`, `getSubscription`, `listInvoices`, etc. Bidirectional sync (webhook in, SDK out).
- **`@convex-dev/polar`** ([get-convex/polar](https://github.com/get-convex/polar)) — same shape for Polar:
  product sync, `CheckoutLink`/`CustomerPortalLink` React components, webhook at `/polar/events`, handles fixed /
  pay-what-you-want / seat / metered pricing.

> This is the closest fit to Cirrus: **provider events → durable typed tables → reactive queries.** We adapt it to
> Cirrus primitives: a `PaymentDO` (SQLite, like `ShardDO`) or D1 for `.global()`, RPC via `@cirrus/runtime`,
> subscriptions via `@cirrus/server`.

### 2c. Entitlements/billing layers — _conceptual model for a future tier_

- **Better Auth Stripe plugin** ([docs](https://better-auth.com/docs/plugins/stripe)) — relevant because
  `@cirrus/auth` mirrors Better Auth. Auto-creates a customer on signup, subscription lifecycle + webhooks,
  **`referenceId`** links a subscription to a user/org/workspace. Limitation: **subscription-only, one active sub per
  referenceId**. We adopt the `referenceId` linkage idea and avoid the single-sub limitation.
- **Autumn** ([useautumn/autumn](https://github.com/useautumn/autumn), AGPL, open-source) — a billing/**entitlements**
  layer over Stripe: three verbs **`attach` / `check` / `track`**, owns source-of-truth for plans, credit balances,
  usage, seats; handles proration/failed-payment/concurrency. Hosted or self-host (Docker + Postgres + Bun).
  Not embeddable in Workers, but its **entitlement model** (`check(feature)`, `track(usage)`) is the blueprint for a
  later `@cirrus/payment` entitlements tier.

## 3. Recommendation

Build `@cirrus/payment` as a **native Cirrus add-on** (like `@cirrus/auth` / `@cirrus/mail`), structured as:

1. A **provider-adapter interface** — one adapter per provider, each wrapping the provider's official SDK.
2. A **normalized event + webhook ingress** wired into `@cirrus/runtime`, with retries via `@cirrus/scheduler`.
3. A **durable sync store** (`PaymentDO` on SQLite; `@cirrus/d1` for `.global()` reads) holding customers,
   subscriptions, checkouts, payments, invoices, and (optional) entitlements.
4. **Reactive reads** as `@cirrus/server` queries/subscriptions, and **`ctx.payments`** wired onto `ActionCtx` by
   `@cirrus/codegen` (the same pattern `@cirrus/ai` uses for `ctx.ai`).
5. **`referenceId`** linkage to `@cirrus/auth` (user/org/workspace), allowing multiple subscriptions per reference.

Do **not** take a runtime dependency on any generic multi-provider npm package. Wrap official provider SDKs as
optional peer deps so a Worker only bundles the adapter it uses.

### Provider rollout order

1. **Stripe** (`stripe`) — broadest, has hosted checkout + portal + robust webhooks.
2. **Polar** (`@polar-sh/sdk`) — DX darling, metered/PWYW, MoR.
3. **Lemon Squeezy** (`@lemonsqueezy/lemonsqueezy.js`) — Merchant-of-Record, simple subs.
4. **Paddle** (`@paddle/paddle-node-sdk`) — MoR, enterprise.

## 4. Package shape (mirrors existing Cirrus packages)

```
packages/payment/
├── package.json            # ESM-only, version 0.0.0, FSL-1.1-Apache-2.0
├── project.json            # { "name": "payment", "tags": ["type:package", "category:add-on"] }
├── tsconfig.json           # extends ../../tsconfig.base.json, moduleResolution: bundler
├── packem.config.ts        # standard esbuild transformer
├── vitest.config.ts        # getVitestConfig({ test: { environment: "node" } })
├── eslint.config.js / prettier.config.js / .releaserc.json   # delegated/standard
├── src/
│   ├── index.ts            # public API (named exports only)
│   ├── types.ts            # PaymentProvider, NormalizedEvent, Customer, Subscription, Invoice…
│   ├── create-payment.ts   # createPayment({ provider, store, auth? }) facade factory
│   ├── adapter.ts          # PaymentAdapter interface + registry
│   ├── webhook.ts          # verify → normalize → dispatch → sync (registerPaymentRoutes)
│   ├── store.ts            # sync-store interface (DO-backed / D1-backed)
│   ├── schema.ts           # defineSchema tables: customers, subscriptions, checkouts, payments, invoices
│   └── providers/
│       ├── stripe.ts       # wraps `stripe`
│       ├── polar.ts        # wraps `@polar-sh/sdk`            (phase 2)
│       ├── lemonsqueezy.ts # wraps lemonsqueezy.js            (phase 3)
│       └── paddle.ts       # wraps `@paddle/paddle-node-sdk`  (phase 3)
└── __tests__/              # adapter, webhook-normalization, store-sync, facade tests
```

**Subexports:** `.`, `./webhook`, `./adapter`, `./schema`, `./providers/stripe` (etc.), `./types`, `./package.json`.

**Dependencies:** `@cirrus/server`, `@cirrus/values` (deps); `@cirrus/runtime`, `@cirrus/do`, `@cirrus/d1`,
`@cirrus/scheduler`, `@cirrus/auth` (peer/optional where appropriate). Provider SDKs as **optional peerDependencies**.

### Core interfaces (sketch)

```ts
export interface PaymentAdapter {
  readonly provider: "stripe" | "polar" | "lemonsqueezy" | "paddle";
  readonly capabilities: { merchantOfRecord: boolean; usageMetering: boolean; portal: boolean };
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;        // hosted/embedded URL
  createPortalSession(input: PortalInput): Promise<{ url: string }>;
  getOrCreateCustomer(ref: CustomerRef): Promise<Customer>;
  cancelSubscription(id: string, opts?: CancelOpts): Promise<Subscription>;
  resumeSubscription(id: string): Promise<Subscription>;
  updateSubscription(id: string, patch: SubscriptionPatch): Promise<Subscription>;
  verifyWebhook(req: Request, secret: string): Promise<unknown>;        // provider raw event
  normalizeEvent(raw: unknown): NormalizedEvent;                        // → unified shape
}

export type NormalizedEvent =
  | { type: "checkout.completed"; referenceId: string; /* … */ }
  | { type: "subscription.created" | "subscription.updated" | "subscription.canceled"; /* … */ }
  | { type: "payment.succeeded" | "payment.failed"; /* … */ }
  | { type: "invoice.paid" | "invoice.payment_failed"; /* … */ };
```

### Webhook flow

```
provider POST ─▶ @cirrus/runtime route (registerPaymentRoutes)
              ─▶ adapter.verifyWebhook(req, secret)
              ─▶ adapter.normalizeEvent(raw) → NormalizedEvent
              ─▶ store.apply(event)  (idempotent upsert into PaymentDO/D1, keyed by event id)
              ─▶ enqueue side-effects via @cirrus/scheduler (emails, fulfillment) with retry
              ─▶ reactive queries/subscriptions update clients live
```

## 5. Config & DX

- New bindings inferred/validated by `@cirrus/config` (`wrangler.jsonc`): the `PaymentDO` Durable Object, optional D1
  for `.global()`, and queue for webhook side-effects.
- Secrets scaffolded into `.dev.vars` grammar: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, plus per-provider keys.
- Provider selection via config (e.g. `createPayment({ provider: stripeAdapter(env) })`) so swapping providers is a
  one-line change; multiple adapters can be registered simultaneously for migration.
- `@cirrus/react`: optional `useSubscription`/`useEntitlement` hooks + `CheckoutButton`/`CustomerPortalButton`
  (mirrors Convex Polar's `CheckoutLink`/`CustomerPortalLink`).
- `vis generate cirrus-payment` template (future) to scaffold a checkout action + webhook wiring.

## 6. Phasing

- **Phase 0 — scaffold:** `vis generate cirrus-package` → `@cirrus/payment`; types, adapter interface, facade, schema,
  DO-backed store, full Stripe adapter, webhook normalization, idempotent sync, unit tests. _Single-provider, working._
- **Phase 1 — DX wiring:** codegen `ctx.payments` on `ActionCtx`; `@cirrus/config` binding inference; `.dev.vars`
  scaffolding; example app.
- **Phase 2 — Polar adapter** + React components + `.global()`/D1 read path.
- **Phase 3 — Lemon Squeezy + Paddle adapters**; provider-migration story (dual-register).
- **Phase 4 — entitlements tier** (`check`/`track` à la Autumn): features, credits, usage metering, seat counts.

## 7. Resolved decisions (best-practice defaults)

1. **Sync-store substrate → single `PaymentDO` default + optional D1 read-mirror; shard opt-in.**
   Payment state is read-heavy, low-write, and needs strong consistency (one customer record per reference,
   idempotent webhook application keyed by event id) — a match for Cirrus's default single-DO topology with OCC.
   Mirror into D1 only when the app opts into `.global()` low-latency reads. `.shardBy(referenceId)` remains
   available but is **off by default**; payment volume rarely justifies it and a single DO keeps idempotency and
   uniqueness invariants trivial.
2. **Entitlements → thin native derive-from-subscription layer (Phase 4), Autumn adapter _seam_, no bundled Autumn.**
   Deriving `plan`/`features` from already-synced subscription state is cheap and stays in-Worker; a Postgres+Docker
   service does not belong in the Workers runtime. Full usage-metering/credits is deferred behind an **optional**
   adapter seam so teams that want Autumn can plug it in.
3. **Auth coupling → `referenceId` is a generic `string`; `@cirrus/auth` integration is optional.**
   Dependency inversion: core `@cirrus/payment` must work without auth and takes an opaque `referenceId`. A separate
   optional helper (auth as a **peer** dep) defaults it to the current session's user/org. No hard `@cirrus/auth` dep.
4. **MoR vs. PSP → encoded in the adapter, not just docs.** Each adapter exposes a `capabilities` /
   `merchantOfRecord` flag (Stripe = PSP; Polar / Lemon Squeezy / Paddle = Merchant-of-Record). The docs table spells
   out who owns tax/invoicing per provider so the difference is type-visible, not tribal knowledge.
5. **Provider SDK versions → package-local optional `peerDependencies`, not a pnpm catalog.**
   Catalogs are for versions shared across packages; only `@cirrus/payment` uses `stripe` / `@polar-sh/sdk` / etc.
   Keep them package-local and optional so a Worker bundles only the adapter it uses. Promote to `catalog:payment`
   later only if a second package needs them.

## 8. Sources

- npm unified SDKs: [@paylayer/core](https://www.npmjs.com/package/@paylayer/core) ·
  [paylayer-core (GitHub)](https://github.com/ajagatobby/paylayer-core) ·
  [@unify-payment/node](https://www.npmjs.com/package/@unify-payment/node) ·
  [payment-sdk topic](https://github.com/topics/payment-sdk)
- Convex components: [Stripe](https://www.convex.dev/components/stripe) ·
  [get-convex/stripe README](https://github.com/get-convex/stripe/blob/master/README.md) ·
  [Polar](https://www.convex.dev/components/polar) · [get-convex/polar](https://github.com/get-convex/polar)
- Entitlements/auth: [Better Auth Stripe plugin](https://better-auth.com/docs/plugins/stripe) ·
  [Better Auth Autumn plugin](https://better-auth.com/docs/plugins/autumn) ·
  [useautumn/autumn](https://github.com/useautumn/autumn) · [Autumn docs](https://docs.useautumn.com/welcome)
