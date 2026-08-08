# Plan 306 — Cloud spend guardrails, anomaly alerting, recursion protection & agent-queryable billing

**Baseline:** `48366a2` (2026-08-08)
**Status:** TODO — research complete, build not started

Research pass over five capabilities Vercel shipped as a bundle (soft/hard spend
caps, anomaly alerting, function recursion protection, billing usage APIs for
agents, always-on L3/L4/L7 DDoS mitigation), mapped against the OSS prior art and
against what `apps/cloud` already has.

## 0. Headline finding

**Four of the five already have a working seam in `apps/cloud`; the fifth (recursion
protection) has no equivalent anywhere in the repo. But the spend-cap chain that
does exist is metering off a sampled source and reading it as if it were exact.**

`src/dispatcher/worker.ts:131` writes one Analytics Engine data point per tenant
request; `src/metering/rollback.ts` folds those counts into the `platformUsage`
ledger; `lunora/usage.ts:172` (`enforceSpendCaps`) evaluates that ledger against
the cap hourly and suspends the org. The read in that chain is:

```sql
SELECT blob1 AS scriptName, SUM(double1) AS requests FROM <dataset> …
```

— `src/metering/analytics.ts:55`. Workers Analytics Engine applies **adaptive
sampling at high write volume**: each retained row carries a `_sample_interval`
standing in for that many originals, and the documented aggregation is
`SUM(_sample_interval * double1)` (or, when grouping by an index field,
`SUM(_sample_interval)` for an _exact_ count). Summing `double1` bare under-counts
by the sample factor.

The repo already knows this — `src/telemetry/metrics-read.ts:9-14` says AE is a
sampling store and is explicitly "**not for billing math**" — but the metering
reader is exactly billing math, and it doesn't apply the multiplier.

The failure mode is directional and unlucky: sampling kicks in **at high volume**,
which is precisely the runaway-tenant / compromised-account scenario the hard cap
exists to stop. The harder a tenant hammers the platform, the more the ledger
under-reports, and the later (or never) the cap fires. Fixing this is a one-line
query change and is a prerequisite for every other item below — a hard cap on a
lying meter is not a hard cap.

The dispatcher writes `index1 = scriptName`, so the exact form is available:

```sql
SELECT index1 AS scriptName, SUM(_sample_interval) AS requests FROM <dataset>
WHERE timestamp > toDateTime(<since>) GROUP BY scriptName
```

## 1. Current state (audit)

| Capability               | Status in `apps/cloud`                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hard cap**             | ✅ shipped, single-valued. `src/billing/spend.ts` (pure evaluator, per-plan defaults `free $5` / `pro $200` / `enterprise` uncapped, org override), `lunora/usage.ts:172` enforcement cron. |
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
- **The spend number is an estimate, not a bill.** `src/billing/spend.ts:12-13`
  prices requests + CPU-ms at the Workers-for-Platforms cost basis. Storage,
  Durable Object duration, D1 rows, and R2 ops are not in the estimate at all —
  `platformUsage.kind` has a `storageBytes` variant but `estimatedSpendMinor` only
  reads `requests` and `cpuMs`.
- **A real cost source landed recently but is not wired to enforcement.**
  `lunora/cloudflare-billing.ts` (commit `48366a2`) reads the org's _own_
  Cloudflare account spend by product via the Billable Usage API. It backs a
  read-only console tab; nothing feeds it back into the cap decision.
- **Per-plan runtime limits already exist.** `src/dispatcher/worker.ts:117-119`
  passes Workers-for-Platforms `limits` (CPU + subrequests) per plan on
  `env.DISPATCHER.get(...)`. This is the natural mounting point for a lineage
  header and a depth cap.
- **A rate-of-change primitive already exists.** `src/telemetry/alerts.ts:271`
  (`rateOfChangePercent`) is exported and unused by any rule target — the seam a
  baseline-relative anomaly score would build on.

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

### 2.5 DDoS L3/L4/L7

- **Cloudflare** — L3/L4 (SYN floods, UDP amplification) is unmetered and free on
  **every** plan; the HTTP (L7) DDoS managed ruleset is likewise on every plan,
  with advanced configuration gated to Business/Enterprise. Overrides set a
  different action (log/block/challenge) or **sensitivity level** per rule, at zone
  or account level — account-level overrides are **API-only**. Adaptive DDoS
  Protection additionally profiles origin errors (default sensitivity ~1,000
  errors/sec) and mitigates deviations.
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

**D1 — Fix the meter before building on it.** Change
`src/metering/analytics.ts:55` to `SELECT index1 AS scriptName,
SUM(_sample_interval) AS requests … GROUP BY scriptName`. Chosen over multiplying
`double1` because the dispatcher indexes by `scriptName` and writes exactly one
data point of value 1 per request, so summing the interval over an index field is
the _exact_ count, not an estimate. Chosen over "leave it, sampling only matters
at volume" because volume is the case the cap exists for.

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

**D7 — Recursion protection as dispatcher-enforced lineage, Lambda-shaped.** Stamp
`x-lunora-lineage: <rootRequestId>:<depth>` on entry, propagate on tenant-originated
subrequests that re-enter the dispatcher, and refuse past a depth cap with
`508 Loop Detected` + an audit/metric event. Per-org config `terminate` (default)
| `allow`, mirroring `PutFunctionRecursionConfig`. Depth cap: start at 16
(Lambda's number, and empirically sufficient) rather than inventing one. Chosen
over Vercel's identity-match approach (`x-vercel-id` self-match) because a
counter also catches A→B→A cycles, not just direct self-calls; and over doing
nothing and relying on subrequest caps, because those are per-invocation and a
loop is many invocations.

**D8 — Document the lineage blind spot in the same change.** DO-to-DO calls and
service bindings bypass the dispatcher and therefore bypass this. Write it down
where the feature is described; AWS's own docs lead with the equivalent caveat,
and an undocumented gap here reads as a guarantee we don't have.

**D9 — DDoS: surface and configure, don't build.** No mitigation code. Ship (a) a
firewall-events read into the console via the Cloudflare GraphQL Analytics API,
(b) per-org L7 sensitivity overrides through the account-level managed-ruleset
API, and (c) an anomaly → Cloudflare-rate-limit-rule action, which is the CrowdSec
detect/enforce split with Cloudflare as the bouncer. Chosen over any self-hosted
WAF: anycast capacity is the part that cannot be reimplemented, and it is already
under every tenant.

**D10 — Agent-queryable billing is an opt-in, not a new API.** Opt the existing
usage/spend/cost read routes into `RouteSpec.mcp` and add current-period
projection to the summary payload (Lago's `current_usage` shape: what's consumed
in the open period, before any invoice exists). Chosen over a new REST surface —
the MCP transport, auth, and deny-list already exist and are the thing agents
actually speak.

## 5. Workstreams

| #   | Workstream                                                                                                                                                             | Size | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- |
| W1  | **Fix AE metering aggregation** (D1) — `SUM(_sample_interval)` over `index1`, plus a test asserting a sampled fixture sums to the un-sampled total.                    | S    | —          |
| W2  | **Soft cap** (D2, D3) — `spendWarnMinor` field, `evaluateSpendCap` → `level`, `spend` alert target, warn branch in `enforceSpendCaps`, console control.                | M    | W1         |
| W3  | **Fast-path breach at admission** (D4) — carry the breach bit through `resolveTenant`'s plan lookup.                                                                   | S    | W2         |
| W4  | **Anomaly score + targets** (D5, D6) — rolling baseline store, online z-score, min-volume floor, `usage_anomaly` / `error_anomaly` rule targets, silence rules.        | L    | W1         |
| W5  | **Recursion protection** (D7, D8) — lineage header, depth cap in the dispatcher, `508` + metric + audit event, per-org `terminate`/`allow`, docs incl. the blind spot. | M    | —          |
| W6  | **Agent-queryable billing** (D10) — MCP opt-in on the usage/spend/cost reads + current-period projection.                                                              | S    | W1         |
| W7  | **DDoS visibility & config** (D9) — firewall-events read, per-org L7 sensitivity override, anomaly → rate-limit-rule action.                                           | M    | W4         |

W1 gates W2/W3/W4/W6 — all four read the ledger it corrects. W5 is fully
independent and is the only item with no existing seam, so it is the best
candidate to run in parallel.

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

1. **Does the cap price the whole bill or just compute?** `estimatedSpendMinor`
   covers requests + CPU-ms only. Storage, DO duration, D1, and R2 are unpriced,
   so a storage-heavy runaway is invisible to the cap. Options: extend the
   estimate, or switch the cap to read the authoritative Billable Usage numbers
   from `lunora/cloudflare-billing.ts` for orgs that have connected an account
   (and keep the estimate as the fallback). The second is more accurate and more
   coupled — decide before W2 sets the schema.
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
[Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

OpenCloud (assessed, not prior art) — [opencloud-eu discussion: distinction from oCIS](https://github.com/orgs/opencloud-eu/discussions/262).
