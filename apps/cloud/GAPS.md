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

## Status pass — 2026-07-29

A re-verification of every non-✅ item against the code (not against this
document, which had drifted). Findings:

**Closed since the 2026-07-21 pass:**

- **A3 build dispatcher — now has a production caller.** `crons.ts` runs
  `internal.builds.dispatch` on the existing every-minute trigger, and the
  `execute`/`fetchSource` ports fail closed through `unconfigured()`. The
  earlier reason for leaving it unwired (claiming builds with no executor burns
  them) no longer applies. What remains is purely 🌐: a GitHub App (id +
  private key) and a build-container binding.
- **B2 tail-consumer wiring.** `src/deploy/handler.ts` passes `tailConsumers`
  into the provisioner spec; `src/cloudflare/api.ts` renders it as
  `tail_consumers` on upload. The section header still claimed this was 🌐.
- **Ring 3 backlog #3, #4, #6, #8** — log viewer, design-system pass,
  time-range picker, and MCP surface all shipped. See the restored list.

**Confirmed still open (code-tractable, no infra needed):**

| Item                  | Blocker     |
| --------------------- | ----------- |
| R3#9 integrations hub | Not started |

The rest of this list has since shipped — see the status pass below.

### Status pass — 2026-08-28

| Item                             | Now                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2 `lunora eject` CLI subcommand | ✅ **Shipped** as `lunora cloud eject <deployment-id> [--out]`. The packaging core moved to `packages/cli/src/util/eject.ts` (its output is files on the user's disk) and is fed by a new deploy-key-authorized `POST /v1/eject`, which unseals the tenant admin token at the edge and returns only the snapshot — so the CLI never holds a tenant bearer. |
| R3#2 deployment health charts    | ✅ **Shipped.** The blocker row above was stale: `outcome` (blob3) landed 2026-08-13. `src/telemetry/traffic-read.ts` reads the metering stream per script, so passing a single script name gives one deployment's volume, error rate and latency.                                                                                                         |
| R3#5 onboarding checklist        | ✅ **Shipped** — `lunora/onboarding.ts` + `src/client/OnboardingChecklist.tsx`, on the Projects tab until the org's first deployment is live. Derived from real rows, never stored.                                                                                                                                                                        |
| R3#7 deploy-key roll UX          | ✅ **Shipped** — `deploy_keys.roll` does issue+revoke in one transactional mutation, so neither the two-live-keys nor the no-keys window exists. Ingest keys are refused (their stored cipher would point at a revoked secret).                                                                                                                            |
| R3#9 integrations hub            | Superseded by the 2026-08-31 pass below — shipped.                                                                                                                                                                                                                                                                                                         |

Also shipped in that pass: a **Traffic tab** (`lunora/traffic.ts`,
`src/client/TrafficSection.tsx`) — visitors by country, top paths, response-code
breakdown, volume/bytes over time, a live request stream and true latency
percentiles. The AE data point gained `country`/`hostname`/`status` blobs and
`durationMs`/`bytes` doubles, appended so the billing rollup's `blob1`/`blob2`
positions never move.

Shipped since (2026-08-28, same pass):

| Item                                  | Now                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deployment protection on previews** | ✅ A per-project password gates every PREVIEW deployment at the dispatcher, before dispatch. The salted hash stays in the control plane (`POST /v1/tenants/preview-auth`); the dispatcher mints a signed, script-scoped cookie so later requests cost no round trip. Production is never gated. |
| **Staged rollouts (A1 follow-on)**    | ✅ `setRollout` / `promoteRollout` / `abortRollout` serve a candidate to a share of traffic alongside the active release. The split is deterministic per client and monotonic in the percentage, so advancing never moves anyone back. Error rate per script is already readable on Traffic.    |

### Audit pass — 2026-08-31

A review across correctness, security, performance, tests and debt, then the
fixes. What it turned up is worth recording as a shape, not just a list: **almost
everything severe was invisible to a green suite**, because the test doubles
modelled a store that no longer exists.

| Item                          | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Worker could not boot** | ✅ Two runtime-only defects, invisible to `lint:types`, codegen and 647 unit tests. `v.bigint()` on a `.global()` table is refused by `defineSchema` (a global table stores it as decimal TEXT, so `"100"` sorts before `"25"`); every table here is `.global()`, so the schema never constructed. And `patch(id, { field: undefined })` throws — nineteen fields across fourteen call sites, including `activate`, the last step of every deploy. |
| **Domain hijack**             | ✅ `markVerified` was a PUBLIC mutation taking `verified` as a caller boolean, so the edge route's DNS proof was decorative. With `by_hostname` globally unique, one tenant could claim a hostname it did not own, lock the real owner out platform-wide, and serve its own script there. Now `internalMutation`.                                                                                                                                  |
| **Admin proxy**               | ✅ Forwarded a caller-chosen path and verb to the tenant carrying that tenant's admin bearer; `..` escaped the admin prefix. A read-only `viewer` had write access. Path shape and method allow-listed, role list explicit.                                                                                                                                                                                                                        |
| **`recordIngestKey`**         | ✅ Took `hashedKey` as a caller input, so any live deploy key could mint an org-wide telemetry credential of its own choosing that outlived revocation. Internal now.                                                                                                                                                                                                                                                                              |
| **Fleet sweeps truncated**    | ✅ `ControlPlaneDatabase` had no cursor, so no `src/` sweep could drain. The overage reconciler under-billed past 1000 rows; teardown leaked dispatch scripts, D1 and R2; uptime stopped probing. Interface widened, `drainTable` added, four sweeps converted.                                                                                                                                                                                    |
| **Erasure purge**             | ✅ Covered 12 of 25 org-scoped tables while claiming all of them — leaving end-user telemetry, live alert destinations and the org's encrypted billing token orphaned. A test now diffs the list against the schema.                                                                                                                                                                                                                               |
| **Unindexed hot reads**       | ✅ `deployments` had no `organizationId` index despite three reads filtering on it; `members` none on `userId`, so the org switcher scanned the whole table per page load. `organizations.list`/`getBySlug` read one page of EVERY org and truncated silently.                                                                                                                                                                                     |
| R3#9 integrations hub         | ✅ **Shipped**, minimally — an Integrations tab listing the org's GitHub App installations, with the release (unclaim) action `claim` never had an inverse for.                                                                                                                                                                                                                                                                                    |
| **Project deletion**          | ✅ New. Projects could be created and renamed but never removed; the only exit was deleting the organization. Scoped rows are erased, deployments transition to `destroyed` so teardown still reclaims the real resources, and it is audited.                                                                                                                                                                                                      |
| **Browser coverage**          | ✅ First e2e for the control plane (`tests/e2e/cloud/`), running nightly. Covers sign-in, the org switcher, a project's Deployments tab and the Traffic tab's SSR/hydration seam.                                                                                                                                                                                                                                                                  |

**The lesson worth keeping.** Three separate fake stores here discarded `where`,
`limit`, `cursor` and the explicit-`undefined` guard the real store enforces —
so the truncation bug, the cross-org predicate and nineteen throwing patches were
all equally invisible, and a review pass reading the store internals concluded
the opposite of the truth. The doubles now model the real behaviour, and each
fix landed with the double that can catch it regressing. Coverage is measurable
for the first time (`test:coverage` existed nowhere in this app): 41% overall,
**24% across `lunora/`**, which is where the money and authorization live.

**Still open:** the dispatcher-facing `adminToken` routes are a real second
router seam, deferred to its own diff. Deploy-key `type` is now enforced as a
ceiling, which will 403 a tenant currently deploying production with a lower
scope — a product call, flagged rather than assumed.

### Status pass — 2026-08-30

Three loops that were each half-built, closed at the end nobody had reached.

| Item                             | Now                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rollout guard (A1 follow-on)** | ✅ `src/deploy/rollout-guard.ts`, on the every-minute tick. A staged rollout whose candidate returns materially more 5xx than the release it is replacing is aborted, audited as `deployment.rollout.auto_abort`, and notified. Judged against the ACTIVE release rather than a constant, because the two scripts are two builds of one app splitting the same traffic.                 |
| **Release-path notifications**   | ✅ A new `deploy` alert target. `builds.fail`, `deployments.updateStatus` (on the transition into `failed` only) and the rollout guard raise it. Previously the alert rules could only watch telemetry the tenant's own app had to send — so the one failure class where the app never starts could raise nothing.                                                                      |
| **Undelivered-alert drain**      | ✅ `src/telemetry/alert-drain.ts`, every minute. Sends `alerts` rows left in `firing` past a grace window. Release-path alerts are raised inside mutations, which have no `fetch`; this is also the first thing that re-sends an alert whose delivering request died mid-send, which used to be silently lost forever.                                                                  |
| **A4 commit-status write-back**  | 🌐 Code complete, infrastructure-blocked. `src/github/app.ts` mints an installation token and posts a `lunora/deploy` commit status; `runBuild` reports pending → success/failure through an optional port. Inert without `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` (`createGitHubApp` returns `null`) — and see the note below on why that credential alone does not make builds run. |

The commit-status half deserves an honest note, corrected from an earlier draft
of this row that overstated it. The App credential lights the **reporter** only.
`builds.dispatch` sets `fetchSource` and `execute` to `unconfigured()`
unconditionally, and `execute` additionally needs a build container that does not
exist — so provisioning the App id and private key does not make a single build
run. It only means that when the container does land, the loop is already closed
on our side.

Until both exist, a build fails at its first port on every push. Those failures
are deliberately **not** reported: `isUnconfiguredInfrastructure` suppresses both
the commit status and the `deploy` alert for them, because a red check reading
"build execution is not configured" on every push to every connected repository
teaches people to ignore the check and the page together. The failure is still
recorded on the build and in `buildLogs`.

**Unchanged 🌐 set** still includes D1 backups/PITR, which remains the
highest-risk item on this page and is still not built.

**A3/A4 remain the largest gap and share one blocker.** Server-side builds,
push-to-deploy, per-PR previews and dashboard deploys are all code-complete
except for `BuildRunnerPorts.execute` (`src/builds/runner.ts`) — the one
unimplemented port. It needs a container image running `lunora build` and
speaking the `@lunora/container` exec protocol; no Dockerfile exists in the repo
yet, so this is genuinely 🌐 rather than 🔨.

**Confirmed still 🧩 (logic exists, no caller):** `applyCreditPurchase`
(`src/billing/creem-credits.ts`) — unchanged, and genuinely gated on live Creem
credit-pack product ids.

**Unchanged 🌐 set:** A3 execution, A4 App registration, B1 cert issuance,
D1 backups/PITR (still the highest-risk item on this page), E1 platform
self-observability, E3 staging cell, F SSO/SCIM, R2-SQL span read-back,
cross-tab trace→logs / error-span→Issue links.

**Unchanged 🧭 set:** D4 DR posture, E2 dispatcher canary, E4 fat-vs-thin probe
run, F frontend-hosting scope, SOC 2 / DPA.

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
- **Resource teardown (✅ wired).** The lifecycle crons only marked deployments
  `destroyed`; nothing deleted the Cloudflare dispatch script, so namespaces grew
  unboundedly (the leak Ring-2 claimed to have closed). A `teardownAt`-checkpointed
  sweep (`src/deploy/teardown.ts`) now deletes the script in `scheduled()`.
  Per-tenant **D1/R2** are named from the project's stable **alias** (not the
  versioned script), so tenant `.global()` data persists across deploys and a
  rollback sees the same database; they are torn down **only when the alias has no
  remaining non-destroyed deployment** (project/org deletion) — never on a routine
  version prune. R2 delete is best-effort (a non-empty bucket needs an S3-API
  object purge this context lacks — logged for follow-up). **Caveat:** previews
  that reuse the production alias would share its D1; give previews a distinct
  alias for data isolation.
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
  **Superseded 2026-07-29 (see the status pass below):** the cron caller now
  exists — `internal.builds.dispatch` on the existing every-minute trigger — and
  both ports fail closed via `unconfigured()`, so an unconfigured platform no
  longer burns builds. The 🌐 blocker narrowed to supplying the two ports.

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

### B2. Tenant runtime logs — full log management (✅ shipped incl. tail-consumer wiring; 🌐 live end-to-end run)

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

**Still 🌐 (needs live infra):** ~~the provisioner setting
`tail_consumers: [{ service: "lunora-log-tail" }]` on each tenant script (or the
namespace) at deploy time~~ — **shipped**: `src/deploy/handler.ts` passes
`tailConsumers` into the provisioner spec, which `src/cloudflare/api.ts` renders
as `tail_consumers` on the script upload. What remains is an
end-to-end run against a live dispatch namespace. D1 is fine at launch volume; the ingest seam still lets us re-point to
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
Postgres/ClickHouse app doesn't port). **Phase 2 shipped:** `traces.list`/`get`
over `observations` (`lunora/traces.ts`) with real aggregates (latency, span +
error counts), and the Traces tab now renders a **real-duration nested
waterfall** — `buildTraceTree` (`src/telemetry/trace-tree.ts`, pure +
unit-tested) lays each span out by its true start/duration and indents it by its
depth under `parentSpanId`. The log-derived view (`logs.listTraces`) was removed.

**Full OpenTelemetry integration — shipped (branch `feat/cloud-otlp-full`,
2026-07-21).** The standard OTLP ingest is now complete and hardened, and the
framework emits deep + AI telemetry the cloud captures end-to-end:

- **Deep waterfalls (framework, already on alpha).** `ctx.trace` emits nested
  child spans with a real `parentSpanId` + timestamps, `ctx.metrics` → `/v1/metrics`
  — so the earlier "one flat span per RPC" note is obsolete; trees are deep.
- **AI generations (framework PR #160 → alpha).** `@lunora/ai` traces RAG embeds
  as `generation` spans; `@lunora/agent` gains an `otlpTelemetry` integration
  shipping `gen_ai.*` model/tool spans. The cloud store gained a `generation`
  observation kind (model, prompt/completion tokens, opt-in input/output); the
  Traces waterfall shows a `gen` chip + a **span-detail pane** (model/tokens/io/attrs).
- **Full OTLP transports.** `/v1/traces|logs|metrics` accept **protobuf** (a
  Worker-safe hand-rolled decoder — protobufjs needs eval, blocked in Workers)
  _and_ JSON (+ gzip), return `partialSuccess` when a batch is capped, and write
  metrics to Analytics Engine. gRPC stays out (Workers can't host it).
- **Hardened ingest.** A scoped `ingest` deploy-key capability (telemetry-only,
  can't deploy) + a per-org telemetry rate-limit tier + key-based PII redaction
  of span attributes / log fields.
- **Deploy-time wiring.** The provisioner injects `LUNORA_OTLP_ENDPOINT`/token +
  `tail_consumers` into each tenant (the long-documented gap), minting a per-org
  ingest key stored envelope-encrypted for re-injection.
- **Scale.** Spans tier to the columnar archive (Pipeline → R2/Iceberg) via
  `archiveSpans`, alongside D1's hot window.

**Still 🌐 / follow-on:** the R2-SQL **read-back** of archived spans (an action over
the Iceberg table, like the raw-event archive); a live end-to-end run against a
dispatch namespace with `LUNORA_OTLP_ENDPOINT` configured; cross-tab UI links
(trace→logs, error-span→Issue — needs dashboard tab-state + the framework carrying
`traceId` into `getIssues`); OTLP gzip on the framework's own POST (marginal).

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

**Overage billing = prepaid credits (✅ reconciliation wired; 🌐 self-serve purchase).** Creem has no metered
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
`organizations.creditsAccountId` linkage. **Reconciliation is now wired**
(2026-07-21): `sweepOverageReconciliation` runs on the 6-hourly bucket
(`src/billing/reconcile.ts` builds the per-org inputs + fleet ports over the
control-plane store; the Creem credits ledger is built from `CREEM_API_KEY`),
debiting each org's period overage, suspending the exhausted (`suspendedReason:
"overage"`), and lifting overage suspensions once a balance is restored
(`onRecovered`, self-healing). No-ops without Creem keys. **Still 🧩/🌐:**
`applyCreditPurchase` (self-serve credit-pack _purchase_) is not wired — the
billing webhook delegates wholly to `ctx.payments.handleWebhook`, and mapping a
pack purchase needs the live credit-pack **product ids** (the genuine 🌐) plus a
Creem-event seam. Until that lands, accounts are funded out-of-band; the
enforcement + recovery engine above already reacts to whatever balance exists.

## D. Data & trust

### D1. Control-plane + tenant backups, PITR, restore runbook (🌐)

D1 Time Travel export to platform R2 in a _different_ cell, on a cron; tested
restore runbook. The single most-critical 🌐 item — the control-plane DB is the
crown jewel.

### D2. `lunora eject` — self-serve full export (✅ shipped end to end)

Data-plane export/import RPCs already existed in the framework; the missing part
was the one-command CLI packaging. Now `lunora cloud eject <deployment-id>`,
writing `export.ndjson`, a BYO `wrangler.jsonc` and a restore README into
`./eject` (or `--out`). Portability is the trust feature that eases adoption, and
it is only a feature once a user can actually run it.

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
   incidents, notification destinations. A whole product pillar; design against
   the platformUsage + tenantLogs streams.
    - _Shipped:_ count-crossing rules (issue/incident/uptime) + metric-window
      rules (`error_rate`/`latency_p95`/`llm_cost`, edge-triggered). Metric rules
      evaluate both inline on telemetry ingest (fast feedback) **and** on a
      periodic every-minute sweep (`src/telemetry/sweep.ts`) over a shared
      `alertRuleState` latch, so a window that goes quiet (error rate falling to 0
      with no fresh spans) still fires/clears rather than latching forever.
      Delivery channels: `email`, `webhook`, `slack` (incoming-webhook JSON), and
      `pagerduty` (Events API v2) — the webhook-family channels reuse the
      `isSafeWebhookUrl` SSRF guard.

#### Infra-level alerts: lean on Cloudflare Notifications + Health Checks

The rules above are **app-semantic** — they watch the telemetry a tenant's code
emits (error fingerprints, span metrics, LLM spend, synthetic uptime). For
**infra-level** signals — Worker script errors/exceptions, CPU-time limit
overruns, sustained 5xx, origin/health-check failures — don't rebuild what the
platform already delivers: configure **Cloudflare Notifications** (Workers alerts
on error rate / CPU / invocation-limit, and **Health Checks** on a deployment's
URL) with email / PagerDuty / webhook destinations at the account level. The two
layers compose: Cloudflare Notifications + Health Checks cover the infrastructure
floor (is the Worker up, is it erroring at the edge), while these app-semantic
rules run on top (is _this function_ over its error/latency/cost budget). This
also gives an independent out-of-band path — an alert about the platform doesn't
depend on the platform's own telemetry pipeline being healthy.

#### Backlog items 2–9 — status as of 2026-07-29

(This list had collapsed into a single paragraph through successive edits; it is
restored here with each item's verified status. Re-verified against the code
2026-09-06: items 2, 5, 7 and 9 read 🔨 open here long after the status passes
above recorded them shipped — trust the code, not this list.)

2. **Deployment health charts on the project page** (✅ shipped) — request
   volume / error rate per deployment. `src/telemetry/traffic-read.ts` reads the
   metering stream per script, so a single script name gives one deployment's
   volume, error rate and latency. The `outcome` status class (blob3) that this
   row once waited on landed 2026-08-13.
3. **Log viewer upgrade** (✅ shipped) — severity chips, filter bar, and
   log↔trace correlation landed with B2's full log-management pass.
4. **Design-system pass** (✅ shipped) — the aurora redesign covered the token
   palette, severity ramp, and empty states across every screen.
5. **Onboarding checklist** (✅ shipped) — `lunora/onboarding.ts` +
   `src/client/OnboardingChecklist.tsx`, on the Projects tab until the org's
   first deployment is live. Derived from real rows, never stored.
6. **Time-range picker** (✅ shipped) — `src/client/TimeRangeProvider.tsx` +
   `time-range.ts` provide the shared presets.
7. **Deploy-key roll UX** (✅ shipped) — `deploy_keys.roll` does issue+revoke in
   one transactional mutation, so neither the two-live-keys nor the no-keys
   window exists. Ingest keys are refused (their stored cipher would point at a
   revoked secret).
8. **MCP surface** (✅ shipped) — `src/mcp/tools.ts` exposes the control plane
   over `/v1/mcp`, with per-route `RouteSpec.mcp` opt-in and a hard deny-list
   for `tokens`/`auth`/`mcp`.
9. **Integrations hub** (✅ shipped, minimally) — `src/client/`'s Integrations
   tab lists the org's GitHub App installations and can release (unclaim) one,
   the inverse `claim` never had. Connect cards for the Creem portal are still
   bare settings fields.
