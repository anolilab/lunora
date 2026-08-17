# Plan 335 — `@lunora/risk`: account trust tiers, purchase gating, and abuse controls

**Baseline:** `cadabf5` (2026-08-17)
**Status:** TODO

## 0. Headline finding

Lunora already ships every _mechanism_ a card-testing defence needs — a durable
sharded limiter with a deny list (`@lunora/ratelimit`), a spend-in-arrears budget
(`tokenBudget`), a signup hook that can refuse account creation
(`packages/auth/src/email-gate.ts`), a payment engine with a webhook sync loop
(`@lunora/payment`), a flag surface for kill switches (`@lunora/flags`), and
`ctx.ip`. What it does not ship is the **policy layer that joins them**: nothing
in the repo knows what an account's payment history is, nothing decides whether a
_purchase_ should be allowed, and nothing turns a chargeback back into a signal.

Three concrete gaps block a reusable version of this:

1. **No geo signal.** `ctx.ip` is forwarded from `cf-connecting-ip`
   (`packages/runtime/src/create-worker.ts:1800-1808`) but `request.cf.country` /
   `CF-IPCountry` is dropped. Country-level signup blocking is not implementable
   in app code today.
2. **No dispute/chargeback event.** `WebhookActionType`
   (`packages/payment/src/types.ts:346-357`) has no `payment.disputed`. The one
   signal that proves an account was fraudulent never reaches the app.
3. **No account-history read model.** `PaymentStore`
   (`packages/payment/src/store.ts:18-67`) can list subscriptions and sum usage
   per reference, but cannot answer "has this org ever had a payment capture?" —
   the single predicate the whole kill switch turns on.

Everything else is composition. The proposal is one small package
(`@lunora/risk`), one registry item (`risk`) carrying the per-app policy, and
three narrow core changes for the gaps above.

## 1. Current state (audit)

| Capability the story needs        | What exists today                                                                                                            | Gap                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Per-org rate limits               | `RateLimiter` + `createDbStore` + `rateLimit` middleware, fail-closed by default (`packages/ratelimit/src/middleware.ts:63`) | Limits are static per name; no notion of a limit that depends on trust                                               |
| Spend caps ("$5/day", "$15k/day") | `tokenBudget` — check-before / record-after, bucket may go negative (`packages/ratelimit/src/token-budget.ts`)               | Nothing binds a budget to an account tier; unit is per-app, undocumented                                             |
| Deny list                         | `RateLimiter.denyList`, short-circuits before accounting (`packages/ratelimit/src/rate-limiter.ts:184-189`)                  | Construction-time `Iterable<string>` only — no durable, mutable deny list                                            |
| Signup blocking                   | `emailGateHook` on better-auth `user.create.before` (`packages/auth/src/email-gate.ts`), Turnstile (`.../turnstile.ts`)      | Email-domain only; no IP velocity, no country                                                                        |
| Account ban                       | `banUser` / `unbanUser` (`packages/auth/src/admin.ts:262,312`)                                                               | Manual, admin-driven; nothing calls it from a risk signal                                                            |
| Kill switch without deploy        | `ctx.flags.boolean(key, default)` — never throws, falls back to the default (`packages/flags/src/types.ts:17-33`)            | No convention for which flags a payment path should consult                                                          |
| Payment choke point               | `createPayment().checkout()`, guarded by `authorize(referenceId)` (`packages/payment/src/create-payment.ts:133-148`)         | `authorize` answers _tenancy_ ("may this caller act on this reference"), not _risk_ ("should this money move")       |
| Chargeback feedback               | —                                                                                                                            | `WebhookActionType` has refunds but no disputes; `PaymentObserver` likewise                                          |
| Caller IP                         | `ctx.ip`, trusted, forwarded server-side (`packages/server/src/types.ts:2051`)                                               | —                                                                                                                    |
| Caller country                    | —                                                                                                                            | `request.cf` is only read for resource detection + trace trust                                                       |
| Decision audit trail              | Durable request log + security audit in `@lunora/observability`                                                              | No record of _why_ a purchase was refused — a refused payment is revenue, and an unauditable refusal is unreviewable |

## 2. Existing seams (do not reinvent)

- **`definePlugin` + `defineSchemaExtension`** (`packages/server/src/plugin.ts`,
  exported from `@lunora/server`) with `registry/ratelimit/` as the worked
  example: a schema extension whose tables auto-prefix (`ratelimit_buckets`),
  plus middleware hung off `ctx.api.<key>`. This is how the risk tables and the
  `ctx.api.risk` helper ship — no new packaging mechanism.
- **`RateLimiter` as the accounting engine.** Spend caps are a token bucket
  denominated in minor currency units; velocity counters are fixed windows. Both
  are already durable (rows under the DO input gate → atomic read-modify-write),
  already shardable, already fail-closed at the middleware. Do **not** write a
  second ledger.
- **`tokenBudget`** for inference spend specifically — the LLM-gateway case is
  exactly its docstring ("cents work identically if you would rather budget
  money").
- **better-auth `databaseHooks.user.create.before`** — `emailGateHook` proves the
  shape, including how to rethrow a coded `LunoraError` as a better-auth
  `APIError` so the client sees `400 { code }` and not a 500.
- **`classifyEmail`** (`packages/auth/src/email-guard.ts`) — disposable/free/business
  classification, edge-safe, already a signal.
- **`PaymentObserver`** (`packages/payment/src/observability.ts`) — the existing
  "telemetry must never break a payment" callback; dispute events extend it
  rather than adding a parallel hook.
- **`applyWebhookAction`** + the append-only `events` table — inbound
  idempotency is solved; disputes ride the same path.
- **`@lunora/advisor`** `STATIC_LINTS` — where "payments enabled with no risk
  gate" belongs, not a bespoke warning.

## 3. The behavioural contract to preserve

- **Existing customers are never touched.** A renewal, an auto top-up, or any
  off-session charge on an account with payment history must take the same code
  path it takes today. The gate distinguishes `purchaseKind: "first" | "topup" | "renewal"`
  and short-circuits to `allow` for renewals on an established account _before_
  any store read.
- **`createPayment`'s `authorize` contract is unchanged.** Risk is a separate
  decision, composed at the call site; overloading `authorize` would conflate
  tenancy with risk and silently change the meaning of every existing app's
  authorizer.
- **`@lunora/ratelimit` gains no risk concepts.** It stays a limiter.
- **Flags never throw** — a risk policy that reads a flag must supply the
  fail-safe default explicitly (deny for purchase gates, allow for geo).
- **Payment tables keep their columns.** Risk state lives in its own extension
  tables; `paymentSessions` is read, never written, by this package.

## 4. Design decisions

**D1 — Deterministic rule set, not a score model.** `evaluate(signals, policy)`
is pure and returns `{ action, reasons[], tier }`, mirroring how
`@lunora/advisor` and `state-machine.ts` are built: data in, verdict out, trivially
unit-testable, replayable against a stored signal snapshot. _Rejected:_ an opaque
0-100 risk score — unauditable, untunable by the app author, and impossible to
explain to the customer whose purchase was refused.

**D2 — Trust tiers select a named limit; they do not mutate limit config.** The
policy declares one named limit per tier (`spend:new`, `spend:verified`,
`spend:established`) and the gate picks the name at call time. `RateLimiter`
needs no change, and a tier promotion is a key change, not a config migration.
_Rejected:_ dynamic per-call `RateLimitConfig`, which would make the bucket's
meaning depend on when it was last read.

**D3 — Two failure policies, chosen per signal.** The purchase gate **fails
closed** (a store outage must not open the money path — the existing middleware
default). Geo and email signals **fail open** (an unavailable geo lookup must not
block every signup worldwide). Each signal declares its own policy; there is no
global switch.

**D4 — Package for the engine, registry item for the policy.** `@lunora/risk`
carries the rules, stores, middleware, and adapters — versioned and tested.
`lunora registry add risk` copies `lunora/risk/policy.ts` (the tier ladder,
country list, thresholds — the part every app tunes and owns) plus the schema
extension. Same split as `@lunora/ratelimit` ↔ `registry/ratelimit`. _Rejected:_
registry-only (the rules would be un-versioned copies nobody can fix centrally)
and package-only (thresholds are app policy; burying them behind a config object
makes the interesting part the least visible part).

**D5 — Risk reads payment history through a narrow source interface.**
`PaymentHistorySource` = `{ firstCaptureAt, capturedMinorSince, disputeCount, refundedMinorSince }`,
with a default implementation over the `paymentSessions` table. `@lunora/risk`
therefore does **not** depend on `@lunora/payment`; an app on a different billing
stack implements four methods. _Rejected:_ a hard dependency, which would drag
provider SDK peer-deps into every app that only wants signup throttling.

**D6 — Disputes are a first-class webhook action.** Add `payment.disputed` and
`payment.dispute_closed` to `WebhookActionType`, map Stripe
`charge.dispute.created` / `.closed` in the adapter, and emit a matching
`PaymentEvent`. A dispute is the only ground-truth fraud label the system ever
receives; without it the tier ladder can only ever ratchet upward. _Rejected:_
leaving disputes to app-level webhook handling — every app would re-derive the
same mapping, and the sync layer already owns idempotency.

**D7 — Every decision is recorded, including allows.** An append-only
`risk_decisions` row (`{ reference, action, reasons, tier, signalsHash, at }`)
mirroring the payment `events` table. Refusing a real customer's payment is a
revenue incident; if the refusal is not reviewable it will be discovered from a
support ticket. Sampling allows is a policy knob (`record: "all" | "denials"`).

**D8 — `ctx.geo`, not `ctx.country`.** One namespaced surface
(`{ country, continent, region?, asn?, colo? }`) so later signals do not each need
a core change and a capability row.

## 5. Workstreams

**W1 — `ctx.geo` (S, core).** Forward `request.cf.country` (falling back to the
`CF-IPCountry` header) as `x-lunora-client-country` alongside the existing IP
plumbing at `packages/runtime/src/create-worker.ts:1800-1808`; add it to
`SHARED_BATCH_HEADERS` (`packages/do/src/batch.ts:16-23`); surface it in
`ShardDO` next to `currentRequestIp` (`packages/do/src/shard-do.ts:4573`); type it
on the three ctx shapes in `packages/server/src/types.ts`. Add a `requestGeo`
capability row (see §6). Absent → `undefined`, never a guess.

**W2 — Dispute signals (S, `@lunora/payment`).** `payment.disputed` /
`payment.dispute_closed` in `WebhookActionType`; Stripe adapter mapping; sync-layer
handling (a dispute does not itself move `PaymentState` — it annotates the session,
so the state machine is untouched); `PaymentEvent` variants. API snapshot update.

**W3 — Payment history read model (S, `@lunora/payment`).**
`sumCapturedByReference(referenceId, since)` and `firstCaptureAt(referenceId)` on
`PaymentStore` + the database store, backed by the existing `by_reference` index
on `paymentSessions` (`packages/payment/src/schema.ts:62`).

**W4 — `@lunora/risk` core (M, new package).** Zero-runtime-dep on the other
`@lunora/*` add-ons (peer-optional):

- `signals.ts` — `RiskSignals` (account age, first capture, captured/refunded
  totals, dispute count, email class, ip, country, velocity counters) + a
  `collectSignals(ctx, sources)` assembler.
- `policy.ts` — `RiskPolicy` types: the tier ladder, per-tier limit names,
  country lists, thresholds, per-signal failure policy.
- `evaluate.ts` — the pure rule set → `RiskDecision`. This is the file with the
  tests.
- `tiers.ts` — `resolveTier(signals, ladder)`; promotion is monotonic within a
  request, and a dispute demotes.
- `gate.ts` — `purchaseGate(...)`: the composed check (kill switch flag → tier →
  spend bucket → decision → record). Fails closed.
- `signup.ts` — the better-auth `user.create.before` hook (country block, IP
  signup velocity, email class, optional Turnstile), modelled on `email-gate.ts`.
  Fails open on geo, closed on velocity.
- `middleware.ts` — `riskGate` procedure middleware, so `.use(riskGate(...))`
  guards any mutation/action, not just checkout.
- `store.ts` — durable deny list + decision log + velocity, over `ctx.db`.

**W5 — `registry add risk` (S).** `lunora/risk/policy.ts` (the tuned ladder:
new = $5/day, established = 90 days _or_ $5k captured → $15k/day, matching the
worked example), `lunora/risk/index.ts` (an admin `listDecisions` query, a
`setAllowlist` mutation, a `review` mutation), and the schema extension
(`risk_decisions`, `risk_denylist`, velocity buckets reusing `ratelimit_buckets`
when that item is present). Defaults ship **restrictive**: an account with no
payment history cannot buy credits until the app author says otherwise.

**W6 — Observability + advisor (S).** Metrics (`risk.decision` counter by
action/reason), a `risk.denied` Studio surface fed by `risk_decisions`, and two
static advisor lints: `payment_checkout_without_risk_gate` and
`risk_policy_missing_denial_review`.

**W7 — Docs + example (S).** `packages/risk/docs/` and a
`examples/payment-demo` wiring showing the three controls from the story:
purchase kill switch, country block, tier ladder.

W1–W3 are independent of W4 and can land first; W4 is the only workstream that
needs all three.

## 6. Platform parity

| Feature                | `cloudflare`                                   | `node`      | Notes                                                                                                                                              |
| ---------------------- | ---------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.geo`              | native (`request.cf.country` / `CF-IPCountry`) | unsupported | Node has no edge geo lookup; the host would need a MaxMind-style DB. Codegen omits the surface + emits `platform_unsupported_feature`.             |
| `ctx.api.risk` (gate)  | native                                         | emulated    | Pure logic over `ctx.db` + the limiter; runs anywhere a shard host runs. Country rules degrade to their fail-open branch when `ctx.geo` is absent. |
| Turnstile signal       | native                                         | native      | Plain HTTPS POST, no binding (`packages/auth/src/turnstile.ts:1-10`).                                                                              |
| Dispute webhook signal | native                                         | native      | Provider webhook, host-neutral.                                                                                                                    |

`requestGeo` is added to the `PlatformCapabilities.features` map
(`packages/platform/src/capabilities.ts:28-113`) and rated in
`CLOUDFLARE_CAPABILITIES` and `NODE_CAPABILITIES` in the same change as W1.

## 7. Phasing & ordering

| Phase | Work                             | Gate                                                                                                                                                                                 |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | W1 `ctx.geo`                     | Runtime test asserts the header is forwarded from `request.cf` and absent when unknown; `api:check` green with the new capability row                                                |
| 1     | W2 disputes + W3 history         | `@lunora/payment` tests: a Stripe dispute fixture produces `payment.disputed` exactly once (replayed event is a `duplicate`); `sumCapturedByReference` matches a hand-summed fixture |
| 2     | W4 `@lunora/risk` engine         | `evaluate` table-driven tests over the full signal matrix; gate test proves fail-closed on store outage and that a renewal on an established account never reads the store           |
| 3     | W5 registry item                 | `pnpm run test:templates` scaffolds an app with `registry add risk`, builds, and typechecks; a zero-history purchase is refused with `code: "RISK_DENIED"`                           |
| 4     | W6 observability + advisor lints | Advisor test: an app with `checkout` and no `riskGate` produces the lint; Studio decision list renders from a seeded `risk_decisions` table                                          |
| 5     | W7 docs + example                | `examples/payment-demo` e2e: new account blocked, tier promotion after a seeded capture unblocks, existing subscriber's renewal unaffected throughout                                |

## 8. Open questions

1. **Where does the tier ladder live at runtime — policy file or flags?** The
   file is reviewable and diffable; a flag is changeable at 2am during an attack.
   Proposal: the file is the source of truth, and each tier's spend cap may be
   overridden by a number flag whose default is the file's value. Needs a
   decision before W4's `policy.ts` lands.
2. **Should a dispute auto-ban?** `banUser` exists
   (`packages/auth/src/admin.ts:262`). Auto-banning on the first dispute is
   correct for a gateway and wrong for a marketplace. Proposal: ship the demotion
   (always) and expose the ban as an opt-in policy action, off by default.
3. **Velocity keying for signup throttling.** IP alone is trivially defeated by a
   proxy pool and over-blocks behind CGNAT. Proposal: composite keys (IP, /24,
   email domain, ASN once `ctx.geo.asn` exists), each with its own bucket, deny on
   any hit. Confirm the ASN field is available on `request.cf` for the account
   plan we document against.
4. **Does the deny list belong in `@lunora/ratelimit` instead?** Its `denyList` is
   construction-time only. A durable, mutable deny list is generally useful and
   arguably belongs there rather than in `@lunora/risk`. Deferred until W4 shows
   whether anything but risk wants it.
