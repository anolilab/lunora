# Lunora Cloud — Gap Analysis & Build Plan

> Written 2026-07-11. Consolidates three passes: the cloud-provider table-stakes
> review, CLOUD-PLAN.md §7 ("forgotten must-haves"), and the Zeitwork teardown
> (github.com/zeitwork/zeitwork, Apache-2.0 — patterns/code portable with
> attribution). Each gap states what exists today in `apps/cloud`, the design on
> our Workers-for-Platforms substrate, and its build status.

Legend: ✅ wired end-to-end here · 🧩 pure module, tested, **no production caller
yet** (logic exists; the wiring doesn't) · 🔨 code-tractable now (no live infra
needed) · 🌐 needs live Cloudflare/Creem/GitHub credentials · 🧭 decision, not code.

> **Legend note (2026-07-21).** An earlier revision used a single ✅ that
> conflated two very different states: "the pure evaluator/planner/port exists
> and is unit-tested" versus "the feature is actually wired and runs." Several
> ✅ items were in fact 🧩 — a tested function reachable only from `__tests__/`.
> The 🧩 marker now names that state explicitly. See the wiring pass below for
> the items that were 🧩 and have since been wired.

---

## Wiring pass — 2026-07-21

A review found the deploy pipeline could not produce a bootable tenant and that
the metering loop never closed. Four fixes (each: pure port-injected logic +
unit tests, verified by codegen + tsc + vitest):

- **Tenant bindings (✅ wired).** `POST /v1/deploy` built the provisioner spec
  with `bindings: {}`, so every uploaded Worker had no Durable Object binding and
  no `new_sqlite_classes` migration tag — a real Lunora app (always exports
  ShardDO) could never boot. The deploy request now carries the app's binding
  manifest (CLI reads it from `wrangler.jsonc`), floored to ShardDO server-side.
- **Resource teardown (✅ wired, scripts; 🌐 D1/R2).** The lifecycle crons only
  marked deployments `destroyed`; nothing deleted the Cloudflare dispatch script,
  so namespaces grew unboundedly (the leak Ring-2 claimed to have closed). A
  `teardownAt`-checkpointed sweep (`src/deploy/teardown.ts`) now deletes the
  script in `scheduled()`. Per-tenant **D1/R2** teardown-by-id still needs
  resource-id persistence — a real follow-up (🌐/🔨).
- **Metering readback (✅ wired).** The dispatcher wrote one Analytics-Engine
  data point per request, but `createHttpAnalyticsReader` had no caller, so
  `platformUsage` stayed empty and spend caps / usage views evaluated nothing.
  A per-cell `usageReadAtMs`-checkpointed delta rollback
  (`src/metering/rollback.ts`) now folds AE counts into the ledger in
  `scheduled()` (no double-count; under-count-not-over-bill on failure).
- **Build dispatcher (🧩 → logic wired, 🌐 execution).** `builds.claimNext` had
  no caller, so enqueued builds sat until the 24h expiry cron failed them. The
  claim→run→drain loop now exists and is tested (`src/builds/dispatch.ts`), but
  its production activation stays gated on the runner's 🌐 seams — `execute` (a
  Cloudflare Container running `lunora build`) and `fetchSource` (GitHub App
  tarball). Claiming builds with no executor would only burn them, so it is not
  yet wired into `scheduled()`. This is the one gap whose blocker is genuinely
  infra, not code.

---

## A. Deploy pipeline

### A1. Blue/green deploys + rollback (✅ shipped)

**Today:** `POST /v1/deploy` uploads the bundle over the _same_ script name; a
bad deploy replaces the good one instantly and there is nothing to roll back to.

**Design (Zeitwork's health-gated pointer swap, mapped to WfP):**

- Mint a **versioned script name per deployment** (`{project}-{kind}-v{n}`), so
  every deployment is its own immutable dispatch script.
- Keep an **active-deployment pointer** on the project (per kind). The
  dispatcher resolves hostname → project → active deployment → script.
- The orchestrator gains a **release phase**: upload the new script, **health
  check it through the dispatcher** (`GET /_lunora/health` with the deployment
  admin token), and only then swap the pointer and mark the previous deployment
  `superseded`. A failed health check never touches the pointer (the old
  version keeps serving) — the deployment ends `failed`.
- **Rollback = pointer swap** to any retained `superseded` deployment
  (`POST /v1/deployments/rollback`, `lunora rollback`). Retain the last N
  scripts per project; the preview-cleanup cron also prunes superseded scripts
  beyond the retention window.

### A2. Deployment timing state machine (✅ shipped)

**Today:** a single `status` column; no history of _when_ transitions happened.

**Design (Zeitwork):** add per-phase timestamps to `deployments`
(`queuedAt/provisioningAt/liveAt/failedAt/supersededAt/destroyedAt`), written by
`updateStatus`. Queue time, provision time, and time-to-live become dashboard
columns for free.

### A3. Server-side builds + build logs (✅ queue + dispatcher; 🌐 execution)

> **2026-07-21:** the claim→run→drain **dispatcher** (`src/builds/dispatch.ts`)
> now exists and is tested — `builds.claimNext` finally has a caller at the logic
> layer. It is not yet wired into `scheduled()`: activation is gated on the
> runner's container `execute` seam (below), and claiming with no executor would
> only burn builds. Everything around execution (queue, lease, dedup, log
> streaming, dispatcher) is code-complete; the container build itself is the 🌐.


**Today:** builds happen on the developer's machine; the platform never builds.
GitHub webhook only parses PR events into preview _intents_.

**Design (Zeitwork's pipeline, on Cloudflare Containers):**

- `builds` table: project/org, `commitSha`, `branch`, status
  (`pending/building/successful/failed`), a **work lease**
  (`processingBy` + `processingStartedAt`, stale after 30 min), `bundleHash`,
  `deploymentId`, `error`, per-phase timestamps.
- `buildLogs` table: build id, line, level, timestamp — **streamed line-by-line
  during the build** so the dashboard tails it live. ANSI is preserved and
  rendered client-side (Zeitwork's `ansi.ts` approach).
- **Bundle dedup by commit SHA** (Zeitwork's skopeo probe): if a successful
  build for `(project, commitSha)` already produced a `bundleHash`, skip the
  build and deploy the retained bundle.
- The build _runner_ is a port (`BuildRunner`): fetch the repo tarball (GitHub
  App installation token), run `lunora build` in a throwaway **Cloudflare
  Container** (our `@lunora/container` package is exactly this seam), capture
  logs, emit the bundle. The runner's container execution is 🌐; everything
  around it (tables, lease claim, log streaming, dedup, status flow) is 🔨.

### A4. Push-to-deploy via GitHub App (✅ model + webhook shipped, 🌐 App registration)

**Today:** HMAC-verified webhook parses `pull_request` events only; no
installation model; no push handling.

**Design (Zeitwork):** `githubInstallations` table (installation id ↔ org);
handle `installation created/deleted` webhook events; handle `push` on the
default branch → resolve head commit → create a `builds` row (A3) → build →
deploy. PR events keep creating TTL'd previews, now built server-side too.

## B. Traffic layer

### B1. Custom domains (✅ model/flow shipped, 🌐 cert issuance)

**Today:** `customDomains` is a plan _feature flag_ that nothing implements.

**Design (Zeitwork's verification flow + Cloudflare for SaaS):**

- `domains` table: hostname (unique), project/org, optional pinned deployment,
  `verifiedAt`, a **TXT verification token** (`_lunora.<domain>` must equal it),
  optional `redirectTo` + `redirectStatusCode` (redirect-only domains), custom-
  hostname id from the CF API.
- Verification: DNS-over-HTTPS lookup (1.1.1.1) checks the TXT record and that
  the hostname resolves to the platform — pure, injectable, unit-testable.
- Cert issuance/routing: Cloudflare for SaaS **custom hostnames** via the cell
  API token (port on `src/cloudflare/api.ts`). Issuance is only requested for
  **verified** domains (Zeitwork's DB-gated on-demand TLS, which prevents cert
  flooding).
- Dispatcher: hostname → `domains` → project → active deployment (A1 pointer),
  with the same cached lookup pattern as the plan resolver.

### B2. Tenant runtime logs — full log management (✅ code shipped, 🌐 tail-consumer wiring)

**Shipped this pass — the framework now emits structured, trace-correlated logs
(`shared/log-event.ts`, `@lunora/do`'s `emitLogEvent`), so the whole log path was
upgraded to consume them:**

- **Producer (the missing piece).** `src/tail/worker.ts` — the dispatch-namespace
  tail worker. It decodes each tenant `{ source: "lunora", type: "log" }` console
  event (`src/tail/parse.ts`, pure + unit-tested), groups them per script, and
  POSTs the batches to `POST /v1/logs/tail`. It holds one platform secret
  (`LUNORA_TAIL_SECRET`), not per-org deploy keys; the route resolves each
  `scriptName` → org via `internal.logs.orgForScript` and stores through
  `internal.logs.ingestInternal`. Deployed from `tail.wrangler.jsonc`.
- **Store.** `tenantLogs` widened to the full `LogEvent` shape — the seven-tier
  severity (`trace`→`fatal`), `message`, structured `fields`, `functionPath`,
  `traceId`/`spanId`, `userId`, `shardKey` — plus a `(scriptName, createdAt)`
  index for tailing and a `(org, traceId)` index for log↔trace correlation.
- **Query.** `logs.list` gained server-side filters — `levels`, `functionPath`,
  `traceId`, free-text `search` (message / function / field values), a cursor,
  and a bounded `limit` — returning newest-first. `logs.listTraces` folds the
  recent lines by `traceId` (`src/telemetry/traces.ts`, pure + unit-tested) into
  per-trace summaries (root function, time span, line count, peak severity).
- **UI.** the Logs tab renders severity chips (filter), a search box, structured
  fields, and a short trace id per line. A **Traces tab** lists recent dispatch
  traces (newest-active first, red when a line erred) and drills each one into
  its timeline — every line in the trace, ordered, with the offset from the trace
  start (reusing `logs.list` filtered to the `traceId`).

**Still 🌐 (needs live infra):** the provisioner setting
`tail_consumers: [{ service: "lunora-log-tail" }]` on each tenant script (or the
namespace) at deploy time, and an end-to-end run against a live dispatch
namespace. D1 is fine at launch volume; the ingest seam still lets us re-point to
Analytics Engine / R2 later without touching consumers. Correlating an
`error`/`fatal` log line to the OTLP-derived Issue by `traceId` (the telemetry
path doesn't carry `traceId` yet) is the natural follow-up. The Traces tab is a
**log-reconstructed** timeline (no span durations): the OTLP ingest keeps only
error spans (→ Issues), so a true span-duration **waterfall** would need a
separate span store.

**Span store — Phase 1 shipped (a Langfuse-teardown follow-on, cleanroom).** The
OTLP ingest no longer discards non-error spans: `decodeObservations`
(`src/telemetry/otlp.ts`, pure + unit-tested) keeps EVERY span with its real
`startedAt`/`endedAt`→`durationMs` and `traceId`/`spanId`/`parentSpanId`, and
`telemetry.ingest` persists them to an `observations` table (retention-pruned by
`pruneObservations`, like `tenantLogs`) — the Langfuse "observations" model,
reimplemented on our schema (no Langfuse code; it's MIT-except-`ee/`, but a
Postgres/ClickHouse app doesn't port). **Phase 2 (next):** a `traces.list`/`get`
over `observations` with real aggregates, and a nested-tree waterfall (reusing
the framework Studio's own `foldTraces`/`TraceSpan`) to replace the log-derived
view. True *nesting* also needs the framework to emit `ctx.trace` child spans
over OTLP — today the runtime emits one flat span per RPC (no `parentSpanId`).

### B3. Debug header (✅ shipped)

`X-Lunora-Id: {cell}:{script}` stamped by the dispatcher on every response
(Zeitwork's `X-Zeitwork-Id`) — turns "which deployment served this?" support
tickets into a copy-paste.

## C. Money & abuse

### C1. Spend caps + suspension (✅ shipped)

**Today:** per-invocation CPU/subrequest limits only; nothing caps aggregate
monthly spend; a compromised free account can rack up unbounded usage.

**Design:** `organizations.spendCapMinor` (per-plan default, org-overridable) +
`suspendedAt`. The usage rollup evaluates period spend against the cap and
suspends the org (dispatcher's plan lookup already runs per-request — it gains
a `suspended` bit and serves 503 with a billing link). Unsuspend on
plan-upgrade webhook or support action. The AUP (🧭 legal doc) is the authority;
this is the mechanism.

### C2. Dunning / payment-failure lifecycle (✅ state machine shipped, 🌐 Creem config)

Payment-failure → email → grace period → suspend → delete, driven off
`@lunora/payment` webhook events. The state machine + crons are 🔨; Creem's
own retry/notification flows and real charge testing are 🌐.

### C3. Merchant of Record vs Stripe Tax (✅ decided: Creem MoR)

Creem (creem.io) is the platform's payment provider via
`@lunora/payment/creem`. As a Merchant of Record it is the legal seller and
calculates/collects/remits sales tax/VAT across 190+ jurisdictions — the
platform never inherits worldwide tax compliance. Product-based checkout
(Creem product ids in `LUNORA_CLOUD_PLANS.priceIds`), hosted billing portal,
`creem-signature` webhooks, sandbox via `CREEM_TEST_MODE`.

**Overage billing = prepaid credits (🧩 pure module, no caller).** Creem has no metered
subscription pricing (products are `recurring`/`onetime` only), but ships a
first-party credits ledger (per-customer accounts, idempotent credit/debit by
`reference`, balance/freeze) built for API metering. So overage is prepaid:
orgs buy credit packs (one-time Creem products; the purchase webhook credits
the account) and the platform debits usage beyond the plan's included quota —
`src/billing/overage.ts` (included quotas per plan, cost-plus overage rates,
watermark-delta debits that are crash-safe idempotent) + the `overageDebits`
watermark table. An exhausted balance degrades service via the existing C1
suspension machinery — no negative balances, no surprise invoices, and every
credit purchase is a normal taxed MoR sale. The Creem-backed
ledger adapter (`src/billing/creem-credits.ts`: balance/debit over
`customerCredits`, `applyCreditPurchase` creating the account seeded on first
buy), the fleet reconciliation driver (`reconcileAllOverages`: per-org failure
isolation, watermark-after-debit ordering, exhausted → suspension hook), the
`organizations.creditsAccountId` linkage, and 6 more tests exist and pass. But
**none of it has a production caller** (verified 2026-07-21): no cron invokes
`reconcileAllOverages`, and the billing webhook never calls
`applyCreditPurchase`. Those two are **code**, not credentials — 🔨, not 🌐 —
so the accurate status is 🧩: a tested module that never runs. Genuinely 🌐:
creating the credit-pack products against a live Creem account.

## D. Data & trust

### D1. Control-plane + tenant backups, PITR, restore runbook (🌐)

D1 Time Travel export to platform R2 in a _different_ cell, on a cron; tested
restore runbook. The single most-critical 🌐 item — the control-plane DB is the
crown jewel.

### D2. `lunora eject` — self-serve full export (✅ packaging core shipped)

Data-plane export/import RPCs already exist in the framework; the missing part
is the one-command CLI packaging (export all shards + D1 + R2 + scaffold a BYO
`wrangler.jsonc`). Portability is the trust feature that eases adoption.

### D3. Right-to-erasure / org offboarding (✅ shipped)

Delete-org must purge deployments (scripts, D1, R2), secrets, logs, backups
after a retention window, with an audit trail. GDPR obligation.

### D4. Cross-cell DR (🧭 then 🌐)

Cell = one CF account; posture: cross-account backups + documented
re-provision. Zeitwork's drain (create replacement → health-gate → atomic
pointer swap → delete old) is the shape for tenant cell-migration.

## E. Platform operations

### E1. Platform self-observability + status page + on-call (🌐 mostly)

Control-plane error rates, deploy queue depth, dispatcher latency, provisioning
failures → SLOs + alerts + external status page + incident runbook. The studio
observes tenants; nothing observes _us_.

### E2. Dispatcher canary (🧭 process)

The dispatcher is an account-level worker — Cloudflare gradual deployments
apply. Use them; a bad dispatcher push takes down a cell.

### E3. Staging cell + platform CI/CD (🌐)

A non-prod cell for end-to-end platform changes before they touch tenants.

### E4. ⭐ Fleet runtime versioning: fat vs thin tenant worker (✅ spike packaged + fat pipeline shipped; 🌐 probe run pending)

The runtime is bundled into each tenant worker; a security patch today means
rebuild + redeploy the fleet. Thin worker (central runtime via dynamic dispatch)
vs fat + forced-upgrade pipeline. Must be spiked before real tenants exist;
retrofitting fat→thin is a rewrite. A1's versioned scripts and A3's platform
builds are both _prerequisites_ for any forced-upgrade pipeline, so they hedge
this decision either way.

## F. Enterprise (sell-later, design-now)

- **Dashboard SSO (SAML/OIDC) + SCIM** (🌐) — `sso` plan flag exists, unwired.
  better-auth's SSO/OIDC plugins are the path.
- **SOC 2 roadmap, DPA, sub-processor list** (🧭).
- **EU data-residency toggle** — ✅ shipped: `organizations.create` takes a
  `jurisdiction` and places on a matching active cell.
- **Frontend hosting scope** (🧭) — host the tenant's static frontend (WfP
  static assets, one origin) or backend-only? Shapes B1 routing and the deploy
  API; decide with B1.

---

## Build order (this branch)

| #   | Gap                                                                                | Status           |
| --- | ---------------------------------------------------------------------------------- | ---------------- |
| 1   | A1 + A2 — versioned scripts, health-gated pointer swap, rollback, timing columns   | this session     |
| 2   | B1 — domains model, TXT verify, CF-for-SaaS port, router + studio                  | this session     |
| 3   | A3 + A4 — builds + build logs + lease + dedup, GitHub installations + push webhook | this session     |
| 4   | B2 + B3 — log ingest/query/retention + studio tab; dispatcher debug header         | this session     |
| 5   | C1 — spend caps + org suspension through the dispatcher                            | this session     |
| 6   | D3 — org offboarding purge flow                                                    | next             |
| 7   | C2 state machine, D2 eject CLI, F residency picker                                 | next             |
| 8   | 🌐 set: D1 backups, E1 observability, E3 staging cell, SSO                         | needs live infra |
| 9   | 🧭 set: C3 MoR, D4 DR posture, E4 fat-vs-thin spike, F frontend scope              | decisions        |

---

## Ring 2 (post-build integration pass, 2026-07-11) — ✅ shipped

Building ring 1 surfaced a second ring of gaps: seams _between_ the new
features and findings _in_ them. All code-tractable items shipped:

- **Hardened webhook-backed mutations.** GitHub installations moved to a
  staged-claim model (webhook stages with no org linkage; an owner/admin claims
  from the dashboard); `builds.recordPush` only accepts pushes whose
  installation is claimed by the project's org and caps unfinished builds per
  project (backpressure against webhook storms and spoofed spam).
- **`domains.add` enforces the `customDomains` entitlement** — a paid feature
  is now actually paid.
- **Audit coverage** for domain add/remove, rollback, deletion request/cancel,
  installation claims, and both suspension mechanisms (`system:spend-cap` /
  `system:dunning` actors).
- **Build → deploy handoff**: the runner's optional `release` port feeds a
  completed bundle into the health-gated blue/green pipeline; a failed release
  keeps the build successful (artifact stays reusable for dedup).
- **Queue self-healing + retention**: stale/never-claimed builds fail visibly
  (hourly cron); superseded releases beyond the rollback retention (3/project)
  are destroyed (6-hourly cron) so dispatch namespaces never grow unboundedly.
- **Server-built PR previews**: PR upsert events queue a build for the head
  commit through the same pipeline as pushes.
- **Per-environment secrets**: `all`/`production`/`preview`/`dev` scoping with
  kind-overrides-shared resolution at deploy time; studio picker included.
- **Studio polish**: rollback button on superseded releases, suspension +
  pending-deletion banners.
- **CRUD edges**: org rename, member role change (last-owner protected),
  project rename — all audited.

Deliberate leftovers: dunning _emails_ (Creem's own payment-retry
notifications cover the provider side; our suspension notice needs the
mail-capable edge path — 🌐),
control-plane PATs (decision: org-scoped deploy keys ARE the API tokens), and
the dispatcher cache's ≤60 s pointer-swap propagation (documented behavior; a
purge ping is a later optimization).

---

## Ring 3 (studio/UX pass from the Maple teardown, 2026-07-12)

Reference: github.com/MapleTechLabs/maple — an OTel observability platform
(NOT a deploy platform; no core overlap) with a best-in-class dashboard.
**FSL-1.1 with a Competing-Use clause: ideas only, zero code reuse.**

Shipped in this pass (own implementations):

- **Usage meters with included-vs-overage split** — plan-quota bars (amber at
  80%, red past the allowance) with the honest prepaid-credits overage label,
  wired to `INCLUDED_USAGE` + the live usage summary.
- **Daily usage chart** — `usage.series` (per-day buckets from the raw
  metering events) rendered by a zero-dependency SVG bar chart.
- **⌘K command palette** — tab navigation + actions, substring matching,
  full keyboard flow; state resets by remount, no libraries.

Backlog (ranked; all our-own-code):

1. **Alerting pillar** — rules (error-rate/latency/health on deployments),
   incidents, notification destinations (email/webhook). A whole product
   pillar; design against the platformUsage + tenantLogs streams.
2. **Deployment health charts on the project page** — request volume / error
   rate per deployment (needs status-code capture in the dispatcher metering
   first: add `outcome` blob to the AE data point).
3. **Log viewer upgrade** — severity chips, filter bar, virtualized list,
   log↔deployment correlation links.
4. **Design-system pass** — dark-first token palette, severity color ramp,
   consistent empty states with actionable copy (Maple's DESIGN.md rigor is
   the bar, not the source).
5. **Onboarding checklist** — first-run "create project → issue key → first
   deploy → see it live" checklist on the dashboard, replacing bare empty
   tabs.
6. **Time-range picker** — shared presets (1h/24h/7d/30d) across usage/logs
   once the data streams carry enough resolution.
7. **Deploy-key roll UX** — one-click roll (issue+revoke atomically) in the
   keys tab.
8. **MCP surface** — expose the control plane to agents (list projects,
   deployments, logs, trigger rollback) via `@lunora/mcp`; strong
   differentiator and cheap given the framework ships an MCP package.
9. **Integrations hub** — OAuth connect cards (GitHub App install, Creem
   portal) instead of bare settings fields.
