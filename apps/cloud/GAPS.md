# Lunora Cloud — Gap Analysis & Build Plan

> Written 2026-07-11. Consolidates three passes: the cloud-provider table-stakes
> review, CLOUD-PLAN.md §7 ("forgotten must-haves"), and the Zeitwork teardown
> (github.com/zeitwork/zeitwork, Apache-2.0 — patterns/code portable with
> attribution). Each gap states what exists today in `apps/cloud`, the design on
> our Workers-for-Platforms substrate, and its build status.

Legend: ✅ shipped here · 🔨 code-tractable now (no live infra needed) ·
🌐 needs live Cloudflare/Stripe/GitHub credentials · 🧭 decision, not code.

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

### A3. Server-side builds + build logs (✅ core shipped, 🌐 execution)

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

### B2. Tenant runtime logs (✅ ingest/query shipped, 🌐 tail-worker attach)

**Today:** nothing observes a deployed tenant worker.

**Design:** a **tail worker** on the dispatch namespace batches
`console.*`/exception events to `POST /v1/logs/ingest` (deploy-key/admin
gated). `tenantLogs` table with a retention cap + cleanup cron; cursor-paginated
`logs.list` query; studio Logs tab tailing a deployment (ANSI-rendered).
D1 is fine at launch volume; the ingest seam lets us re-point to Analytics
Engine later without touching consumers.

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

### C2. Dunning / payment-failure lifecycle (✅ state machine shipped, 🌐 Stripe config)

Payment-failure → email → grace period → suspend → delete, driven off
`@lunora/payment` webhook events. The state machine + crons are 🔨; the Stripe
dunning configuration and real charge flows are 🌐.

### C3. Merchant of Record vs Stripe Tax (🧭)

Global sales-tax/VAT exposure. Decide before public launch; hard to unwind.

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

Deliberate leftovers: dunning _emails_ (Stripe Smart Retries covers the
provider side; our suspension notice needs the mail-capable edge path — 🌐),
control-plane PATs (decision: org-scoped deploy keys ARE the API tokens), and
the dispatcher cache's ≤60 s pointer-swap propagation (documented behavior; a
purge ping is a later optimization).
