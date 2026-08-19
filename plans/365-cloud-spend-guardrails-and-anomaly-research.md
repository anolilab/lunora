# Plan 365 — Cloud spend guardrails, anomaly alerting, recursion protection & agent-queryable billing

**Baseline:** `18ec7965` — the head of [PR #85](https://github.com/anolilab/lunora/pull/85)
(`claude/cloud-platform-dx-ojvkmu`), which carries `apps/cloud` itself. This plan
stacks on that PR, not on `alpha`.
**Status:** IN PROGRESS — W1 (metering fix) and W0 (full rate card) shipped;
W2–W7 open

Research pass over five capabilities Vercel shipped as a bundle (soft/hard spend
caps, anomaly alerting, function recursion protection, billing usage APIs for
agents, always-on L3/L4/L7 DDoS mitigation), mapped against the OSS prior art and
against what `apps/cloud` already has.

## 0. Headline findings

### 0.1 The meter under-reported exactly when it mattered (✅ fixed)

**Four of the five capabilities already had a working seam in `apps/cloud`; the
fifth (recursion protection) had no equivalent anywhere in the repo. But the
spend-cap chain that did exist was metering off a sampled source and reading it
as if it were exact.**

`src/dispatcher/worker.ts:131` writes one Analytics Engine data point per tenant
request; `src/metering/rollback.ts` folds those counts into the `platformUsage`
ledger; `lunora/usage.ts` (`enforceSpendCaps`) evaluates that ledger against the
cap hourly and suspends the org. The read in that chain was:

```sql
SELECT blob1 AS scriptName, SUM(double1) AS requests FROM <dataset> …
```

Workers Analytics Engine applies **weighted adaptive sampling at write time**:
past a write rate it keeps one row in place of many, and each retained row
carries the `_sample_interval` it stands in for. Summing `double1` bare
under-counts by the sample factor. Cloudflare's own
[usage-based-billing recipe](https://developers.cloudflare.com/analytics/analytics-engine/recipes/usage-based-billing-for-your-saas-product/)
uses `sum(_sample_interval)` grouped by the index for precisely this reason.

The repo already knew this — `src/telemetry/metrics-read.ts:9-14` says AE is a
sampling store and is explicitly "**not for billing math**" — but the metering
reader _was_ billing math, and it didn't apply the multiplier.

The failure mode was directional and unlucky: sampling engages **at high
volume**, which is precisely the runaway-tenant / compromised-account scenario
the hard cap exists to stop. The harder a tenant hammered the platform, the more
the ledger under-reported, and the later (or never) the cap fired.

**Fixed** in `src/metering/analytics.ts`. Because the dispatcher writes
`index1 = scriptName` and one data point per request, the corrected form is not
an approximation — it is the exact count, and indexing per tenant is also what
stops one enormous tenant from sampling a small tenant's rows to zero:

```sql
SELECT index1 AS scriptName, SUM(_sample_interval) AS requests FROM <dataset>
WHERE timestamp > toDateTime(<since>) GROUP BY scriptName
```

### 0.2 Cloudflare has no hard cap to borrow — the stop must be built (⚠ open)

Checked against the docs, and the answer is unambiguous. Cloudflare's two spend
controls are both **informational by design**:

> Budget alerts are informational only. **They do not pause or cap usage.** Your
> monthly invoice remains the authoritative source for billing.
> — [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)

> The email notifications are for informational purposes only.
> — [Usage-based billing notifications](https://developers.cloudflare.com/billing/understand/usage-based-billing/)

There is no account-level "stop at $X". So a hard cap on Lunora Cloud is
something the platform builds, and the only question is **where it intercepts** —
which is an economic question, because:

> **Only requests that hit a Worker will count against your limits and your
> bill.**
> — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Today's suspension serves a 503 from inside the dispatch Worker
(`src/dispatcher/worker.ts:112`), so **every request of an attack against a
suspended tenant still bills a Workers-for-Platforms request plus its CPU**. A
WAF custom rule blocking the same hostname fires in the
`http_request_firewall_custom` phase, before any Worker runs, and costs nothing.
See §2.5 for the full interception ladder.

## 1. Current state (audit)

| Capability               | Status in `apps/cloud`                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hard cap**             | ✅ shipped, single-valued. `src/billing/spend.ts` (pure evaluator, per-plan defaults `free $5` / `pro $200` / `enterprise` uncapped, org override), `lunora/usage.ts:220` enforcement cron. |
| **Soft cap**             | ❌ absent. No warn threshold, no notification before suspension. The org goes from serving traffic to a 503 with nothing in between.                                                        |
| **Anomaly alerting**     | 🟡 threshold-only. `lunora/alerts.ts` + `src/telemetry/alerts.ts` give metric-window rules (`error_rate`, `latency_p95`, `llm_cost`) with static thresholds; no baseline, no score.         |
| **Recursion protection** | ❌ absent. Nothing in the repo counts invocation depth or detects a tenant Worker looping through its own hostname. Only Cloudflare's own per-invocation subrequest cap applies.            |
| **Billing usage API**    | 🟡 data exists, not agent-reachable. `usage.summary`, `lunora/cloudflare-billing.ts` (Billable Usage API), `src/mcp/tools.ts` — but the usage/cost routes are not `mcp`-opted-in.           |
| **DDoS L3/L4/L7**        | ✅ inherited by construction (all tenant traffic is behind Cloudflare); ❌ invisible — no firewall events surfaced per tenant, no per-org ruleset config.                                   |

Supporting detail:

- **Suspension is binary and org-wide.** `lunora/deployments.ts:159-166` resolves a
  suspended org to the sentinel plan `"suspended"`; `src/dispatcher/worker.ts:112`
  serves a bare 503 for it. There is no per-project scope, no read-only mode, no
  grace window.
- **Enforcement latency is up to an hour.** `lunora/crons.ts:21` runs
  `enforceSpendCaps` on an hourly interval; the AE readback checkpoint
  (`src/metering/rollback.ts`) adds its own lag on top.
- **The spend number priced compute only** (✅ fixed — see §4a). `spend.ts`
  priced requests + CPU-ms and nothing else: storage, Durable Object duration,
  D1 rows, and R2 operations were absent, so a storage-shaped runaway was
  invisible to the cap forever. `platformUsage.kind` had a `storageBytes`
  variant that `estimatedSpendMinor` never read.
- **A real cost source landed recently but is not wired to enforcement.**
  `lunora/cloudflare-billing.ts` (commit `48366a2`) reads the org's _own_
  Cloudflare account spend by product via the Billable Usage API. It backs a
  read-only console tab; nothing feeds it back into the cap decision. Three
  documented limits bound how far that can go: the Billable Usage dashboard/API
  is **Pay-as-you-go accounts only** (Enterprise contract accounts unsupported),
  it requires the **Billing read** permission on the account, and its data is
  **aligned to the account's billing cycle, not the calendar month** — whereas
  `currentPeriodStart()` in `lunora/usage.ts` buckets on the UTC calendar month.
  Any design that reconciles the two has to resolve that offset rather than
  assume it away.
- **Per-plan runtime limits already exist.** `src/dispatcher/worker.ts:117-119`
  passes Workers-for-Platforms `limits` (CPU + subrequests) per plan on
  `env.DISPATCHER.get(...)`. This is the natural mounting point for a lineage
  header and a depth cap.
- **A rate-of-change primitive already exists, but only decorates the message.**
  `src/telemetry/alerts.ts:271` (`rateOfChangePercent`) has exactly one caller —
  `renderMetricAlert` at `:322`, which turns it into the "+42% vs the prior
  window" clause in the alert body. No rule _target_ thresholds on it, so
  window-over-window change is computed and then thrown away for
  decision-making purposes. That is the seam a baseline-relative anomaly score
  builds on, and it needs promoting from render-time to evaluate-time rather
  than writing from scratch.

## 2. Prior art

### 2.1 Soft & hard caps

Three shapes in the market, and they differ in _what the cap does_, not in how the
number is computed:

- **Vercel** — a team-level on-demand usage budget (default $200), configurable.
  Notifications fire at percentage thresholds; on reaching the amount you choose
  the action: notify, **pause all projects**, or **fire a webhook**. Pausing is
  opt-in — setting an amount does not by itself stop usage. The "improved hard
  caps" work was about making the pause land reliably and fast.
- **Convex** — two explicit numbers per team: a **warning threshold** (email only,
  no action) and a **disable threshold** (all projects disabled, functions throw).
  Limits apply only to usage _beyond_ the plan's included amounts; seat fees are
  excluded. Re-enable by raising or removing the limit.
- **Supabase** — a single **Spend Cap boolean** on Pro, on by default. On means
  usage beyond quota is throttled/blocked rather than billed, with a Fair-Use
  grace period instead of a surprise invoice. Off means overages bill. Absent on
  Team/Enterprise.
- **Kubernetes** — the canonical enforcement model rather than a billing one:
  `ResourceQuota` rejects at **admission time** (the request to create the
  workload fails), `LimitRange` supplies per-object defaults and ceilings. The
  lesson is placement, not policy: enforce at the point of admission, synchronously,
  not in a reconciliation loop that runs later.
- **OpenStack** — the same split at cloud scale: Nova/Cinder/Neutron quotas are
  synchronous admission checks; **CloudKitty** is after-the-fact rating and
  chargeback with pluggable fetchers/collectors/rating modules and _no_
  enforcement. Metering and enforcement are deliberately different components.
- **OpenCost** (CNCF) — allocation only; it documents _no_ budgets, no anomaly
  alerts, no notifications, by design ("the Prometheus of cloud cost"). The
  governance layer (budget thresholds, anomaly detection, Slack) is what the
  proprietary Kubecost tier adds on top. Instructive: the OSS ecosystem
  consistently ships the meter and leaves the guardrail to the product.
- **OpenMeter** — the exception, and the closest analogue to what Cloud needs:
  entitlements + balance, checked at request time ("usage gating"), so the cap is
  a synchronous read rather than a periodic sweep.

**Applies to Lunora Cloud:** the two-number model (Convex/Vercel) is strictly
better than today's one-number model and costs one schema field plus a
notification. The admission-time lesson (K8s/OpenStack/OpenMeter) says the cap
check belongs where the plan lookup already happens — `resolveTenant` in the
dispatcher — not only in an hourly cron.

### 2.2 Anomaly alerting

- **Vercel** — two alert families: _usage anomalies_ (unusual edge requests,
  function duration) and _error anomalies_ (5xx spikes on a route). Rules scope by
  project, alert type, metric, HTTP status code, and route. Two noise controls
  matter: **platform-defined minimum activity thresholds** (low-volume traffic
  can't produce an anomaly at all — not user-configurable, deliberately) and
  **silencing rules** that make detection skip matched traffic entirely rather
  than firing-and-hiding. Delivery to dashboard, email, Slack, webhook.
- **Netdata** — 18 unsupervised ML models per metric, trained and evaluated **at
  the edge** on the agent, on by default in every tier. Distributed: no central
  training pipeline to run.
- **VictoriaMetrics `vmanomaly`** — centralized service, configurable models
  including an **online z-score with a decay factor**, emitting a single unified
  `anomaly_score` metric. The alerting is then _ordinary threshold alerting on
  that derived metric_ via vmalert/Alertmanager. (Enterprise-licensed, so it's a
  design reference, not a dependency.)
- **OpenSearch / Elastic** — streaming Random Cut Forest over shingled series;
  same output shape (a score), same downstream (threshold rules).
- **Prometheus / Alertmanager** — no anomaly detection at all, but the mature
  noise-control primitives: `for:` duration before firing, grouping, inhibition,
  and silences.

**The consistent architecture across all of them:** anomaly detection produces a
**derived score series**, and the existing threshold-alerting stack consumes it.
Nobody builds a second alerting pipeline. That is directly reusable here —
`fireMetricRules` in `src/telemetry/alerts.ts:417` already is that stack.

### 2.3 Recursion protection

- **AWS Lambda** — the reference implementation. An X-Ray trace-header **lineage**
  counter is incremented by supported SDK/service integrations as an event flows
  Lambda → SQS/SNS/Lambda-invoke → Lambda. Past **16** invocations of the same
  triggering event, Lambda drops the next invocation, emits the
  `RecursiveInvocationsDropped` CloudWatch metric, and returns
  `RecursiveInvocationException` to synchronous callers. On by default;
  configurable per function via `PutFunctionRecursionConfig` /
  `GetFunctionRecursionConfig` (`Terminate` | `Allow`). Limits: only the supported
  services, only with SDK versions that propagate the header, and it does not
  catch a loop where the function synthesizes a _new_ event each hop.
- **Vercel** — lighter and header-based rather than counter-based: outbound
  requests carry the `x-vercel-id` of the request that originated them, so a
  function fetching itself is detectable. Covers `fetch` and the `http` module in
  the Node runtime, **including inside dependencies**; a bare `Socket` is not
  protected. No code change required, but a redeploy is. Free on all plans.
- **Cloudflare** — no lineage primitive. What exists is adjacent: per-invocation
  subrequest caps (free: 50 external + 1000 to Cloudflare services; paid: 10,000
  by default, raisable to 10M via the Wrangler `limits` config), and
  `cf.worker.upstream_zone` in the Rules engine to distinguish a same-zone Worker
  subrequest from a direct eyeball request. That field exists precisely because
  same-zone Worker subrequests otherwise look like fresh traffic — which is also
  why a loop is expensive: **every hop is a fully billed request**.

**Applies to Lunora Cloud:** Cloud is better placed than a generic Workers user,
because **all tenant traffic transits one dispatcher** (`src/dispatcher/worker.ts`).
A Lambda-style lineage counter is implementable there without any tenant code
change: stamp a lineage header on the way in, propagate it, refuse past a depth.
The honest limitation to write down up front: it catches loops that **re-enter
through the dispatcher** (worker → its own hostname → dispatcher → worker, which
is the common accidental case and the expensive one). It does not see
DO-to-DO calls or direct service bindings, which never touch the dispatcher.

### 2.4 Billing usage APIs agents can query

- **Lago** (OSS, self-hostable) — API-first metering + billing; every feature has a
  REST endpoint, notably `GET /customers/{id}/current_usage` for _in-period_ usage
  before an invoice exists, plus webhooks for invoice/usage events. The important
  design point is that current-period usage is a first-class endpoint, not a
  side-effect of invoicing.
- **OpenMeter** (OSS) — CloudEvents ingest → Kafka → ClickHouse, with **one-minute
  tumbling window pre-aggregation** so the query API answers in real time; exposes
  balance/entitlement reads intended for gating, not just reporting.
- **CloudKitty** — fetchers / collectors / rating modules as separate pluggable
  stages; the value for us is the separation, not the code.
- **OpenCost** — allocation API, no governance. Again: meter ≠ guardrail.

**Applies to Lunora Cloud:** this is the cheapest of the five. The data is already
there (`usage.summary`, `src/billing/spend.ts`, `lunora/cloudflare-billing.ts`),
and there is already an agent transport — `src/mcp/tools.ts` exposes control-plane
routes over `/v1/mcp` with **per-route `RouteSpec.mcp` opt-in** and a hard
deny-list for `tokens`/`auth`/`mcp`. Making usage agent-queryable is mostly
opting the right routes in and adding a projected-spend field, not new
infrastructure. Note the deny-list is the security boundary to respect:
`/v1/cloudflare-billing` is a _write_ route holding a credential and must stay
denied; the read side (`status`, `summary`) is the part to expose.

### 2.5 What Cloudflare actually gives you to block traffic and usage

Read off the docs, not inferred. The mechanisms, ordered by **where in the
request pipeline they intercept** — which is the same as ordering them by what a
blocked request costs, because only requests that reach a Worker are billed.

The [phase order](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/)
is: `ddos_l4` (packets) → … → `ddos_l7` → `http_request_firewall_custom` →
`http_ratelimit` → … → Workers.

| Mechanism                                      | Intercepts at                       | Cost of a blocked request                                      | Granularity                                                                    | Gate                                                  |
| ---------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| L3/L4 + HTTP DDoS managed rulesets             | packet / `ddos_l7`                  | **none**                                                       | attack-shaped traffic only; sensitivity + action overridable                   | all plans, unmetered; advanced config Business+       |
| **WAF custom rule, _Block_**                   | `http_request_firewall_custom`      | **none — never reaches the Worker**                            | any Rules-language expression, including `http.host`                           | all plans; rule count varies by plan                  |
| Rate limiting rules                            | `http_ratelimit`                    | **none**                                                       | Free: path + IP, 10 s windows, 1 rule. Business+: host, method, longer windows | Pro+ for anything usable                              |
| Custom **list** (`http.host in $suspended`)    | as above, one rule for many hosts   | none                                                           | thousands of hostnames in a single rule                                        | **hostname lists are Enterprise-only**                |
| WfP **custom limits** (`{cpuMs, subRequests}`) | inside the invocation               | request **is** billed; the Worker throws                       | per user Worker, per invocation                                                | Workers for Platforms (already used, `worker.ts:117`) |
| **Outbound Worker**                            | every `fetch()` a user Worker makes | subrequests aren't billed anyway; saves the _downstream_ spend | per namespace; sees all egress, and **disables `connect()`**                   | Workers for Platforms                                 |
| Delete / retag the script in the namespace     | `dispatcher.get()` throws           | 1 dispatcher request                                           | per tenant; **tags** enable bulk-by-customer operations                        | Workers for Platforms                                 |
| Dispatcher 503 (**what Cloud does today**)     | inside the dispatch Worker          | **1 WfP request + CPU, on every request**                      | per tenant                                                                     | —                                                     |

Three things follow directly:

1. **The current suspension is the most expensive option on the list.** Under a
   sustained attack on a suspended tenant, Cloud pays for every 503 it serves.
2. **A WAF _Block_ can keep the UX.** Custom Block responses support a
   `application/json` body with a custom status code, so the "see your billing
   page" payload the dispatcher returns today can be served by the rule itself.
3. **The blocker for list-based blocking is plan, not API.** Hostname lists are
   Enterprise-only, and per-plan custom-rule counts are small — so scaling
   "block N suspended tenants" needs either an Enterprise zone, or (cheaper, and
   available today) deactivating the tenant's **Cloudflare for SaaS custom
   hostname**, which stops the request at the edge with no rule at all.

Also worth writing down: rate limiting rules are explicitly _not_ a meter —
"not designed to allow a precise number of requests", counters are per-data-centre
with a delay of up to a few seconds, so excess requests can still land. They are
a mitigation, never an accounting mechanism.

- **Cloudflare DDoS** — "unmetered and unlimited DDoS protection at layers 3, 4,
  and 7 to **all customers on all plans and services**" (verbatim from
  [the docs](https://developers.cloudflare.com/ddos-protection/about/)).
  Overrides set a different action (log/block/challenge) or **sensitivity level**
  per rule, at zone or account level — account-level overrides are **API-only**.
  Adaptive DDoS Protection additionally profiles origin errors (default
  sensitivity ~1,000 errors/sec) and mitigates deviations.
- **CrowdSec** (OSS) — the architecture worth copying: **detection is separated
  from enforcement**. A central agent parses logs and makes decisions; "bouncers"
  enforce at the edge (block, captcha, throttle, or even flip Cloudflare's attack
  mode on demand). Crowdsourced IP reputation on top.
- **Coraza** (OSS, Go, ModSecurity/OWASP-CRS successor) and **fail2ban** — the
  request-inspection and ban-on-pattern layers; lower ceiling than a network with
  anycast capacity, which is the part you cannot self-host.

**Applies to Lunora Cloud:** Cloud gets the L3/L4/L7 floor for free by
construction — every tenant is behind Cloudflare, so the claim is true on day one
without building anything. But "true and invisible" isn't a feature. The work is
(a) surfacing per-tenant firewall events in the console, (b) programmatic
per-org ruleset sensitivity via the account-level override API, and (c) closing
the CrowdSec loop — the anomaly detector from §2.2 is the "agent", and the
existing suspension machinery plus a Cloudflare rate-limit rule are the
"bouncers".

### 2.6 On "OpenCloud"

The named project (`opencloud-eu`, the Heinlein Group's Go rewrite of ownCloud
Infinite Scale) is a **file sync & share** platform. It has no spend-cap,
metering, function-recursion or DDoS surface, so it is not prior art for any of
the five. The relevant OSS neighbourhood is the metering/billing/FinOps cluster
(Lago, OpenMeter, Kill Bill, CloudKitty, OpenCost) and the detection/enforcement
cluster (CrowdSec, Coraza, Netdata, VictoriaMetrics, Prometheus) — covered above.

### 2.7 The streaming-data substrate

Vercel's own framing is that all five rest on realtime ingest. The OSS consensus
stack for that is Kafka → ClickHouse with pre-aggregated tumbling windows
(OpenMeter, Lago) or Prometheus remote-write → a long-term store (Netdata,
VictoriaMetrics). Cloud's substrate is Analytics Engine + the AE SQL API + Tail
Workers (`tail.wrangler.jsonc`) + the `platformUsage` D1 ledger.

That is a legitimate choice — AE writes are fire-and-forget and free of
backpressure, which is exactly what a request-path meter needs — but it comes with
two properties that must be designed around rather than discovered:

1. **Sampling** (the §0 finding). Aggregate correctly or don't bill on it.
2. **Bounded retention** (~90 days) and bucket-averaged reads. Fine for trends and
   for month-scoped billing periods; not a system of record for anything longer.

The `platformUsage` ledger is the durable side and already compacts closed periods
(`lunora/usage.ts` `rollup`), so the shape is right — it just has to be fed
accurate numbers.

## 3. Existing seams (do not reinvent)

| Seam                                                               | Use it for                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/billing/spend.ts` `evaluateSpendCap`                          | Extend to return a `level` (`ok` \| `warn` \| `breach`) rather than adding a second evaluator.   |
| `lunora/usage.ts` `enforceSpendCaps` + `lunora/crons.ts:21`        | The sweep. Add the soft-threshold branch here; do not add a second cron.                         |
| `src/dispatcher/worker.ts` `resolveTenant` / `planResolver`        | Already a per-request control-plane lookup — the admission point for a fast cap and for lineage. |
| `src/dispatcher/worker.ts:117` per-plan `limits`                   | Where a depth cap belongs, alongside CPU/subrequest limits.                                      |
| `src/telemetry/alerts.ts` `fireMetricRules`, `rateOfChangePercent` | The alerting stack an anomaly score feeds into; the rate-of-change primitive already exists.     |
| `lunora/alerts.ts` rule CRUD + 4 channels (email/webhook/Slack/PD) | Delivery. New targets are new `RuleTarget` values, not a new pipeline.                           |
| `src/mcp/tools.ts` `RouteSpec.mcp` opt-in + deny-list              | Agent-queryable billing. Opt routes in; keep `/v1/cloudflare-billing` (write) denied.            |
| `lunora/cloudflare-billing.ts`                                     | Authoritative per-org Cloudflare spend, already decrypt-at-edge and fail-open.                   |
| `src/billing/overage.ts` + `src/billing/reconcile.ts`              | Prepaid-credit exhaustion already drives suspension/recovery — the same hooks a cap should use.  |
| `lunora/audit-log.ts`                                              | Every cap/suspension transition is already expected to land here (`organization.suspend`).       |

## 4. Design decisions

**D1 — Fix the meter before building on it.** ✅ **Done.**
`src/metering/analytics.ts` now reads `SELECT index1 AS scriptName,
SUM(_sample_interval) AS requests … GROUP BY scriptName`. Chosen over multiplying
`double1` because the dispatcher indexes by `scriptName` and writes exactly one
data point of value 1 per request, so summing the interval over an index field is
the _exact_ count, not an estimate. Chosen over "leave it, sampling only matters
at volume" because volume is the case the cap exists for. Pinned by a test that
asserts the emitted SQL, since the failure is silent — a wrong aggregation
returns a plausible number, never an error.

**D1b — Price the whole bill, at marginal rates, without per-org allowances.**
✅ **Done** (see §4a). Three sub-decisions worth their rejected alternatives:

- _Rate card as data, not arithmetic in the evaluator._ `RATE_CARD` in
  `src/billing/spend.ts` carries one entry per Cloudflare billing dimension with
  the published rate string beside the derived integer, so a Cloudflare price
  change is a one-line diff checkable against the pricing page. Chosen over
  hand-written per-meter formulas, which is what let the old model quietly cover
  two dimensions out of thirty-five.
- _Integer nano-cents, rounded once._ Rates are held as nano-cents per unit
  (1 cent = 1e9) and accumulated before rounding. Chosen over cents-per-million
  floats because the cheapest published rate ($0.001 per million rows read) is
  1e-7 cents per unit; rounding per meter would floor every row-read roll-up to
  zero forever.
- _Included allowances are **not** subtracted per org._ Cloudflare's free tiers
  are granted once to _the platform's_ account, not once per tenant, so
  subtracting a full allowance per org would let a hundred free orgs each
  "spend" the entire included tier and stay under cap. Every unit is priced at
  the marginal overage rate. That over-estimates a small tenant's true
  incremental cost — the correct direction for a blast-radius control, which
  should fire early rather than late.

**D1c — The cap prices more than the invoice does, on purpose.** The cost model
covers the full rate card; the customer-facing overage rate card
(`src/billing/overage.ts`) still prices requests + CPU only. So an org can be
capped for spend it was never charged for. Chosen over widening the overage rate
card to match: what a customer is _billed_ is a pricing decision for the
operator, not a side effect of a correctness fix. Both sides now carry a comment
naming the asymmetry so nobody "fixes" one to match the other by accident.

**D2 — Two thresholds, org-configurable, not one plan-derived number.** Add
`spendWarnMinor` beside the existing `spendCapMinor` (`lunora/schema.ts:66`) and
have `evaluateSpendCap` return a level. Chosen over Supabase's boolean (too coarse
for a control plane that also has prepaid credits) and over Vercel's
free-form action list (premature — one action, notify, is what's missing).

**D3 — Warn is a notification, breach is the existing suspension.** Route the warn
level through `lunora/alerts.ts` as a new `RuleTarget` (`spend`) so it inherits
email/webhook/Slack/PagerDuty delivery for free. Chosen over a bespoke email path
in the billing module: a second delivery mechanism is exactly the centralization
the repo conventions warn against.

**D4 — Keep the hourly sweep as the authority; add a fast path at admission.** The
cron stays the source of truth for the ledger comparison, but `resolveTenant`
already does a per-request plan lookup, so a breached org can be short-circuited
there in the same read. Chosen over moving enforcement wholly to the request path
(a per-request usage sum is not affordable) and over shortening the cron interval
(more D1 sweeps, same worst-case lag).

**D5 — Anomaly detection emits a score; the existing rules consume it.** Compute a
per-(org, metric) rolling baseline and emit an anomaly score as a derived metric;
add `usage_anomaly` / `error_anomaly` rule targets that threshold _that_. Chosen
over embedding statistics inside each rule evaluation (VictoriaMetrics/OpenSearch
both converged on the score-as-metric shape, and it keeps `fireMetricRules`
untouched).

**D6 — Start with online z-score + a minimum-volume floor; no ML.** An online
z-score with a decay factor is what `vmanomaly` ships as its baseline model and is
implementable over the existing observation arrays. Adopt Vercel's
platform-defined **minimum activity threshold** as a non-configurable floor:
below N requests in the window, no anomaly can fire. Chosen over Netdata-style
multi-model ML (no training substrate on Workers, and unjustifiable before a
single detector has proven its false-positive rate).

**D7 — Recursion protection belongs in an Outbound Worker, not on dispatcher
re-entry.** _(Revised after reading the Workers-for-Platforms docs; the original
form of this decision is below, and was worse.)_ An
[Outbound Worker](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)
sits between a user Worker and the public internet and sees **every** outgoing
`fetch()`, with per-invocation context passed down from the dispatch Worker via
the binding's `parameters`. So the dispatcher stamps a lineage `{rootRequestId,
depth}` into the outbound parameters, and the Outbound Worker refuses a request
that would re-enter the tenant's own hostname past a depth cap — `508 Loop
Detected`, plus a metric and audit event. Per-org config `terminate` (default) |
`allow`, mirroring Lambda's `PutFunctionRecursionConfig`. Depth cap starts at 16,
Lambda's number, rather than an invented one.

Chosen over the original design (stamp a header, catch the loop when it
re-enters the dispatcher), which was strictly worse in three ways: it only saw a
loop after paying for the hop, it required the tenant's code to propagate a
header it knows nothing about, and it missed loops to a non-dispatcher target.
Chosen over Vercel's identity-match (`x-vercel-id` self-match) because a counter
catches A→B→A cycles, not just direct self-calls. Chosen over relying on
subrequest caps because those are per-invocation and a loop is many invocations.

A bonus the docs make explicit: enabling an Outbound Worker **disables the
`connect()` TCP-socket API** for user Workers, so all egress must go through it.
That closes exactly the hole Vercel documents as unprotected ("requests using
the bare `Socket` constructor are not protected against recursion").

**D8 — Document the blind spot in the same change.** Durable-Object-to-Durable-Object
calls and service bindings are not `fetch()` to the internet, so they do not pass
through the Outbound Worker. Write it down where the feature is described; AWS's
own docs lead with the equivalent caveat, and an undocumented gap here reads as a
guarantee we don't have.

**D9 — DDoS: surface and configure, don't build.** No mitigation code. Ship (a) a
firewall-events read into the console via the Cloudflare GraphQL Analytics API,
(b) per-org L7 sensitivity overrides through the account-level managed-ruleset
API, and (c) an anomaly → Cloudflare-rate-limit-rule action, which is the CrowdSec
detect/enforce split with Cloudflare as the bouncer. Chosen over any self-hosted
WAF: anycast capacity is the part that cannot be reimplemented, and it is already
under every tenant.

**D11 — Promote suspension from a dispatcher 503 to an edge block.** Suspension
should install a WAF _Block_ on the tenant's hostnames (custom JSON response
carrying the billing link, so the UX is unchanged) and keep the dispatcher 503
only as the always-works fallback. Chosen over leaving it as-is because the 503
bills a Workers-for-Platforms request for every request of an attack, which
inverts the purpose of a spend cap: the mechanism that exists to stop a runaway
bill is itself metered by the runaway. Two rungs of fallback, in order of
preference and availability:

1. **Deactivate the tenant's Cloudflare for SaaS custom hostname** — free, works
   on any plan, no rule budget consumed, stops the request at the edge.
2. **A single custom rule against a hostname list** (`http.host in $suspended`) —
   scales to thousands of tenants in one rule, but hostname lists are
   **Enterprise-only**, so this is gated on the platform zone's plan.

Chosen over a per-tenant custom rule: per-plan rule counts (5 on Free, 20 on Pro)
run out long before tenants do.

**D10 — Agent-queryable billing is an opt-in, not a new API.** Opt the existing
usage/spend/cost read routes into `RouteSpec.mcp` and add current-period
projection to the summary payload (Lago's `current_usage` shape: what's consumed
in the open period, before any invoice exists). Chosen over a new REST surface —
the MCP transport, auth, and deny-list already exist and are the thing agents
actually speak.

## 4a. What shipped (W0 + W1)

**W1 — AE metering aggregation.** `src/metering/analytics.ts` now aggregates
`SUM(_sample_interval)` over `index1`. Pinned by a test asserting the emitted
SQL, because a wrong aggregation here returns a plausible number rather than an
error and would never be caught by a value assertion.

**W0 — Full-bill rate card.** `src/billing/spend.ts` went from two hard-coded
constants to a 35-meter `RATE_CARD` covering every Cloudflare billing dimension
Lunora Cloud's products consume: Workers for Platforms, Durable Objects
(requests / duration / rows / SQL storage), D1, R2, Workers KV, Queues,
Workflows steps + storage, Vectorize, Workers AI Neurons, Analytics Engine,
Workers Logs + Logpush, Browser Rendering, Containers, and Images. Each entry
carries the published rate string beside the derived integer.

Deliberately absent, so the card never implies the platform tracks something it
does not: Hyperdrive (unlimited queries on Workers Paid — no marginal cost), R2
egress (free), and DNS/TLS/bandwidth (included on all plans). Workflows
invocations fold into `requests`/`cpuMs`, which bill at the same rates.

What it touched:

- `PeriodUsage` is now `Partial<Record<UsageMeter, number>>`; `estimatedSpendMinor`
  sums the whole card, and `spendBreakdown` returns per-product lines sorted by
  cost (what an agent-queryable usage API and a "why am I being charged" panel
  both need — one number names no product).
- `platformUsage.kind` widened from three literals to the full meter set
  (`lunora/schema.ts`, `lunora/usage.ts`, regenerated `_generated/*`), so the
  ledger can carry what the model prices.
- `enforceSpendCaps` now accumulates **every** meter instead of filtering to
  requests + CPU, and skips unknown kinds rather than throwing — the sweep that
  protects the platform from a runaway bill must not be the thing that crashes
  on an unexpected row.
- `usage.series` gained `costMinor` per day; a day whose spend was all Durable
  Object duration used to draw as a flat line at zero.
- `UsageSection.tsx` replaced the single storage stat row with a per-product
  cost breakdown.
- The schema union, the function validator, and `UsageMeter` are pinned together
  by a type-level assertion in `__tests__/spend.test.ts`, so adding a meter in
  one place and forgetting another fails `lint:types` rather than production.

Gates: `tsc --noEmit` clean, 464/464 cloud tests pass.

## 5. Workstreams

| #   | Workstream                                                                                                                                                                                                            | Size | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- |
| W0  | ✅ **Full-bill rate card** (D1b, D1c) — 35-meter `RATE_CARD`, widened ledger, per-product breakdown. **Done** — see §4a.                                                                                              | M    | —          |
| W1  | ✅ **Fix AE metering aggregation** (D1) — `SUM(_sample_interval)` over `index1`, with a test asserting the emitted SQL. **Done** — see §4a.                                                                           | S    | —          |
| W2  | **Soft cap** (D2, D3) — `spendWarnMinor` field, `evaluateSpendCap` → `level`, `spend` alert target, warn branch in `enforceSpendCaps`, console control.                                                               | M    | W1         |
| W3  | **Fast-path breach at admission** (D4) — carry the breach bit through `resolveTenant`'s plan lookup.                                                                                                                  | S    | W2         |
| W4  | **Anomaly score + targets** (D5, D6) — rolling baseline store, online z-score, min-volume floor, `usage_anomaly` / `error_anomaly` rule targets, silence rules.                                                       | L    | W1         |
| W5  | **Recursion protection** (D7, D8) — Outbound Worker on the dispatch namespace, lineage in the outbound `parameters`, depth cap, `508` + metric + audit event, per-org `terminate`/`allow`, docs incl. the blind spot. | M    | —          |
| W6  | **Agent-queryable billing** (D10) — MCP opt-in on the usage/spend/cost reads + current-period projection (`spendBreakdown` is the payload).                                                                           | S    | W0         |
| W7  | **DDoS visibility & config** (D9) — firewall-events read, per-org L7 sensitivity override, anomaly → rate-limit-rule action.                                                                                          | M    | W4         |
| W8  | **Edge-block suspension** (D11) — deactivate the custom hostname on suspend (and reactivate on recovery); WAF-list block where the zone plan allows; keep the 503 as fallback.                                        | M    | —          |

W0 and W1 are done. W2/W3/W4/W6 read the ledger those two corrected. W5 and W8
are independent of everything else and of each other — the two best candidates
to run in parallel.

## 6. Platform parity

Nothing here adds a `ctx.*` surface or a provider binding — this is control-plane
work in `apps/cloud`, which is a Cloudflare-only application, not a framework
package. `PlatformCapabilities` in `@lunora/platform` is therefore untouched.

The one item to re-check if it ever generalises is **W5**: dispatcher-enforced
lineage depends on Workers-for-Platforms dispatch namespaces, which have no
`@lunora/platform-node` equivalent. If recursion protection is ever pulled down
into the framework (e.g. as a `ShardHost` concern), it needs a capability row
rated `native` for Cloudflare and `unsupported` for Node at that time. It does not
need one now, and adding a row for a surface that doesn't exist would be the
premature-abstraction the conventions warn against.

## 7. Open questions

1. ✅ **Answered — the cap prices the whole bill.** `RATE_CARD` covers all 35
   dimensions (§4a). The follow-on question stays open: **should a connected org's
   cap read the authoritative Billable Usage numbers instead of the estimate?**
   More accurate, more coupled, and bounded by three documented limits — Billable
   Usage is Pay-as-you-go-only, needs the Billing read scope, and is
   billing-cycle-aligned rather than calendar-month-aligned (§1). A hybrid
   (authoritative where connected, estimate everywhere else) means two period
   definitions in one comparison, which is where this would go wrong.
   1b. **Nothing populates the new meters yet.** The rate card prices 35
   dimensions; the only meter with a live writer is `requests` (the AE readback).
   Everything else reaches the ledger only if a tenant self-reports it over
   `POST /v1/usage`. The cap is therefore _capable_ of seeing a storage-shaped
   runaway and does not yet _see_ one. Closing that needs per-meter collectors —
   Durable Object and D1 metrics via the GraphQL Analytics API, R2 via bucket
   metrics — which is its own workstream and deliberately not folded into W0.
2. **Should breach degrade rather than suspend?** Today it's a 503 for the whole
   org. A read-only mode (queries serve, mutations reject) is strictly friendlier
   and is what a "hard cap" arguably should mean for a database-shaped product.
   Costs a third plan sentinel alongside `"suspended"`.
3. **Per-project caps?** Vercel pauses _all_ projects; Convex disables _all_
   projects. Both chose team scope. Matching that is cheaper and matches how
   `platformUsage` is keyed (org, not project) — but the ledger does carry
   `deploymentId`, so per-project is not blocked, just unbuilt.
4. **Where does the anomaly baseline live?** AE's ~90-day bounded retention and
   bucket-averaged reads make it a poor baseline store. A small rolled-up
   baseline table in the control-plane D1 is the obvious alternative; sizing it
   is W4's first question.
5. **Does the lineage header survive tenant code?** A tenant Worker that constructs
   a fresh `Request` without copying headers drops the lineage. Lambda has the
   same class of gap (unsupported SDK versions don't propagate). Accept and
   document, or have the dispatcher re-derive depth from a short-TTL KV/DO counter
   keyed by root request id — more robust, more expensive, per-request.

## 8. Sources

Spend caps — [Vercel Spend Management](https://vercel.com/docs/spend-management),
[Convex Teams](https://docs.convex.dev/dashboard/teams/teams),
[Supabase Billing FAQ](https://supabase.com/docs/guides/platform/billing-faq).

Recursion — [AWS: detecting and stopping recursive loops in Lambda](https://aws.amazon.com/blogs/compute/detecting-and-stopping-recursive-loops-in-aws-lambda-functions/),
[AWS: Lambda recursive loop detection APIs](https://aws.amazon.com/blogs/compute/aws-lambda-introduces-recursive-loop-detection-apis),
[Vercel: automatic recursion protection](https://vercel.com/changelog/automatic-recursion-protection-for-vercel-serverless-functions),
[Cloudflare: subrequest limits changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/),
[Cloudflare: rate-limiting troubleshooting (`cf.worker.upstream_zone`)](https://developers.cloudflare.com/waf/rate-limiting-rules/troubleshooting).

Anomaly detection — [Vercel: anomaly alert configuration](https://vercel.com/changelog/anomaly-alert-configuration-now-available),
[Vercel Alerts docs](https://vercel.com/docs/alerts),
[VictoriaMetrics anomaly detection models](https://docs.victoriametrics.com/anomaly-detection/components/models/),
[Netdata vs VictoriaMetrics](https://www.netdata.cloud/comparisons/victoriametrics/).

Billing/metering APIs — [Lago (GitHub)](https://github.com/getlago/lago),
[Lago: retrieve current usage](https://getlago.com/docs/api-reference/customer-usage/get-current),
[OpenMeter: how metering works](https://openmeter.io/docs/metering/events/how-it-works),
[OpenMeter on ClickHouse](https://openmeter.io/blog/how-openmeter-uses-clickhouse-for-usage-metering),
[CloudKitty architecture](https://docs.openstack.org/cloudkitty/latest/admin/architecture.html),
[OpenCost (GitHub)](https://github.com/opencost/opencost),
[OpenCost FAQ](https://opencost.io/docs/faq/).

DDoS — [Cloudflare HTTP DDoS managed ruleset](https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/),
[Cloudflare: configure HTTP DDoS protection via API](https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/configure-api/),
[Cloudflare Adaptive DDoS Protection](https://developers.cloudflare.com/ddos-protection/managed-rulesets/adaptive-protection/),
[CrowdSec (GitHub)](https://github.com/crowdsecurity/crowdsec),
[CrowdSec: mitigating DDoS](https://www.crowdsec.net/blog/mitigate-ddos-with-crowdsec).

Analytics Engine sampling — [Sampling with Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/sampling/),
[Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/),
[Usage-based billing recipe](https://developers.cloudflare.com/analytics/analytics-engine/recipes/usage-based-billing-for-your-saas-product/).

Blocking traffic & usage on Cloudflare (§2.5) — [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/),
[Monitor billable usage](https://developers.cloudflare.com/billing/manage/billable-usage/),
[Usage-based billing](https://developers.cloudflare.com/billing/understand/usage-based-billing/),
[Ruleset Engine phases list](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/),
[WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/),
[Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/),
[Custom lists (hostname lists are Enterprise-only)](https://developers.cloudflare.com/waf/tools/lists/custom-lists/),
[Workers for Platforms custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/),
[Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/),
[Workers for Platforms tags (bulk operations by customer)](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/tags/).

Pricing rate card (§4a) — [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/),
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/),
[Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/),
[Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/),
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/),
[Containers pricing](https://developers.cloudflare.com/containers/pricing/),
[Browser Rendering pricing](https://developers.cloudflare.com/browser-run/pricing/),
[Images pricing](https://developers.cloudflare.com/images/pricing/),
[Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/),
[How charges accrue](https://developers.cloudflare.com/billing/understand/how-charges-accrue/).

OpenCloud (assessed, not prior art) — [opencloud-eu discussion: distinction from oCIS](https://github.com/orgs/opencloud-eu/discussions/262).

> Cloudflare rates were read from the `cloudflare/cloudflare-docs` repository at
> `production` (the docs site itself is unreachable from this environment's
> egress proxy). Rates change; `RATE_CARD.published` carries the source string
> beside each derived integer so a re-check is a diff, not arithmetic.

## 9. Re-validation log

**2026-08-19.** The findings were re-checked twice: once against `alpha`
(`d18ccd96`, 795 upstream commits) and once again after re-stacking onto the
head of PR #85, which is where `apps/cloud` actually lives. Both passes used
`cloudflare-docs@1ee6060` (that day's `production`).

Held, unchanged:

- All 35 rate-card entries match the current pricing pages, verbatim.
- The four quoted doc claims still read as quoted: budget alerts "do not pause
  or cap usage"; "only requests that hit a Worker will count against your …
  bill"; DDoS "unmetered and unlimited … to all customers on all plans"; WAF
  hostname lists "only available to Enterprise customers".
- Cloudflare's own usage-based-billing recipe still uses `sum(_sample_interval)`
  (five occurrences), which is what the §0.1 fix was derived from.
- The dispatcher still writes one AE data point per request indexed by
  `scriptName`, the rollback still folds it into `platformUsage`,
  `enforceSpendCaps` still runs hourly, and the suspension path still serves a
  billed 503 from inside the dispatch Worker.
- `metrics-read.ts:9-14` still carries the "not for billing math" caveat that
  corroborates §0.1.
- Alert targets are still the same six, all static-threshold.
- Still no lineage / loop-detection / depth cap anywhere in `apps/cloud`.
- `currentPeriodStart()` still buckets on the UTC calendar month, so the
  billing-cycle mismatch in §1 stands.

**One finding was wrong and is corrected** (§1): `rateOfChangePercent` was
described as "exported and unused by any rule target". It is not unused — it has
one caller, `renderMetricAlert`, which renders the window-over-window change into
the alert body. It was already used that way at the original baseline, so this
was a research error, not upstream drift. The design consequence is unchanged and
slightly better: the primitive exists and is wired, it just informs the _message_
rather than the _decision_, so W4 promotes it from render-time to evaluate-time.

One citation was stale and is corrected: the enforcement cron moved from
`lunora/usage.ts:172` to `:220`, pushed down by W0's own widening of the meter
union. Every other `file:line` in this plan was re-resolved and still points at
what it names.

Upstream drift affecting the work: none, on either base.

The **alpha** pass touched only 7 of the 368 files that branch changed, none in
`apps/cloud`, and conflicted in four: `packages/runtime/src/create-worker.ts`
and `api-snapshots/runtime.api.md` (alpha's new `replicaReads` beside the cloud
line's `queueHandler` — both kept), `pnpm-lock.yaml` (discarded and regenerated,
never text-merged) and `plans/README.md` (both waves kept).

The **re-stack onto PR #85** then reduced this branch to its own 4 commits / 19
files, and conflicted in two — both places where PR #85 had already fixed a lint
error this plan had recorded as pre-existing, so its side was taken in each:
`UsageSection.tsx` (the dead `summary === undefined` guard, removed there) and
`__tests__/reconcile.test.ts` (`ControlPlaneDb` → `ControlPlaneDatabase`).

The plan was renumbered 306 → **365** and its wave 20 → **22**. Both numbers
were taken on **both** bases, so the renumbering is correct either way.
