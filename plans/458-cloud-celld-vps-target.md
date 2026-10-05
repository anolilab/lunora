# Plan 458 — Lunora Cloud manages a customer VPS: the `celld-vps` target

**Baseline:** `f79680910` (`alpha`, 2026-10-02) + `48023e8e7` (PR
[#85](https://github.com/anolilab/lunora/pull/85) head, `apps/cloud`)
**Status:** IN PROGRESS — gated on PR #85 merging. `MULTIPLATFORM.md` Phase 1 (the
`TargetDriver` extraction, G3–G10) landed 2026-10-02 on PR #85,
and so did G2, the control-plane side of G11–G17, the `celld-vps` driver and the
studio pages (G18)
(§1.5). W3's `celldConfigFromRelease` landed in `c302205ac` and W4 (`hostd`'s
daemon, with the on-box halves of W5 and W6) in `763c5ca96`; W8 (fleet
isolation) and W7's on-box half (side-by-side upgrades, `install.sh`, the
systemd unit) in `c49b828af`, `84b440493` and `4ccec3791`; the `test:hostd`
lane in `aba5561f7`. Decision recorded in
[`apps/cloud/MULTIPLATFORM.md` §7.9](../apps/cloud/MULTIPLATFORM.md).
**Rulings (2026-10-02):**

- Q1: `hostd` ships under FSL-1.1-Apache-2.0 and only works with Lunora Cloud
  (D15–D17).
- Q6: BYO-VPS and BYO-Cloudflare are built in parallel (§7).

**Code-quality pass (2026-10-02, after the security fixes):** the target seam
was reshaped — `TargetDriver` is built per placement (`deploy`, `destroy`,
`domains { platformTargets, onVerified? }`, `id: TargetId`) and `TargetFleet`
per target (`reach`, `dispatch?`, `usage?`); `Placement` is a union with the
box on the `celld-vps` arm; what a target is lives in `TARGETS`
(`provision-contract.ts`) — `7febed559`…`b4b86d0da`. `BoxSessionDO` is reached
over native RPC (`21bf73f1e`); `@lunora/hostd/release` verifies envelopes on
WebCrypto for box and control plane alike (`7febed559`); git builds run in a
per-build `BuildRunnerDO`, off the cron path (`285c381cb`). `apps/cloud/MULTIPLATFORM.md`
§6 Phase 1 lists the interface as it now stands.

Every `apps/cloud` path below is on the PR #85 branch. Read it with
`git show origin/claude/cloud-platform-dx-ojvkmu:apps/cloud/<path>` until #85 merges.

## 0. Headline finding

A Lunora app already runs on celld unchanged:

- `@lunora/platform-celld` rates every feature
  (`packages/platform/src/capabilities/celld.ts`);
- `@lunora/config` has a celld deploy driver (`packages/config/src/celld/`);
- `test:celld` drives a live single-node fleet and a two-node fleet
  (`packages/platform-celld/__tests__/celld/`).

**What is missing is not the runtime. It is the control plane reaching a
machine it does not own.** Every path from `apps/cloud` to a running tenant
assumes Cloudflare:

- provisioning goes through the Alchemy box onto a dispatch namespace;
- routing goes through the `DISPATCHER` binding;
- request counts come from Analytics Engine;
- logs come from a tail consumer;
- cron and queues are fanned out through the dispatcher.

`apps/cloud` also has **no WebSocket endpoint and no Durable Object of its own**.
The only DO classes are `ShardDO`, `SchedulerDO` and the two container DOs
(`src/server.ts:175-206`).

So this plan is mostly control-plane work plus one new deliverable: an
outbound-dialing host daemon, `lunora-hostd`.

## 1. Current state (audit)

### 1.1 Deploy path (`apps/cloud/src/deploy/`)

| Step           | Where                                               | What it does                                                                                                                                                                                             | Cloudflare-bound?               |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Entry          | `router.ts:1010`, `handler.ts:599-820`              | `POST /v1/deploy` with a deploy key; streams NDJSON (`accepted` → phases → `released` → `done`)                                                                                                          | no                              |
| Manifest check | `handler.ts:161-317`, `provision-contract.ts:63-89` | `BINDING_SUPPORT` is **one** table for one target; unsupported types are refused by name with WfP-worded reasons                                                                                         | **yes** (single target)         |
| Release store  | `release-store.ts:14-35`, `handler.ts:726`          | `releases/${deploymentId}.json` in R2 `RELEASES`: `{assets?, bundle (base64), manifest}`. No secrets. Stored **before** provisioning                                                                     | no                              |
| Spec           | `release.ts:96-124`                                 | `TenantDeploymentSpec` adds `LUNORA_ADMIN_TOKEN`, `LUNORA_OTLP_TOKEN` and `LUNORA_OTLP_ENDPOINT`. `cell`, `dispatchNamespace` and `tailConsumers` are Cloudflare nouns (`provision-contract.ts:147-166`) | **partly**                      |
| Cell choice    | `router.ts:805`                                     | `cell = env.LUNORA_CELL ?? "default"`. `organizations.cellId` is **never read on the deploy path**                                                                                                       | yes (process-global)            |
| Provision      | `provision.ts:33-162`                               | `Provisioner { deploy, destroy }`, one implementation (`createAlchemyProvisioner` → `CONTAINER_PROVISION_BOX`)                                                                                           | **yes**                         |
| Scheduler      | `scheduler.ts:40-131`, `token-bucket.ts:83-84`      | per-cell priority queue, gated by Cloudflare's API budget (1200 per 5 min). _Since PR #85: per budget (`pacing.ts`) — a box converge spends none of it_                                                  | budget is CF's                  |
| Verify         | `router.ts:944-952`                                 | `fetch(url)`, healthy if status < 500                                                                                                                                                                    | no (URL-based)                  |
| Rollback       | `release.ts:149-231`                                | re-provisions a stored release; refuses to drop a DO class                                                                                                                                               | no (goes through `Provisioner`) |
| Teardown       | `teardown.ts:21-94`, `sweeps.ts:43`                 | hourly sweep, `TeardownTarget {alias, destroyWorker, dispatchNamespace}`                                                                                                                                 | **yes**                         |

### 1.2 Everything else that reaches a tenant

| Concern          | Where                                                                                 | Mechanism                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing          | `src/dispatcher/{route,worker}.ts`                                                    | separate Worker; subdomain → `scriptName`, custom domain via `/v1/tenants/custom-domain`; `env.DISPATCHER.get(scriptName, …, {limits})`                                                  |
| Cron             | `src/fanout/cron.ts`, `server.ts:838-847`                                             | fan-out through `DISPATCHER` to `/_lunora/scheduled`, because WfP drops cron triggers                                                                                                    |
| Queues           | `server.ts:722-752`                                                                   | `handleQueueBatch` through `DISPATCHER` to `/_lunora/queue`                                                                                                                              |
| Requests metered | `src/metering/analytics.ts:87,160`, `metering/rollback.ts:59-96`, `sweeps.ts:124-166` | dispatcher → Analytics Engine `lunora_tenant_usage` → hourly readback into `platformUsage{kind:"requests"}`                                                                              |
| Logs             | `src/tail/worker.ts`, `router.ts:477-525`                                             | tail consumer → `/v1/logs/tail`                                                                                                                                                          |
| OTLP             | `routes/otlp.ts:117-263`, `src/telemetry/ingest-key.ts:48-89`                         | standard `/v1/{traces,logs,metrics}`, deploy or ingest key; one ingest key minted per org                                                                                                |
| Admin / backups  | `src/admin/proxy.ts:71-104`, `src/backup/tenant-transport.ts:76-90`                   | `fetch(${url}/_lunora/admin/…)`; `tenantSender` falls back to `fetch(url)` when no dispatcher is bound                                                                                   |
| Domains          | `lunora/domains.ts:52-217`, `src/domains/verify.ts:26-83`, `router.ts:726-755`        | TXT + CNAME check against `platformTargets: [LUNORA_APP_DOMAIN]`; certificate issuance **not wired** (`createCustomHostname` has no caller) — _wired on PR #85 via `domains.onVerified`_ |
| Secrets          | `src/secrets/crypto.ts:56-65`, `router.ts:833-867`                                    | AES-256-GCM under `SECRET_ENCRYPTION_KEY`, decrypted at the edge into `spec.secrets`                                                                                                     |
| Fleet upgrade    | `src/fleet/upgrade.ts:38-98`                                                          | canary + batches of 25 over a `release` port; **no production caller**                                                                                                                   |

### 1.3 Schema (`apps/cloud/lunora/schema.ts`)

- `cells` (L86-104) is a Cloudflare account plus a dispatch namespace. It is
  registered by an operator via `POST /v1/cells` and shared across orgs.
- `projects.activeScriptName` (L149-184) and `deployments.scriptName`,
  `cronSpecs` and `bindings[].type` (L186-262) are WfP or wrangler encodings.
- `domains.customHostnameId` (L514-531) is Cloudflare for SaaS.
- `usageMeter` (L28-64) is Cloudflare's billing dimension list.

### 1.4 What already works on celld (framework side)

- **Capabilities.** `capabilities/celld.ts` rates the following `native`: D1,
  KV, R2, Queues (push consumers on the `fetch` worker), Workflows, Cron
  Triggers (durable, fleet-wide), DO SQLite, hibernated WebSockets, and
  containers (experimental, needs Docker on the node). It rates `unsupported`:
  AI, Analytics Engine, Browser, Images, Hyperdrive, Pipelines, PITR,
  `edgeRequestMetadata` and `httpCache`.
- **Config projection.** `packages/config/src/celld/celld-config.ts:40-79`
  holds the accepted top-level keys. celld refuses any other key, and refuses
  every migration step except `new_sqlite_classes` (L79-110).
- **Launch recipes.** `packages/platform-celld/__tests__/celld/celld-process.ts`
  and `celld-fleet.test.ts:50-78` already show `celld deploy --bucket
--endpoint`, a node started with `--bucket --endpoint --listen`, and
  `celld diagnose --json`. These are the recipes `hostd` productionises.
- **Telemetry.** `otlpSink` (`packages/runtime/src/observability-sinks.ts:867`)
  is the substrate-neutral telemetry path. The deploy path already injects its
  endpoint and token.

### 1.5 Cloud-side gaps, in the order they block

Audited on `48023e8e7`. **Tier 0 blocks every target**, including the
Cloudflare one. Tier 1 is `MULTIPLATFORM.md` Phase 1. Only Tier 2 is new work
for this plan.

**Tier 0 — Cloud does not yet deploy anything from git**

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                                              | Owner                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| G1  | No cell is running. PR #85 is open; staging and production `wrangler.jsonc` still hold `<replace-with-…>` ids, which `deploy:check` refuses; the GitHub App credentials (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`) are unset. A box has no control plane to enrol into                                                                                                                                                                                                                            | PR #85 "Before this can deploy"; `GAPS.md` A3, A4, E3 | ops (🌐)                                                                      |
| G2  | **A git push builds but never deploys.** `runBuild` supports a `release` port (`src/builds/runner.ts:107-163`), but `lunora/builds.ts:441-511` does not pass one. The build box returns only `index.js` + a hash (`containers/build/server.mjs:191-197`): no binding manifest, no assets, and the bundle is never stored (only `bundleHash` reaches the `builds` row). Only the CLI upload (`lunora cloud deploy`) reaches `/v1/deploy`. `GAPS.md` A3 reads "wired end to end", which overstates it | listed                                                | **W0b** — ✅ `b388f7ee8`, `295c3794c`, `bfaa163af` (+ key expiry `fe3eea31f`) |
| G3  | Placement is process-global. The deploy path uses `env.LUNORA_CELL` (`router.ts:805`) and never reads `organizations.cellId`. Per-project targets need placement read from the database                                                                                                                                                                                                                                                                                                             | listed                                                | Phase 1 — ✅ `93803df29`                                                      |

**Tier 1 — the target interface (`MULTIPLATFORM.md` Phase 1)**

| #   | Gap                                                                                                                                                                                                                                                                            | Evidence                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| G4  | No `TargetDriver`. `Provisioner` (`provision.ts:33-38`) covers only `deploy` / `destroy`. Route, usage, logs, domains, teardown, backups and cron/queue fan-out each reach tenants through Cloudflare directly                                                                 | §1.1, §1.2 — ✅ `11b541d73`                         |
| G5  | Shared types carry Cloudflare nouns: `TenantDeploymentSpec.{cell, dispatchNamespace, tailConsumers}` (`provision-contract.ts:147-166`), `DestroyRef.dispatchNamespace` (`provision.ts:27-31`), `TeardownTarget.dispatchNamespace` (`teardown.ts:21-36`)                        | listed — ✅ `11b541d73`, `93803df29`                |
| G6  | Schema: no `target` column anywhere. Cloudflare fields sit in `cells`, `projects.activeScriptName`, `deployments.{scriptName, cronSpecs}` and `domains.customHostnameId`, and `usageMeter` is Cloudflare's billing list                                                        | §1.3 — ✅ `93803df29`                               |
| G7  | `BINDING_SUPPORT` is one table for one target, and its refusal reasons are worded for WfP                                                                                                                                                                                      | `provision-contract.ts:63-89` — ✅ `100d758d6`      |
| G8  | Every sweep assumes the dispatcher: cron fan-out (`server.ts:838-847`), queue fan-out (`server.ts:722-752`), tenant backups (`tenant-transport.ts:76-90`), teardown (`sweeps.ts:43`) and usage rollback (`sweeps.ts:124-166`). Each needs a per-target filter or a driver call | listed — ✅ `11b541d73`, `d66cd836d`                |
| G9  | The tenant URL is hard-coded as `https://${alias}.${appDomain}` (`router.ts:877-884`), and the health check and admin proxy inherit it                                                                                                                                         | listed — ✅ `11b541d73`                             |
| G10 | No conformance suite and no in-memory reference driver                                                                                                                                                                                                                         | `MULTIPLATFORM.md` Phase 1, item 5 — ✅ `6b42bb0d5` |

**Tier 2 — new for `celld-vps` (control-plane side only)**

| #   | Gap                                                                                                                                                                                                                                           | Workstream                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| G11 | No WebSocket endpoint and no custom Durable Object; `RouteAuth` has no box-key class (`route-registry.ts:20-32`)                                                                                                                              | W2 — ✅ `3eb6ce077`; workerd project `58ab2d184`, in CI `c5b7f6b6f`            |
| G12 | No `boxes` / `boxEnrolments` tables, functions or `projects.boxId`                                                                                                                                                                            | W2 — ✅ `c656aeec1`                                                            |
| G13 | `CloudflareApi` has no DNS-record methods, only `createCustomHostname` and `exportD1Database` (`src/cloudflare/api.ts:12-21`). The cell token also lacks Zone → DNS:Edit (PR #85's token scope list), and there is no `boxes.lunora.app` zone | W5 — ✅ code `722b198e1`, reconcile sweep `0bbcf4d65`; zone + token are 🌐 ops |
| G14 | No box-signed release route (`GET /v1/boxes/releases/:deploymentId`)                                                                                                                                                                          | W4 — ✅ `b85e5c479`                                                            |
| G15 | No usage write path for a box: `usage.ingest` requires an org-wide deploy key (`lunora/usage.ts:96`), so `BoxSessionDO` needs an internal mutation                                                                                            | W6 — ✅ `f87b67285` (the session writes the ledger directly, as the sweeps do) |
| G16 | No per-box line item or entitlement (`src/billing/plans.ts`, `lunora/entitlements.ts`)                                                                                                                                                        | W6 — ✅ `ed8b6b8ce`                                                            |
| G17 | No store or CI workflow for signed `hostd` releases; `deploy-cloud.yml` publishes Workers only                                                                                                                                                | W7 — ✅ pipeline (part a); store + rollout `85c5f6c91`, `653804c89`            |
| G18 | The studio has no target selector and no Boxes pages                                                                                                                                                                                          | W9 — ✅ `325453eb7`, `115a677e9`; Diagnose + fleets on PR #85                  |

**Already target-neutral (no gap):**

- the release store and the NDJSON deploy stream;
- OTLP ingest with per-org ingest keys;
- secret encryption and delivery;
- `tenantSender`'s URL fallback, and therefore backups, eject and the admin proxy;
- `verifyDomain`'s `platformTargets`;
- the fleet-upgrade planner, which has no caller yet but is ready.

## 2. Existing seams (do not reinvent)

- **`TargetDriver` (`MULTIPLATFORM.md` §5.1, built in its Phase 1).** `celld-vps`
  is a driver behind it. It is **not** a second `Provisioner` bolted onto
  `router.ts`. `MULTIPLATFORM.md` §0 is precisely the finding that `Provisioner`
  is too narrow.
- **The stored release** (`release-store.ts`). Deploy, rollback and every
  future target consume the same `{bundle, manifest, assets}`. A box fetches it;
  nothing is rebuilt per target.
- **The binding manifest** (`@lunora/config` `buildBindingManifest`,
  `provision-contract.ts`). The celld config is **derived from the manifest**,
  not from a source checkout.
- **The deploy NDJSON stream and `DeployPhase`** (`orchestrator.ts:17-86`). Box
  progress lines become `{phase}` / log events on the same stream. The CLI does
  not change.
- **Ingest keys + `/v1/{traces,logs,metrics}`.** Tenant telemetry needs nothing
  new. `hostd`'s own logs use the same route with the same key type.
- **`tenantSender`'s URL fallback** (`tenant-transport.ts:76-90`). Backups,
  eject and the admin proxy already work against a plain URL.
- **`verifyDomain`** (`src/domains/verify.ts:64-83`). It already takes
  `platformTargets`; a box contributes its own target.
- **`planFleetUpgrade` / `runFleetUpgrade`** (`src/fleet/upgrade.ts`). Its first
  production caller is `hostd` version rollout (W7).
- **celld launch recipes** from the TCK (§1.4).
- **`protocol/`** (top level). The home for a versioned wire contract that a
  non-JS client may one day implement.

## 3. The behavioural contract to preserve

1. **Cloudflare tenants are untouched.** Every existing `apps/cloud` test passes
   unchanged. A project with no `target` deploys exactly as today, through the
   same NDJSON events in the same order.
2. **`lunora cloud deploy` does not change.** Same request, same stream. The
   target is a property of the project, not a flag.
3. **The release store is target-neutral.** A release stored for a `celld-vps`
   deploy is byte-identical in shape to a WfP one, so rollback works the same.
4. **Refusal before creation.** An unsupported binding for the project's target
   fails the deploy before anything is provisioned, naming the binding and the
   target.
5. **The control plane never holds box credentials that grant shell or bucket
   access.** It holds a box's public key and nothing else from the box.
6. **One organization per box, forever.** A box row's `organizationId` is
   immutable. Re-enrolling a machine creates a new box.

## 4. Design decisions

| #   | Decision                              | Chosen                                                                                                                                                                                                                                                                                                                                                         | Rejected alternative, and why                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How the control plane reaches the box | **`hostd` dials out** over a WebSocket to a per-box Durable Object                                                                                                                                                                                                                                                                                             | SSH push: root keys to every customer box in our secret store, plus an inbound port. Polling over HTTP: deploy latency equals the poll interval, and there is no push for upgrades or wake-ups                                                                                                                                   |
| D2  | What runs on the box                  | **systemd unit for `hostd`**, which supervises celld and Caddy as children (Noite's process tree, without the container)                                                                                                                                                                                                                                       | One Docker image (Noite's choice): self-update then needs the Docker socket, which is root-equivalent, and celld containers would run Docker-in-Docker. A Docker install path stays an open question (§9 Q4)                                                                                                                     |
| D3  | Language of `hostd`                   | **TypeScript, shipped as a Node single-executable application**, built in this repo                                                                                                                                                                                                                                                                            | Rust (Noite's runner): a second toolchain for one binary, and no reuse of the validators and protocol types shared with `apps/cloud`. Bun compile: the repo's runtime floor is Node 24                                                                                                                                           |
| D4  | Box identity                          | **Ed25519 keypair generated on the box at enrolment.** A one-time enrolment token, valid 15 min and stored hashed, binds the public key to an org. Every WS connect answers a server nonce                                                                                                                                                                     | Long-lived bearer token: replayable, and it leaks in logs. Timestamped signatures: a VPS with clock skew fails closed                                                                                                                                                                                                            |
| D5  | Where builds run                      | **Centrally, unchanged.** The box fetches the stored release                                                                                                                                                                                                                                                                                                   | On-box builds: duplicate pipeline, untrusted install scripts, Node toolchain on the box                                                                                                                                                                                                                                          |
| D6  | How a release reaches the box         | **`GET /v1/boxes/releases/:deploymentId`, request signed by the box key.** Served from `RELEASES`                                                                                                                                                                                                                                                              | Over the WebSocket: Cloudflare caps a WebSocket message at 1 MiB and a release may reach 100 MiB (`handler.ts:121`). Presigned R2 URL: the Worker has no S3 credentials to sign with, and adding them widens the blast radius                                                                                                    |
| D7  | Where fleet data lives                | **A bucket the customer provides** (S3, R2, GCS, Tigris or Azure; celld's qualified list). Credentials stay on the box                                                                                                                                                                                                                                         | Our bucket: we would hold tenant rows, which breaks rule 5 in §3 and the no-lock-in claim. A bundled RustFS/MinIO: celld does not qualify RustFS (per Noite's SPEC); offered only for `--dev` boxes                                                                                                                              |
| D8  | Fleet layout                          | **One celld fleet per Lunora deployment alias**, bucket prefix `fleets/<alias>/`, single node, `CELLD_DURABILITY=bucket`                                                                                                                                                                                                                                       | One fleet for all projects: celld's rule is one application per fleet, and one shared `deploy/current.json`                                                                                                                                                                                                                      |
| D9  | Hostnames                             | **Default `<alias>.<boxSlug>.boxes.lunora.app`**: a wildcard A/AAAA record in our zone, created at enrolment via the Cloudflare API. Custom domains via Caddy on-demand TLS, ask-gated                                                                                                                                                                         | sslip.io (Noite's zero-DNS fallback): fine for a trial, but a third-party DNS dependency in production. Customer-provided wildcard: optional extra, not the default                                                                                                                                                              |
| D10 | Secrets on the box                    | **Merged into celld `vars`**, since celld has no secret store. They therefore persist in the customer's bucket                                                                                                                                                                                                                                                 | Holding secrets back: the app cannot run. Recorded as a known property, not hidden (§8)                                                                                                                                                                                                                                          |
| D11 | Cron and queues                       | **Native celld `triggers.crons` and queues**; `src/fanout/*` skips `celld-vps` deployments                                                                                                                                                                                                                                                                     | Reusing the WfP fan-out: it exists only because WfP drops triggers (`MULTIPLATFORM.md` §3), and celld does not                                                                                                                                                                                                                   |
| D12 | Billing                               | **Per enrolled box per month**; request counts collected for the studio only                                                                                                                                                                                                                                                                                   | Per request: the customer pays for the compute, and counts reported by a box the customer has root on are not billable evidence anyway                                                                                                                                                                                           |
| D13 | What a box row is                     | **A new `boxes` table**, org-owned                                                                                                                                                                                                                                                                                                                             | A `cells` row: cells are operator-registered capacity shared across orgs (`lunora/cells.ts:56-72`). Rule 6 in §3 forbids sharing a box                                                                                                                                                                                           |
| D14 | When the box is offline               | **The deploy fails fast** with `BOX_OFFLINE`                                                                                                                                                                                                                                                                                                                   | Queueing jobs until reconnect: a deploy that lands hours later, unannounced, is worse than a clear failure. Revisit with real usage                                                                                                                                                                                              |
| D15 | License of `hostd`                    | **FSL-1.1-Apache-2.0**, the framework's own license (repo `LICENSE.md`). Customers may run it for any purpose except a Competing Use. Each release converts to Apache-2.0 after two years                                                                                                                                                                      | PolyForm Noncommercial (`apps/cloud`'s license): forbids exactly what customers do, which is run their business on the box. Apache-2.0 or MIT: lets a competitor ship `hostd` as their own managed-VPS service with no rebuild. A closed binary: customers run it as root on their own machine, so they must be able to audit it |
| D16 | Who may drive `hostd`                 | **Lunora Cloud only.** `hostd` has no standalone mode and no local UI, and takes jobs only from the control plane it enrolled with. That defaults to production; a `--control-plane` override exists for staging and tests. Users who want celld without Lunora Cloud already have the CLI's celld deploy driver (`packages/config/src/celld/celld-driver.ts`) | A standalone or self-hosted control-plane mode: that is Noite, and it gives away the product we sell. Technical endpoint pinning (DRM): it breaks staging and tests, and the FSL Competing Use clause is the real enforcement                                                                                                    |
| D17 | Where `hostd` lives                   | **`apps/hostd`** (`@lunora/hostd`, its own FSL `LICENSE.md`). It owns the wire protocol (`@lunora/hostd/protocol`). The manifest-to-config function lives in `@lunora/config/celld`. `apps/cloud` depends on both                                                                                                                                              | Under `apps/cloud/`: that tree is PolyForm and is slated for extraction into a private repo (PR #85 `EXTRACT.md`), so a customer-installed binary cannot live there. Dependencies must run public → private, never the reverse                                                                                                   |

## 5. Workstreams

Sizes: S ≤ 2 days, M ≤ 1 week, L > 1 week. Each lists its gate.

### W0 — Prerequisites (not part of this plan)

- PR #85 merged, and a staging cell running with the GitHub App configured
  (G1).
- **W0b — git → release (M), owned here if nobody else picks it up first** (G2).
  Neither BYO target is real without it:
    - the build box also emits the binding manifest (`lunora build
--emit-bindings`) and the assets directory;
    - the build writes a `StoredRelease` straight to `RELEASES`;
    - `lunora/builds.ts` passes a `release` port that calls the deploy core
      (`handleDeployRequest`'s internals, not an HTTP round-trip through
      `/v1/deploy`);
    - correct `GAPS.md` A3's status line in the same change.
      Gate: a push to a test repo reaches `live` in the staging cell with no CLI
      involved.
- `MULTIPLATFORM.md` Phase 1, closing G3–G10: `src/targets/{driver.ts, registry.ts,
cloudflare-wfp/}`, the schema additions (`projects.target`,
  `deployments.target` / `resourceRef`), and the driver conformance suite with
  an in-memory reference driver. **STOP** (§8) if this has not landed.
  _Landed 2026-10-02 — see `MULTIPLATFORM.md` §6 Phase 1 "Status"._

### W1 — Wire protocol (S)

`protocol/hostd/` holds a versioned JSON message schema. The TypeScript types
and validators live in `apps/hostd/src/protocol.ts`, exported as
`@lunora/hostd/protocol` and imported by `apps/cloud` (D17).

- Box → cloud:
    - `hello {protocol, boxId, versions{hostd, celld, caddy}, fleets[{alias, deploymentId, state}], resources{memMb, diskFreeMb}}`
    - `progress {jobId, line}`
    - `result {jobId, ok, url?, error?{code, message}}`
    - `report {window, perAlias[{alias, requests, errors, p50Ms}]}`
    - `pong`
- Cloud → box:
    - `challenge {nonce}`, answered by `auth {signature}`
    - `job {jobId, kind: "deploy"|"destroy"|"reload"|"upgrade"|"diagnose", …}`
    - `routes {table}`: the full alias/hostname table, pushed on every change
    - `ping`
- The protocol version is negotiated in `hello`. Unknown versions are refused
  with a message telling the operator to upgrade.

**Gate:** round-trip property tests: every message validates after encode and
decode; unknown fields and kinds are rejected.

### W2 — Control plane: boxes, enrolment, session DO (M)

- Schema:
    - `boxes {organizationId, name, slug, status: pending|online|offline|revoked, publicKey, ipv4?, ipv6?, versions?, desiredReleaseId?, lastSeenAt?, enrolledAt?, revokedAt?, createdAt}`
    - `boxEnrolments {hashedToken, organizationId, createdBy, expiresAt, usedAt?}`
    - `projects.boxId?`, required when `projects.target === "celld-vps"`
- Functions:
    - `boxes.createEnrolment`: owner/admin; returns the token once, with the
      install command;
    - `boxes.list` / `boxes.get` / `boxes.revoke` / `boxes.rename`;
    - internal `boxes.markSeen` / `markOffline`.
- Routes:
    - `POST /v1/boxes/enrol`: token + public key + IPs → `boxId`. Single use. The
      wildcard DNS record is created here (W5);
    - `GET /v1/boxes/connect`: WebSocket upgrade → `BoxSessionDO.idFromName(boxId)`.
    - Both are classified in the route registry (`route-registry.ts:20-84`) under
      a new `RouteAuth` value, `"boxKey"`.
- `BoxSessionDO`: the first custom DO in `apps/cloud`. Declared in
  `wrangler.jsonc` **in every env block** (PR #85 notes that Cloudflare does not
  inherit bindings into named environments).
    - Hibernatable WebSockets, with the challenge/auth handshake.
    - `dispatch(job)` RPC returns a stream of progress plus the result.
    - An alarm-driven liveness check marks the box offline after 90 s of silence.
    - On reconnect, the DO pushes `routes` and replays `desiredReleaseId`.

**Gates:**

- DO unit tests (handshake, wrong signature, revoked box, replayed nonce, job
  correlation);
- a `workerd` vitest project for the WebSocket path, because `pnpm run test`
  does not run `workerd` suites (CLAUDE.md).

**Landed (2026-10-02, control plane, on PR #85):** G12
`c656aeec1`, G11 `3eb6ce077`, the `celld-vps` driver `73a45c7cc`, and the
`workerd` project `58ab2d184`, run in CI since `c5b7f6b6f` (the workerd job
matrix and its drift guard now list workspace directories, `apps/cloud`
included). As built:

- The handshake follows `protocol/hostd/README.md` §2 — `challenge` answers
  `hello`, not the upgrade — and the session writes `boxes` directly through the
  control-plane D1, the posture of every scheduled sweep, rather than through
  internal mutations a Durable Object cannot call.
- `RouteAuth` gained two classes: `boxKey` (connect, signed release and manifest
  fetches) and `enrolmentToken` (`POST /v1/boxes/enrol`). `POST /v1/boxes/revoke`
  (session) closes the session and removes the DNS records — and since
  `0bbcf4d65` it is the only revoke path: `boxes.revoke` is internal, because a
  revoke through the bare RPC mutation left the box's DNS records behind.
- The liveness tick closes the session of a box whose row is gone (its
  organization was purged), as it does a revoked one.
- The `__bench__` for the session (§8 perf watch) landed on
  PR #85: `apps/cloud/__bench__/box-session.bench.ts`, run by
  `pnpm --filter @lunora/cloud run test:bench` and by the CodSpeed job.

### W3 — Per-target binding support and celld config from a manifest (S–M)

- `provision-contract.ts`: `BINDING_SUPPORT` becomes
  `Record<TargetId, Record<BindingType, Support>>`, with reasons per target.
  The `celld-vps` row is derived from the celld capability matrix (§6), not
  restated by hand. A test asserts the two agree.
- `packages/config/src/celld/release-config.ts`:
  `celldConfigFromRelease(manifest, {alias, vars, crons, compatibilityDate})`
  produces a wrangler JSON restricted to celld's accepted keys. It is exported
  from `@lunora/config/celld` and used by `hostd` on the box (D17).
    - **Reuse** `ACCEPTED_KEYS` and the migration refusal from the sibling
      `celld-config.ts`. Do not copy them.
    - D1/KV/R2/queue names come from `tenantResourceName`
      (`provision-contract.ts:115-127`), so resource names match across targets.

**Gates:**

- golden fixtures (manifest in, config out);
- refusal tests per unsupported binding;
- one fixture deployed by the existing `test:celld` lane (`celld deploy
--dry-run`), so celld itself accepts the output.

**Landed (2026-10-02, `c302205ac`):** `celldConfigFromRelease` in
`@lunora/config/celld` (new subpath). As built:

- the stored bundle is `main` with `no_bundle: true`, so the box needs no
  esbuild (checked against celld v0.6.0);
- `ACCEPTED_KEYS` and the migration refusal are reused by running the output
  through `projectCelldConfig`; a key it would drop is an error, never shipped;
- a release manifest carries no migration history, only each class's
  `sqlite` flag, so every Durable Object class goes into one cumulative
  `new_sqlite_classes` migration under one tag (celld v0.6.0 accepts a
  growing class list under the same tag); a KV-backed class or a binding to
  another Worker's class is refused;
- resource names, the alias grammar and the binding types celld runs live in
  `@lunora/config/celld` (`releaseResourceName`, `isReleaseAlias`,
  `CELLD_RELEASE_BINDINGS`); `apps/cloud` imports them —
  `tenantResourceName` adds only the Analytics Engine `-` → `_` swap, and the
  `celld-vps` binding row is built from the map (§11). The provision
  container's `plan.mjs` cannot import TypeScript, so it keeps a copy of the
  alias rule that `__tests__/provision-plan.test.ts` pins to the config export;
- the full golden fixture passes a real `celld deploy --dry-run` (run by hand
  against v0.6.0; not yet wired into the `test:celld` lane).

### W4 — `hostd` core (L)

Lives at `apps/hostd/` (D17), as a new workspace package with the standard
package shape. Housekeeping:

- add it to `overrides` in `pnpm-workspace.yaml`, or a new internal package 404s
  on install;
- run `pnpm run lint:package-json`;
- add an `api-snapshots/` entry for `@lunora/hostd/protocol`, which is a public
  contract.

- **Enrol:** `hostd enrol --token … --bucket … --endpoint …`. Generates the key
  into `/etc/lunora-hostd/` (mode 0600), calls `POST /v1/boxes/enrol`, verifies
  the bucket against celld's own check at node start, and writes the config.
- **Session:** connect, answer the challenge, keep alive, reconnect with jittered
  backoff (1–60 s).
- **Supervisor** (Noite's model): restart each child with 1–30 s backoff;
  SIGTERM then SIGKILL past a stop budget; graceful shutdown drains celld before
  Caddy.
- **Jobs:**
    - **`deploy`:**
        1. Fetch the release (D6).
        2. Write `/var/lib/lunora-hostd/releases/<deploymentId>/` with the bundle,
           assets and `celldConfigFromRelease` output.
        3. Run `celld deploy <dir> --bucket s3://<bucket>/fleets/<alias>`.
        4. Spawn the fleet, or `POST /reload` on its loopback internal listener.
        5. Wait for `/.well-known/celld/health`.
        6. Answer `result {url}`.
           Every step streams `progress`.
    - **`destroy`:** stop the fleet, drop its routes, delete the
      `fleets/<alias>/` prefix. Previews always; production only on an explicit
      project delete. This matches the WfP teardown.
    - **`reload`** / **`diagnose`** (`celld diagnose --json`) / **`upgrade`** (W7).
- **Local state:** `/var/lib/lunora-hostd/state.json`. The control plane is the
  source of truth. On reconnect, `hello.fleets` is reconciled against the
  deployments table, and any fleet the cloud does not know is stopped (not
  deleted) and reported.
- **Ports:** two per fleet (public and internal) from a configured range. The
  internal listener always binds loopback.

**Gates:**

- unit tests against a fake celld binary (exit codes and timing);
- an integration lane, `test:hostd`, that runs real celld + Caddy + `hostd`
  against a local S3 and a stub control plane, reusing `celld-process.ts`;
- the conformance suite from W0 passing for `celld-vps` through a test harness
  that drives a real `hostd`.

**Landed (2026-10-02, `763c5ca96`):** the daemon, `apps/hostd/src/daemon/`
(`apps/hostd/README.md` "The daemon"). `enrol`, `run` and `status`; the
session (hello / challenge / auth, strict decoding, jittered 1–60 s
reconnect, `BOX_REVOKED` → exit 2, an outbound frame budget under the
session's rate limit); box-signed fetches pinned to the enrolled origin; the
five jobs; the supervisor; Caddy; reports; `state.json`. Tested in
`apps/hostd/__tests__/daemon/` against an in-process fake control plane and
fake celld/Caddy binaries, and smoke-run by hand against real celld v0.6.0,
Caddy v2.11.6 (with `caddy-ratelimit`) and moto, from `dist/bin.mjs` and from
the single executable: deploy, serving through Caddy (Durable Object, D1,
assets, forwarded host), a `report`, `diagnose`, `destroy` with `deleteData`.
That smoke found two bugs the fakes then learned to catch (Caddy's admin API
refuses Node's `fetch` without its own `Origin`; an access log created after
the daemon started was skipped). Decisions made while building:

- **No production default** for `--control-plane`: none is published yet, so
  `enrol` requires it (D16's default arrives with the production cell).
- **`deploy` relies on celld's in-place adoption.** `celld deploy` writes the
  version; a running node adopts it at its next pointer poll (≈15–45 s
  observed), so the job's health wait proves the node serves, not that it
  already serves the new version.
- **`reload` restarts the node**: celld v0.6.0 has no reload operator route.
- **Enrol checks the bucket** with `celld diagnose --json` before spending
  the token (skippable with `--skip-bucket-check`).
- **`deleteData`** lists and batch-deletes `fleets/<alias>/` over the S3 API
  (aws4fetch, path-style), since celld has no delete; only `s3://` buckets.
- **Root:** `run` refuses uid 0 unless the config sets `allowRoot`; the
  supervisor takes a uid/gid per child for W8's `lunora-fleet`.

Still open: the conformance run through a real `hostd`. hostd's own log
forwarding (W6), the `test:hostd` lane, `install.sh` and the unit (W7) and W8
landed since — see their sections.

**Landed (2026-10-03, `aba5561f7`):** the `test:hostd` lane — vitest project
`integration` in `apps/hostd`, gated behind `LUNORA_HOSTD_TESTS=1`, root script
`pnpm run test:hostd`, and the `hostd integration` job in `test.yml`
(path-filtered on `apps/hostd`, `packages/config`, `protocol/hostd`; part of the
required Test check). It drives the built daemon against real celld v0.6.0, a
Caddy built from `release-pins.json` with xcaddy exactly as the release does,
moto and the in-process fake control plane: enrol (with celld's bucket check),
session, deploy, HTTP through Caddy, a `report`, `destroy` with `deleteData`,
SIGTERM. In CI (`LUNORA_HOSTD_ISOLATION=1`, under sudo) it sets the box up with
`install.sh`'s own functions, runs the single executable under the real unit
with Caddy on port 80, and runs the W8 probe suite. Locally (no root, no
systemd) the functional path ran green from `dist/bin.mjs` and from the single
executable, and once as root in a user namespace with a real fleet uid (node as
that uid, the nftables table loaded, the fleet directories owned as designed);
the systemd unit, `Delegate=yes` and the probe suite run only in CI.

**Landed (2026-10-03, review round 2, `fix/hostd-round2`):** the conformance
run through a real `hostd` — the target-driver legs of
`apps/cloud/__tests__/support/target-conformance.ts`, reimplemented in
`apps/hostd/__tests__/integration/lane.test.ts` (hostd never depends on
`apps/cloud`): the same release twice converges on one fleet at one URL, a
new release lands on the same fleet and URL and is served once the node
adopts it, each alias gets its own URL, destroy is idempotent and tolerates a
fleet that never existed, a destroyed fleet is re-created at the same URL;
"running" is what the host reports (`state.json`). Ran green locally in an
unprivileged network namespace, from `dist/bin.mjs` and from the single
executable; the systemd variant runs in CI. Code-quality fixes from the same
review: one `runChild` for every one-shot child (the isolation probe, `find`,
`celld deploy`/`diagnose`, `nft`, `--version`), the fleet-directory helpers in
`fleet-directories.ts`, exhaustive job switches, one bucket-credentials reader,
`releaseArtifactFor` / `isReleasePlatform` / `values.ts` instead of copies, and
`enrol --force` keeps `box.key` until the control plane accepts the new one.
Nothing of W4 is open on the box side.

### W5 — Routing, DNS and TLS (M)

- At enrolment, create `*.<boxSlug>.boxes.lunora.app` A/AAAA records via the
  existing REST port (`src/cloudflare/api.ts`). Delete them on revoke.
- `hostd` generates the Caddyfile from the `routes` table, writes it only when it
  changed, and loads it via the Caddy admin API on loopback. A rejected config
  keeps the previous one serving and surfaces in `diagnose`. This is Noite's
  `caddy.rs` behaviour, including:
    - readiness-gated upstreams (`lb_try_duration` while the fleet boots);
    - `encode zstd gzip`, with `text/event-stream` left unbuffered;
    - a slowloris guard;
    - `--trust-forwarded-headers` on celld, because Caddy terminates TLS (see
      `requestOrigin` in the celld matrix).
- On-demand TLS is ask-gated by `hostd` against its local route table, so a
  certificate is issued only for a routed host.
- Custom domains: `verifyDomain`'s `platformTargets` gains the box hostname when
  the project's target is `celld-vps`. `domains.routeForHostname` feeds the
  `routes` push instead of the dispatcher.
- The dispatcher Worker never sees `celld-vps` traffic. The driver's `route()`
  answers from the `boxes` and `domains` tables.

**Gate:** `test:hostd` serves an alias over HTTPS against a local ACME test CA
(Pebble), and refuses a certificate for an unrouted host.

**Landed (2026-10-02, control-plane half):** box DNS (`722b198e1`) — A/AAAA
records for `*.<slug>` and `<slug>` written at enrolment and removed at
revocation, idempotent, failures recorded on the box (`dnsError`); the `routes`
table (live, provisioning and verifying aliases plus verified custom domains)
pushed on connect, after every job and on domain verification; custom domains
verify against `<slug>.<LUNORA_BOX_DOMAIN>`.

**Landed (2026-10-02, box hardening, `0bbcf4d65`):** dangling box records are a
subdomain takeover under our zone, so the hourly box sweep
(`src/boxes/reconcile.ts`) reconciles the whole box sub-domain on the `boxes`
table: it deletes every record whose slug has no box that is not revoked
(revoked through any path, purged, or left by a failed removal), rewrites
missing or stale records of live boxes and records the outcome in `dnsError`.
It is bounded: only A/AAAA records at `<slug>` / `*.<slug>` with a minted slug
are claimed, a pass writes at most 200 records, the listing stops at 50 pages
and nothing is created from a truncated one. It also revokes and disconnects
the boxes of organizations past the erasure cutoff, and runs right before the
six-hourly code crons, so `purgeDeleted` erases boxes whose sessions and records
are already gone; the hourly run is the backstop.

Still open: the box zone and the token's Zone → DNS:Edit scope (🌐 ops).

**Landed (2026-10-02, on-box half, `763c5ca96`):** `apps/hostd/src/daemon/caddy.ts`
generates Caddy's JSON config (not a Caddyfile) from the `routes` table and
loads it over the loopback admin API only when it changed; a refused config
keeps the previous one and shows in `diagnose`. Readiness-gated upstreams
(active health checks plus `try_duration`), `zstd`/`gzip` for an explicit list
of compressible types (an event stream is never compressed, `flush_interval:
-1`), `read_header_timeout` against slowloris, a per-client `rate_limit` zone
per alias, on-demand TLS whose `permission` endpoint is hostd's loopback `ask`
(routed hostnames and the box's own only), a JSON access log. The generated
config validates with `caddy validate` (v2.11.6) in both TLS modes and served
an alias in the smoke run above over plain HTTP; HTTPS against Pebble (the W5
gate) is not run yet. Caddy sets no asset headers: caching and redirects are
the app's, through `_headers` / `_redirects` at its assets root exactly as on
Cloudflare. The release carries them as `assets.config._headers` /
`._redirects`, hostd writes them back to the release's assets root, and celld
applies them — checked with celld v0.6.0 (`celld deploy` + a node) on a
hostd-written release: `/assets/*` answered `cache-control: public,
max-age=31536000, immutable`, a `301` rule redirected, and neither file was
served.

### W6 — Telemetry, usage and logs (M)

- **Tenant traces and logs:** unchanged. `LUNORA_OTLP_ENDPOINT` and the ingest
  token already ride in `spec` (`release.ts:96-124`) and reach the app as vars.
  Verify that `otlpSink` egress works from a celld isolate.
- **Platform logs:** `hostd` tails celld's stderr (`RUST_LOG=error,celld=warn`,
  as Noite does) and Caddy's error log, and forwards them as OTLP logs with the
  org's ingest key, tagged `box:<slug>` and `alias:<alias>`.
- **Request counts:** `hostd` reads Caddy's JSON access log and sends `report`
  per minute. `BoxSessionDO` writes `platformUsage{kind:"requests"}` rows
  through an internal mutation. They are displayed, not billed (D12).
- **Billing:** a `boxes` line item via `@lunora/payment`, with entitlement
  gating on box count per plan (`lunora/entitlements.ts`).

**Gates:**

- The studio Traffic and Logs panels render for a `celld-vps` project in the
  `test:hostd` lane.
- A unit test proves a replayed `report` window is not double-counted. This is
  the conformance leg "usage never double-counts across a checkpoint".

**Landed (2026-10-02, control plane):** the report path (`f87b67285`) — rows
idempotent per (box, `windowStart`), minute-aligned windows only, tagged
`boxId` and kept out of the spend cap, the overage debit and the invoice
summary; the conformance leg records `celld-vps` usage through it. Billing
(`ed8b6b8ce`): a `boxes` plan limit (free 0, pro 3, enterprise 50) gating
enrolment, and `BOX_CREDITS_PER_MONTH` (500 credits) per box billed in a period
through the prepaid-credits debit. Still open: `hostd`'s own log forwarding and
the `test:hostd` panel gate (W4).

**Landed (2026-10-02, on-box half, `763c5ca96`):** `apps/hostd/src/daemon/reports.ts`
tails Caddy's JSON access log and sends one `report` per closed whole-minute
window — requests, errors (status ≥ 500), median latency, at most 500
aliases — queueing up to a day of windows while offline and draining five per
ten seconds, well under `MAX_REPORTS_PER_MINUTE`. A real report reached the
fake control plane in the smoke run. hostd's own log forwarding is still open.

**Landed (2026-10-03, on-box log forwarding, `fix/hostd-round2`):**
`apps/hostd/src/daemon/log-forwarder.ts` forwards hostd's warnings and errors,
each celld node's stderr (`RUST_LOG=error,celld=warn`; a fleet's stdout stays
on the box) and Caddy's warnings and errors as OTLP/JSON logs to
`{endpoint}/v1/logs` with the organization's ingest key, tagged `box:<slug>`,
`source` and `alias:<alias>` (`service.name`: the alias for a fleet's lines,
`lunora-hostd` otherwise); a bounded drop-oldest buffer (1 000 records, the
drops counted), retries with backoff, the key in memory only and never sent
to a plain-`http:` endpoint from an `https:` box, every record redacted (the
key, the bucket credentials, bearer tokens, `AWS_*=`, enrolment tokens,
private keys). The box had no way to learn the key, so the protocol gained a
cloud → box frame, `config {telemetry?: {endpoint, token}}`, sent after `auth`
and on every change (protocol §5.2; joined version 1 before any box shipped).
The lane asserts a refused release reaching the fake control plane as a log.

**Landed (2026-10-03, control-plane half, `f9b480044`, `work/cloud-vps-gaps`):**
`BoxSessionDO` sends the `config` frame right after the `routes` push of every
authenticated (re)connect, with `LUNORA_OTLP_ENDPOINT` and the box
organization's ingest key, or `{"type":"config"}` when the cell has no
telemetry. The session has no deploy key to call `recordIngestKey` with, so
`resolveBoxTelemetryConfig` (`src/telemetry/ingest-key.ts`) reads the active
key over the store and mints one exactly as the deploy path does when the org
has none (the row shape and the active-key rule are shared,
`src/telemetry/ingest-key-row.ts`). Ingest keys cannot be rolled — one is
revoked and replaced — so the liveness alarm resolves the config again every
five minutes and sends it only when it changed (a SHA-256 of the last frame is
stored, never the frame). The key is never logged and never in a socket
attachment. Node and workerd tests (a key minted in real D1).

Still open: the studio Logs panel gate (W6), which needs a running cell.

### W7 — Install, upgrades and supply chain (M)

- **`install.sh`:** Debian/Ubuntu, amd64/arm64, 2 GB RAM minimum. It:
    - creates `lunora-hostd`, `lunora-fleet` and `lunora-build` users;
    - downloads `hostd`, celld and Caddy (with the `caddy-ratelimit` module
      compiled in) from a **signed release manifest** (Ed25519, pinned keys;
      §9 Q2) and verifies each checksum;
    - installs the systemd unit and runs `hostd enrol`.
      Re-running it upgrades the box in place.
- **Version pinning:** the control plane keeps a `hostdReleases` manifest
  (versions + digests). `boxes.desiredReleaseId` points at one entry.
- **Rollout:** an `upgrade` job makes `hostd` download and verify the new
  versions, then restart celld fleets one at a time (a single-node fleet means
  seconds of downtime per alias, so it is announced in the studio), then
  replace itself and exit for systemd to restart it.
- **Fleet-wide:** rollout across boxes goes through `planFleetUpgrade` /
  `runFleetUpgrade` (canary, then batches). Those modules get their first
  production caller here.
- **Security floor:** a box running a celld release older than the latest is
  flagged in the studio and in an alert after 7 days, because celld patches only
  its latest release (`MULTIPLATFORM.md` §7.8).

**Gate:** `test:hostd` upgrades a live box from release N to N+1 with a serving
alias, and the alias answers before and after the upgrade.

**Landed (2026-10-02, G17 part a):** the signed release pipeline, without
control-plane changes.

- `@lunora/hostd/release` (manifest + envelope types, strict validator,
  canonical bytes; runs in workerd) and `@lunora/hostd/release/verify` (Node:
  sign, verify against pinned keys, artifact size + hash checks). Since the
  code-quality pass the verifier itself is in `@lunora/hostd/release`, on
  WebCrypto (`verifyReleaseManifest`, async); `/verify` keeps signing and
  artifact hashing.
- `apps/hostd/scripts/build-sea.mjs`: Node 24 single executable (esbuild
  bundle + SEA blob + postject), smoke-tested with `--version`.
- `apps/hostd/scripts/make-release-manifest.mjs` + `release-pins.json`: make,
  sign and `--verify` manifests. celld is pinned to v0.6.0 (checksums verified
  against the downloaded assets).
- `.github/workflows/hostd-release.yml`: on a `hostd-v*` tag or dispatch, build
  and test, single executables on x64 and arm64 (`ubuntu-24.04-arm`) runners,
  sign in the `hostd-release` environment, attest, publish the GitHub Release.

Caddy (follow-up, same day): the release workflow builds Caddy v2.11.6 with
`github.com/mholt/caddy-ratelimit` from pinned source (xcaddy v0.4.7, Go 1.26.8,
module commit pinned in `release-pins.json`), reproducibly, on both platforms,
smoke-tests `http.handlers.rate_limit`, and publishes `caddy-<platform>.gz` on the
`hostd-v*` release; the manifest hashes those built files. No Caddy placeholder
remains.

Still open: no release key is committed (a placeholder that verification
refuses). The only manual step before a first release is a maintainer
generating the Ed25519 release key, committing its public half to
`trusted-release-keys.ts` and setting the `hostd-release` environment secret;
the workflow stops at signing until then. Next in W7:
`install.sh` and the `upgrade` job on the box.

**Landed (2026-10-02, G17 control-plane half, `85c5f6c91`):** the
`hostdReleases` table; `POST /v1/hostd/releases` (admin token) stores an
envelope only once it verifies as a box would verify it — with the box's own
`verifyReleaseManifest` since the code-quality pass: strict validator, pinned
keys, placeholder refused, Ed25519 checked with WebCrypto — so until a
real key is pinned every release is refused; `GET
/v1/hostd/releases/:releaseId/manifest` (box-signed); `POST /v1/hostd/rollout`
sets `boxes.desiredReleaseId` and rolls the release out through
`planFleetUpgrade` / `runFleetUpgrade` (their first production caller) as
`upgrade` jobs to online boxes, while an offline box gets the job when it
reconnects; `boxes.list`/`get` flag a box `outdated` when its celld is not the
newest stable release's.

**Landed (2026-10-02, box hardening):**

- `653804c89` — `POST /v1/hostd/rollout` no longer holds the request: it sets
  the intent, plans, answers 202 with the batches and starts the run on
  `waitUntil`. Because `waitUntil` ends ~30 s after the response, an hourly
  sweep re-plans every release a box still desires and carries it on (the
  planner skips boxes already on it); a halted run withdraws the intent from
  every box it did not upgrade, so a release that failed its canary spreads
  neither through the sweep nor through a reconnect.
- `de63b8c31` — the 7-day outdated-box alert: an hourly sweep fires the org's
  `deploy` alert rules (kind `box`, "Box outdated") for a box whose celld has
  not been the newest stable release's for over seven days (counted from the
  later of the release and the box's enrolment), once per box per release; the
  alert drain delivers it. A dedicated alert target would need a label in the
  studio's alert form (W9).

Still open: a pinned release key (see above).

**Landed (2026-10-03, on-box half, `c49b828af`, `84b440493`):**

- **Layout and `upgrade`.** Releases live side by side as
  `/opt/lunora-hostd/<releaseId>/{lunora-hostd,celld,caddy,manifest.json}`
  with `current` a symlink; the config's `binaries` is gone (always
  `{installDir}/current/…`). The `upgrade` job stages `<releaseId>.partial/`,
  verifies as before, renames it into place, swaps `current` in one rename,
  keeps the previous release for rollback and prunes older ones; when
  `lunora-hostd` itself changed it exits for systemd (the new hostd starts every
  child on the new binaries), otherwise it restarts the fleets one at a time,
  then Caddy. A release already running is a no-op.
- **`install.sh`** (`apps/hostd/install/install.sh`, shellcheck-clean):
  Debian/Ubuntu, amd64/arm64, ≥ 2 GB; installs missing packages; creates
  `lunora-hostd` and `lunora-fleet` (no shell) and the directories; resolves
  the newest stable `hostd-v*` (or `--version`); verifies `manifest.json`'s
  Ed25519 signature with OpenSSL against keys pinned in the script (fingerprint
  checked) before trusting any hash, checks each download's size and SHA-256,
  then has the verified `lunora-hostd verify-release` check everything again
  with its compiled-in keys; installs the unit; enrols as `lunora-hostd` with
  the token in the environment only; enables and starts the service. Re-running
  upgrades in place; `--uninstall` removes units, users, files and the nft
  table, never the bucket. A test keeps its pinned keys and embedded unit equal
  to `trusted-release-keys.ts` and the unit file.
- **`lunora-hostd.service`**: six ambient capabilities (NET_BIND_SERVICE,
  NET_ADMIN, SETUID, SETGID, KILL, CHOWN), `NoNewPrivileges=yes` (compatible:
  the uid drop is a `setuid()` with `CAP_SETUID`, not a set-user-ID exec),
  `ProtectSystem=strict` with only the data and install directories writable,
  `Delegate=yes`, `KillMode=mixed`, `TimeoutStopSec=90`, `Restart=always`,
  `RestartPreventExitStatus=2`. The trade-offs are in `apps/hostd/README.md`
  ("Isolation").
- **Release**: `hostd-release.yml` publishes `install.sh` and the unit with
  each release (attested) and puts their SHA-256 in the release notes.

Decided while building: `lunora-build` is not created (no build runs on the box
yet); `install.sh` never runs anything from `/opt/lunora-hostd` as root after
installing it (enrol runs as `lunora-hostd`), since that directory is
`lunora-hostd`-writable for upgrades.

**Follow-ups:**

- **`apps/cloud` branch:** done — the studio's install command
  (`installCommandFor` in `src/boxes/enrolment.ts`) is the three-line
  `install.sh` invocation: download `install.sh`, compare its hash, then
  `sudo bash install.sh --control-plane <origin> --bucket <bucket> --version
<desired release>`, with the token shown separately to paste at install.sh's
  hidden prompt (§11, thermos round 2 L4). **Cross-branch dependency:** that
  prompt (`read -rs` for the token and the bucket key, plus `--token-file` /
  `--credentials-file`; `--token` on the command line refused) lands with
  `fix/hostd-round2` — resolved: `work/cloud-vps-gaps` carries both. `--control-plane` is required until a production origin
  is compiled in.
- **`esbuild` on the box — not needed (2026-10-03).** Raised while validating W8
  and then disproved: releases deploy with `no_bundle: true` (W3), and celld
  v0.6.0 deploys and serves a Worker importing `cloudflare:workers` that way with
  no esbuild on `PATH` (real S3 deploy + node, not only `--dry-run`); without
  `no_bundle` the same deploy fails with "esbuild not found".

**Landed (2026-10-03, review round 2, `fix/hostd-round2`):**

- **The N → N+1 gate.** `apps/hostd/__tests__/integration/upgrade.test.ts`:
  release N installed by its own `lunora-hostd install-release`, an alias
  deployed and served, an `upgrade` job to N+1 (signed manifest from the
  control plane, artifacts over HTTPS, celld gzipped), the daemon installs N+1
  beside N, switches `current`, exits and is started again on N+1 (systemd in
  CI, the lane standing in for it locally), and the alias answers before and
  after. Both releases are builds of the source trusting a key the test
  generates (an esbuild plugin swaps `trusted-release-keys.ts` in the test
  helper only; no shipped build takes a key from anywhere else). Green locally
  in a network namespace; the systemd variant runs in CI.
- **One install path.** `install.sh`'s copy of staging, the `current` swap and
  pruning is gone: `lunora-hostd install-release <manifest> --from <dir>` runs
  the upgrade job's `installRelease` (`src/daemon/release-install.ts`), as
  `lunora-hostd`, from a root-owned directory beside `/opt/lunora-hostd`. The
  script keeps the trust bootstrap (OpenSSL signature check, the hostd hash),
  the users and the unit. `verify-release` is replaced by `install-release`.
- **Anti-rollback.** A release whose `lunora-hostd` is older (semver
  precedence, pre-releases included) than the installed one is refused unless
  the `upgrade` job carries `allowDowngrade: true` (new optional protocol
  field) or `install.sh --allow-downgrade`.
- **"Re-run to upgrade" resolves.** The release workflow keeps `latest.json`
  on the GitHub Release `hostd-latest` (`{stable, prerelease}`, each only moving
  forward, one concurrency group); `install.sh` without `--version` reads it
  for the box's channel (pre-release on a box that runs one, or with
  `--prerelease`) instead of one page of the repository's release list.
- **Secrets off the command line.** `install.sh` asks for the enrolment token
  and the bucket key at a hidden prompt (`--token-file` / `--credentials-file`,
  root-owned 0600, for automation); `--token` is refused, also by
  `lunora-hostd enrol`, which reads `LUNORA_HOSTD_ENROL_TOKEN` only.
- **OpenSSL 3.** `install.sh` refuses Debian < 12 and Ubuntu < 22.04 by name
  and checks `openssl version`, instead of failing as a bad signature.

Cross-branch — **`apps/cloud`:** done. The studio's install command is
`sudo bash install.sh --control-plane <origin> --bucket <bucket> --version <v>`
with the token in a copy field of its own (`f33c98d27`; its install.sh is on
the same branch since `work/cloud-vps-gaps` merged `fix/hostd-round2`). A
rollback is explicit (`6793d9adb`): `POST /v1/hostd/rollout` takes
`allowDowngrade: true` (admin token; a non-boolean is a 400), stored beside
the intent as `boxes.allowDowngrade` so the hourly resume sweep and the
reconnect replay carry it on, audited as `box.rollback` in each box's
organization; its `upgrade` jobs carry `allowDowngrade: true`, a normal
rollout's never do. Still open: a pinned release key (🌐 ops).

### W8 — Hardening on the box (M)

The box is single-customer, but the customer's apps still run third-party npm
code. Protect `hostd`'s key and the celld operator API from those apps.

Port Noite's sandbox (SPEC "Tenant isolation") as patterns, not code:

- fleets run as `lunora-fleet`, with environment cleared and reserved names
  dropped;
- an nft table blocks the fleet uid from loopback, RFC 1918, link-local,
  metadata (`169.254.0.0/16`), CGNAT and ULA. The exceptions are DNS and the
  bucket endpoint, refreshed every 30 s;
- per-fleet `memory.max` cgroups where cgroupfs is writable (Noite lists this as
  its missing piece);
- the celld internal listener on loopback only.

`hostd` refuses to start fleets if the isolation self-check fails, unless
`--single-trust` was given at enrolment. That flag is recorded on the box row
and shown in the studio.

**Gate:** a hostile-app probe suite, modelled on Noite's
`apps/noite/test/` isolation probe, runs in `test:hostd`. The probe deploys an
app that tries to reach the celld operator API, `hostd`'s config, the metadata
IP and a sibling fleet; every attempt must fail.

**Landed (2026-10-03, `c49b828af`, `4ccec3791`):** `apps/hostd/src/daemon/`
`isolation.ts` (self-check + decision), `capabilities.ts`, `accounts.ts`,
`fleet-environment.ts`, `nftables.ts`, `cgroups.ts`.

- Every celld process (node, `deploy`, `diagnose`) runs as `lunora-fleet`
  through `setpriv`, which empties the inheritable and ambient sets (the unit's
  ambient capabilities would otherwise survive the uid change) and sets
  `no_new_privs`; Caddy keeps only `net_bind_service`. Fleets get an
  environment built from an allowlist. Release directories are shared with the
  fleet group (0750/0640); a fleet's working directory is its own (0700); the
  data directory is `lunora-hostd:lunora-fleet` 0710.
- `inet lunora_hostd` (nftables, `meta skuid`): established/related, DNS and the
  bucket endpoint's addresses (re-resolved every 30 s) pass; loopback, RFC 1918,
  link-local + metadata, CGNAT, `0.0.0.0/8`, IPv6 loopback/unspecified/
  v4-mapped/ULA/link-local are rejected.
- Per-fleet `memory.max` in `fleet-<alias>/` under the delegated service cgroup
  (the daemon moves itself to `hostd/` first).
- The self-check (uid drop, table loaded, cgroup delegation) decides
  `enforced` / `single-trust` / `refused`; `refused` starts no fleet and fails a
  deploy with `ISOLATION_FAILED`. Reported in `diagnose` and in `hello` as the
  new optional field `isolation` (protocol §5.1, fixtures, API snapshot; the
  control plane may read it to show the box's isolation in the studio — W9).
- Unit tests cover the ruleset, the allowlist, the cgroup path logic and the
  decision table. Verified locally in user namespaces: the uid drop and
  capability drop under ambient capabilities, the table rejecting the fleet uid
  on loopback while the bucket stays reachable, celld (with a Durable Object)
  serving as the fleet uid under the table, and moving a fleet-uid process
  between delegated cgroups from the daemon's uid. The probe suite itself runs
  in the CI lane. Known limits (one fleet uid per box, the box's bucket key in
  every fleet, open public egress, memory-only limits, Caddy as
  `lunora-hostd`) are in `apps/hostd/README.md`.

**Landed (2026-10-03, review round 2, `fix/hostd-round2`):** Caddy no longer
runs as `lunora-hostd` (which reads `box.key` and `bucket.env`): it runs as
`lunora-edge`, created by `install.sh`, started through `setpriv` with
`net_bind_service` alone, in directories laid out so neither side writes the
other's (`caddy/` hostd's, set-group-ID `lunora-edge`, with `caddy.json`;
`caddy/state/` Caddy's own; `caddy/log/` Caddy's, set-group-ID to hostd's group,
with the 0640 access log hostd reads without following links); the data
directory becomes 0711. The self-check gains a fourth check, "edge user". The
lane asserts Caddy's uid and that `lunora-edge` reads neither the key, the
bucket credentials nor the state (CI, systemd variant).

**Fixed (2026-10-03, after the root/systemd lane's first CI run):** that run
(job 111121913134) refused every fleet with `ISOLATION_FAILED` on two real
bugs, which the user-namespace runs could not show:

- _nft from stdin._ `nft -f -` exited 1 with "Not a regular file:
  /dev/stdin". Node hands a child its stdin as a socket (libuv's socketpair),
  and nft 1.0.9 — the version Ubuntu 24.04 ships, and the only release with
  the check (1.0.8 lacks it, 1.1.0 exempts stdin) — accepts stdin only as a
  regular file, FIFO or character device; the local runs used nft 1.1.7.
  hostd now writes each script to a 0600 file in a fresh 0700 directory under
  the data directory (in the unit's `ReadWritePaths`, written by
  `lunora-hostd` alone), runs `nft -f` on it and deletes it. Reproduced and
  verified against nft 1.0.9 built from source, in a user+network namespace.
- _Caddy's set-group-ID directories._ `chmod 2750 caddy/` failed with
  `EPERM`: the unit's `RestrictSUIDSGID=yes` installs a seccomp filter that
  refuses any chmod/mkdir/open setting a set-user-ID or set-group-ID bit.
  `install.sh`'s `create_directories` now creates `caddy/`
  (`lunora-hostd:lunora-edge` 2750), `caddy/state/` (`lunora-edge` 0700) and
  `caddy/log/` (`lunora-edge:lunora-hostd` 2750) as root, refusing a link in
  their place; the daemon no longer creates, chowns or chmods them — the
  edge-user check verifies owner, group, mode and that each is a real
  directory (`EDGE_DIRECTORIES` in `edge.ts`; a test keeps install.sh equal to
  it). "hostd never writes into a directory Caddy can write" is unchanged.
  `CAP_CHOWN` stays, for the fleet directories.

The other failures in that run followed from these, except one the fake
control plane caused: it never pinged, so the box dropped a socket silent for
120 s and reconnected, and a `destroy` dispatched in that window was lost
("stops cleanly" timed out at 180 s). It now pings every 30 s, as the session
DO does.

**Fixed (2026-10-03, the lane's second root/systemd run, job 111132173638):**
isolation was `enforced`, but every child started as another user failed:
`CELLD_FAILED: could not run /opt/lunora-hostd/current/celld: spawn
/usr/bin/setpriv EACCES` (each `deploy`), Caddy never listened (`ECONNREFUSED
127.0.0.1:80`), `destroy` failed with `EACCES … fleets/lane-other`, and the
"stops cleanly" legs ended in systemd's SIGKILL after "caddy did not stop
within 10000 ms".

- _The child's `cwd`._ libuv's forked child calls `chdir(cwd)` _before_
  `setgid`/`setuid`, so Node enters the directory as the daemon — and
  `lunora-hostd` holds no `CAP_DAC_*`, so it may not enter a fleet's 0700
  directory (`lunora-fleet`'s) or Caddy's `state/` (`lunora-edge`'s 0700). The
  chdir's `EACCES` is reported as `spawn <file> EACCES`, naming setpriv. The
  user-namespace runs never switched uid, so never saw it; the isolation probe
  passes no `cwd`. `launchCommand` now hands a child started as another user
  no `cwd`: it enters its directory itself, after the switch, through
  `setpriv … -- /usr/bin/env --chdir=<dir> -- <binary>` (coreutils ≥ 8.28;
  the same pid, so cgroup attach and Caddy's ambient `net_bind_service` are
  unchanged). No mode was widened.
- _Removing a fleet's directory._ `find -delete` ran as the fleet user, then
  the daemon's recursive `rmSync` had to read the 0700 directory; it now
  `rmdir`s the emptied directory, which needs only `fleets/`.
- _A child that never started._ Node emits `error` and no `exit` for a spawn
  that fails, so the supervisor counted Caddy as running forever: never
  restarted, and `stop` waited on an `exit` that never came. Such a child now
  counts as exited (logged, restarted with the backoff), and `stop` returns.

Reproduced and verified with a real uid switch: in a user namespace with a
subuid range (`unshare --user --map-root-user --map-auto --mount`, tmpfs data
directory laid out as install.sh does), the daemon as uid 200 with exactly the
unit's six capabilities as ambient + bounding set — the old spawn fails with
`spawn /usr/bin/setpriv EACCES`; the new one runs the fleet as uid 100 in its
0700 directory (no capabilities, `no_new_privs`), Caddy's stand-in as uid 300
in `state/` keeping `CapAmb 0x400`, and `removeFleetDirectory` removes a
populated fleet directory. `__tests__/access.test.ts` now computes, from
install.sh's `install -d` lines and the modes hostd's code sets, what each
user may enter, read, write and execute, checks every child spawn (the
supervisor's, captured; `runChild`'s) against it, and keeps the isolation
invariants (no fleet or edge access to the key, credentials or state; the
daemon never writes where Caddy can) — failing, without root, on the old code.

### W9 — Studio (M)

- **Boxes page:** enrol (shows the one-time install command), status, versions,
  memory and disk, fleets, revoke.
- **Project settings:** a target selector, and a box picker filtered to the org.
- **Capability-gated tabs:** no Bindings graph entries for refused types, no
  per-plan runtime limits, no PITR. Each says why, citing the target's
  capability note, rather than rendering empty (`MULTIPLATFORM.md` Phase 3,
  item 5).
- A Diagnose button runs `diagnose` and renders `celld diagnose --json`.

**Gate:** component tests for each state (pending, online, offline, revoked,
outdated). Note the studio jsdom sandbox caveat in the repo memory: verify with
tsc + eslint where jsdom cannot run.

**Status (`325453eb7`, `115a677e9`).** Built: the Boxes tab
(`src/client/BoxesSection.tsx`; enrol / rename / revoke dialogs; revoke goes
through `POST /v1/boxes/revoke`), the project's Deploy target card
(`ProjectTargetCard.tsx`, `boxes.setProjectTarget`) and target gating
(`target-capabilities.ts`: the bindings graph marks refused types with the
contract's reason; `TargetCapabilitiesCard.tsx` lists refused bindings, the
per-plan runtime limits that do not apply and PITR, quoting celld's matrix note;
the backups card names snapshots as the recovery tier). `projects.listByOrg`
now returns `target` / `boxId`, and `boxes.domain` answers `LUNORA_BOX_DOMAIN`.
The per-state decisions (status → chip, role gating, target draft, refusal
wording, capability lists) are node-tested as pure modules
(`__tests__/studio-boxes.test.ts`, `target-capabilities.test.ts`); `apps/cloud`
has no DOM test environment, so the components are verified with tsc, eslint,
react-doctor and `vite build`.

**Follow-ups landed (PR #85):** the Diagnose button and the
box's fleets. `POST /v1/boxes/diagnose` (owner/admin session, through the
internal `boxes.authorizeDiagnose`: refuses a revoked box, `sensitive` rate
limit, audited) dispatches the `diagnose` job over `BoxSessionDO.dispatch`
with a 60 s timeout and answers the box's `progress` lines, capped at 4 000
lines / 256 KiB (`src/boxes/diagnose.ts`); the studio's dialog pretty-prints
JSON output. `boxes.fleets` is written from every `hello` and moved on by each
successful `deploy` / `reload` / `destroy` result (`src/boxes/fleets.ts`), and
each box lists its fleets (alias, deployment, state). The enrol dialog's
command now names this control plane (`--control-plane <LUNORA_ORIGIN_URL>`),
which `lunora-hostd enrol` requires; `boxes.createEnrolment` became an action
to read the var.

### W10 — Docs and positioning (S)

- A `docs/cloud/byo-vps` page covering: requirements, install, bucket choice,
  the capability table from §6, the known properties from §8, and how to leave
  (keep the bucket, run `celld` directly).
- ROADMAP gets a BYO-VPS line under **Next** or **Later**, depending on §9 Q6.

**Gate:** the docs build. The capability table is generated from the matrix,
not hand-copied.

## 6. Platform parity

This plan adds **no `ctx.*` surface and no new binding type**. It adds a
deploy target. The per-binding support table becomes per-target (W3).
`celld-vps` derives its row from `capabilities/celld.ts`, so the matrix stays
the single source of truth:

| Binding type (`BindingRequirement["type"]`) | `cloudflare-wfp` (today) | `celld-vps`          | Notes                                                                                                        |
| ------------------------------------------- | ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `durable_object`                            | bound                    | native               | SQLite-backed classes only; celld refuses KV-backed migrations                                               |
| `d1`                                        | provisioned              | native               | fleet SQLite; 100k rows / 32 MiB result cap; no read replicas                                                |
| `kv`                                        | provisioned              | native               | no edge cache; single writer per namespace                                                                   |
| `r2`                                        | provisioned              | native               | served from the fleet bucket under `r2/<name>/`; no SSE-C or jurisdiction                                    |
| `queue_producer`                            | provisioned              | native               | one writer per queue; four-day retention                                                                     |
| `queue_consumer`                            | routed (fan-out)         | native               | push consumers on the `fetch` worker; pull mode refused                                                      |
| `workflow`                                  | unsupported              | native               | celld implements Workflows (exercised by the TCK)                                                            |
| `assets`                                    | bound                    | native               | `ASSETS` binding must be explicit; celld applies the app's `_headers` / `_redirects` as Cloudflare does (W5) |
| `container`                                 | unsupported              | **unsupported (v1)** | celld supports it with Docker on the node; deferred to keep the box Docker-free (§9 Q5)                      |
| `ai`                                        | bound                    | unsupported          | not a celld binding                                                                                          |
| `analytics_engine`                          | provisioned              | unsupported          | not a celld binding                                                                                          |
| `browser`                                   | bound                    | unsupported          | not a celld binding                                                                                          |
| `images`                                    | bound                    | unsupported          | not a celld binding                                                                                          |
| `hyperdrive`                                | unsupported              | unsupported          | not a celld binding                                                                                          |
| `vectorize`                                 | unsupported              | unsupported          | not a celld binding                                                                                          |
| `pipeline`                                  | unsupported              | unsupported          | not a celld binding                                                                                          |

Cron triggers: WfP fans out through the dispatcher; on `celld-vps` they are
native (`triggers.crons`) — see D11.

`PlatformCapabilities` needs **no new key**. If W3 finds a binding whose celld
rating and box support disagree, fix the matrix in the same change.

## 7. Phasing & ordering

| Phase | Work                                     | Gate                                                                                   |
| ----- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| 0     | W0 (external)                            | Phase 1 conformance suite green with the in-memory driver and `cloudflare-wfp`         |
| 1     | W1 + W3                                  | protocol round-trip tests; config golden fixtures accepted by `celld deploy --dry-run` |
| 2     | W2 + W4 (deploy, destroy, diagnose only) | `test:hostd`: enrol, deploy, curl the alias over plain HTTP, destroy                   |
| 3     | W5 + W6                                  | HTTPS on the default hostname and a custom domain; Traffic and Logs panels populated   |
| 4     | W8                                       | hostile-app probe suite green                                                          |
| 5     | W7                                       | live N → N+1 upgrade keeps the alias serving                                           |
| 6     | W9 + W10                                 | studio states and docs build; **private early access**                                 |
| 7     | —                                        | conformance suite green for `celld-vps` in CI; GA decision (§9 Q6)                     |

Phases 1 and 2 have value even if the target is never sold: they prove the
`TargetDriver` seam against a non-Cloudflare implementation. That is
`MULTIPLATFORM.md`'s main argument for a second target.

**Parallel with BYO-Cloudflare (ruling on Q6).** `MULTIPLATFORM.md` Phase 3
(`cloudflare-workers`) runs alongside this plan. Both drivers start once W0 is
green, and the rules below keep two simultaneous implementations from pulling
the interface in two directions:

- **One owner for the interface.** Changes to `src/targets/driver.ts` or the
  conformance suite land in their own PR, with **both** drivers (and
  `cloudflare-wfp`) updated in it. Neither driver branch edits the interface
  inline.
- **Shared work is done once.** The per-target `BINDING_SUPPORT` table (W3),
  `projects.target` in the studio, and capability-gated tabs (W9) are needed by
  both. They land with whichever driver gets there first, and the other
  consumes them.
- **Different routing, metering and log sources.** BYO-Cloudflare reads the
  customer account's GraphQL Analytics API. `celld-vps` reads `hostd` reports.
  Two genuinely different `usage()` implementations are the best test that the
  seam is right.
- **Gate:** neither target reaches private early access until both pass the same
  conformance suite in CI. Staffing is the risk: if only one driver can be
  staffed, `celld-vps` Phases 1–2 go first, because they need no customer
  Cloudflare account to test against.

**The parallel driver landed (2026-10-02).** `cloudflare-workers` is on
PR #85 (`MULTIPLATFORM.md` Phase 3 status). What it means here:

- It changed the interface once: `TargetFleet.usage` is a `UsageReadback` of
  scopes, each with its own `usageCheckpoints` row (the cell-wide checkpoint
  could not serve a second readback target). `celld-vps` is untouched — its
  fleet has no `usage` (`metering: "pushed"`) — but the change is its own
  commit, to be split into its own PR per the first rule above.
- Shared work it did: `projects.setTarget` (moved from
  `boxes.setProjectTarget`, now also writing `projects.cloudflareAccountId`),
  a third `Placement` member, the deploy-target card's account picker, and a
  capabilities card that states each target's limitations, not only celld's.
- It passes the same `describeTargetConformance` legs, plus the per-scope
  readback legs, over a fake provision box and a fake GraphQL source — not yet
  against a real account.

## 8. Risks & STOP conditions

- **STOP** if Phase 1 (`TargetDriver`) has not landed. Building `celld-vps` as a
  second `Provisioner` behind `router.ts:805`'s process-global `LUNORA_CELL` is
  exactly the shortcut `MULTIPLATFORM.md` §9 rules out.
- **STOP** if celld's operator API or bucket contract breaks compatibility twice
  in a row between minor releases (`MULTIPLATFORM.md` §7.9). Pin the last good
  release and pause.
- **STOP** if celld cannot keep a single-node fleet's internal listener on
  loopback, or cannot trust `X-Forwarded-*` from a local proxy. Both are
  load-bearing for W5 and W8.
- **Known property, not a bug:** secrets live as celld `vars` in the customer's
  bucket (D10). The docs must say so. Anyone with bucket read access can read
  them, which on the customer's own bucket is the customer.
- **Risk:** customers expect HA from "managed". A single-node fleet has
  seconds of downtime per upgrade and none of celld's multi-node takeover.
  _Mitigate:_ say so in the studio. Multi-node boxes per project are a follow-up
  (§9 Q7), and celld already supports them (`celld-fleet.test.ts`).
- **Risk:** the customer has root and can tamper with `hostd` or its reports.
  _Mitigate:_ nothing we bill depends on box reports (D12). Treat every message
  from a box as untrusted input: validate it, cap it, and rate-limit it per box
  in `BoxSessionDO`.
- **Risk:** a box record left in the platform's zone after the box is gone
  points our hostname at an address the customer may release — a subdomain
  takeover. _Mitigate:_ one revoke path that removes the records, retirement of
  a purged org's boxes before the purge, and the hourly box sweep that deletes
  any record without a live box (W5 "box hardening").
- **Risk:** the 1 MiB WebSocket message cap. _Mitigate:_ releases never travel
  over the socket (D6). Cap `report` and `progress` frames in the protocol.
- **Risk:** celld is Deno's, and alpha. _Mitigate:_ `TargetDriver` keeps the
  target removable. The pin-and-upstream policy is in `MULTIPLATFORM.md` §7.8.
- **Perf watch:**
    - deploy latency from `accepted` to `released` for a 5 MiB release on a
      2 GB box, measured in `test:hostd`. Budget: under 30 s, matching WfP;
    - `BoxSessionDO` memory with 1,000 hibernated sockets. Add a `__bench__`
      suite in W2. _Landed (PR #85):_ frame decode, `receiveFrame`
      (decode + token bucket + effect), job correlation and a liveness tick over
      1,000 attachments are benched in plain node; locally a `progress` frame
      costs ~1.8 µs end to end, a 500-alias `report` ~150 µs to decode, a tick
      over 1,000 sockets ~4 ms. Memory is held by a test: a ready attachment is
      under 256 bytes (1,000 under 256 KiB). Measuring it found the `hello`
      fleets riding the attachment — up to ~100 KB against workerd's 16 KiB
      attachment cap — so they now wait in the session's memory between `hello`
      and `auth` instead.

## 9. Open questions (answer during execution)

1. ~~License of `hostd`.~~ **Answered 2026-10-02:** FSL-1.1-Apache-2.0; usable
   only with Lunora Cloud; lives in `apps/hostd`. See D15–D17.
2. ~~**Signing:** minisign (small, offline key) or Sigstore keyless (CI-bound
   identity)?~~ **Answered 2026-10-02:** neither as a runtime dependency. A
   release is authenticated by an **Ed25519 signature over the canonical bytes
   of a SHA-256 release manifest**, verified with `node:crypto` (zero
   dependencies) against public keys pinned in the `hostd` binary and in the
   control plane (`apps/hostd/src/trusted-release-keys.ts`). The private key
   lives only in the `hostd-release` GitHub Environment, behind a required
   reviewer. GitHub artifact attestations (`actions/attest-build-provenance`)
   add build provenance for auditors; a box never needs them. Format:
   `protocol/hostd/README.md` §8.
3. **Bucket for trial boxes:** require bring-your-own from day one, or allow a
   bundled RustFS under `--dev` with a visible "not for production" badge?
4. **Docker install path** (Coolify, Railway, Fly) as a second shape of
   `hostd`, like Noite's single image. Out of scope for v1. Revisit when a
   customer asks.
5. **Containers on the box:** support celld containers (needs Docker or Podman
   on the node) in v1.x?
6. ~~Positioning: BYO-VPS before or after BYO-Cloudflare?~~ **Answered
   2026-10-02:** both, built in parallel. Rules are in §7. ROADMAP lists them as
   two lines under **Next**.
7. **Multi-node boxes:** let a project span two or more boxes as one celld fleet
   (`CELLD_DURABILITY=fleet`) for HA. That changes D8 and the box → org binding
   into box group → org.
8. **IPv6-only boxes** and boxes behind NAT with no public IP. The latter needs
   a tunnel. Is that a Cloudflare Tunnel option, or out of scope?
9. **Preview deployments on a box:** they share the box's resources with
   production. Offer them, cap them per box, or route previews to WfP while
   production runs on the box?

## 10. Follow-ups (PR #85, 2026-10-02)

Landed on PR #85 after the BYO-Cloudflare work (`010f04761`), each with node tests:

- **Box diagnostics and fleets** (W9) — `192929f02`: `POST /v1/boxes/diagnose`
  (owner/admin, `sensitive` bucket, audited) runs the `diagnose` job over
  `BoxSessionDO.dispatch`, output capped at 4 000 lines / 256 KiB; the Boxes tab
  has a Diagnose dialog and lists each box's fleets (`boxes.fleets`, written from
  `hello` and moved on by successful deploy / reload / destroy results). The
  install command names `--control-plane <LUNORA_ORIGIN_URL>`, which
  `lunora-hostd enrol` requires (`boxes.createEnrolment` is now an action).
  `1dea0abe8` keeps the `hello` fleets out of the socket attachment (up to
  ~100 KB against workerd's 16 KiB cap), found while measuring for the bench.
- **Deploy pacing per target** — `58cc121af`: `TARGETS[target].convergeBudget`
  (since derived from `placedOn`, see §11) and `src/deploy/pacing.ts`; `cloudflare-wfp` keeps the platform account's
  1,200 / 5 min budget, `cloudflare-workers` spends the connected account's,
  `celld-vps` only its box's four converge slots.
- **Re-releasing a commit already built** — `9333ea9a5`: a push whose build
  exists but no longer serves re-releases that build's stored release
  (`builds.reusesBuildId`), or rebuilds once it was pruned.
- **First production alias** — `937f26fd5`: `projects.create` claims
  `projects.productionAlias` (slug, then `<slug>-<org id prefix>`), which a git
  build's first production release uses.
- **Perf bench** (§8) — `adbfcdf4e`: `apps/cloud/__bench__/box-session.bench.ts`
  in CodSpeed's `vis run test:bench`.
- **Custom-domain certificates on `cloudflare-wfp`** — `a904654eb`: the
  driver's `domains.onVerified` / `onRemoved` (since §11: `issue`, and a
  release through the issuer recorded on the row) create and delete
  Cloudflare-for-SaaS custom hostnames on `LUNORA_SAAS_ZONE_ID`; an hourly sweep
  follows them to `active` (GAPS.md B1; zone setup is 🌐, RUNBOOK step 6a).
- **Pre-rename dev databases** — `bf8515923`: the seed refuses a database
  without a `default` cell and prints the reseed steps (its rename of a lone
  `dev-cell` was a dev shim, removed in §11).

## 11. Code-quality round 2 (PR #85, 2026-10-03)

A maintainability review of `apps/cloud` (thermos round 2); each finding its
own commit, all pre-release breaks recorded in the commit bodies. No data
migration: the cloud app and every changed column exist only on this
pre-release line.

- **One placement column** — `4f306989d`: `projects.boxId` /
  `projects.cloudflareAccountId` (and the same pair on `deployments` and
  `platformUsage`) became one `placementRef` (a `v.id("boxes") |
v.id("cloudflareAccounts")` union), its table implied by
  `TARGETS[t].placedOn`; `PLACEMENT_HOSTS` in `src/targets/placement.ts` is
  the one place "box or account" is decided, and `Placement` is
  `{ target, host }`. `platformUsage.billable: false` replaces inferring
  "display only" from which FK is set. The teardown's alias→project→box
  fallback for rows predating `deployments.boxId` is gone.
- **One "connect your Cloudflare account"** — `6f413f23b`:
  `cloudflareBilling`, `lunora/cloudflare-billing.ts` and
  `POST /v1/cloudflare-billing` are gone; Billing Read is a permission group
  of `cloudflareAccounts`, and `cloudflareAccounts.costs` reads a connection's
  bill.
- **`resourceRefOf`** — `cbd693b9b`; **one account store**
  (`src/cloudflare-accounts/store.ts`, `cloudflareAccounts.cellId` + `by_cell`)
  — `ded2a34fd`; **one v4 caller**
  (`src/cloudflare/fetch.ts`) — `cdaea07b6`.
- **`cells.usageReadAtMs` dropped** with its checkpoint seed — `0b089142d`.
- **Lows:** `convergeBudget` folded into `placedOn` — `b5efbeb1b`;
  `resolveTargetDriver` without a per-target switch — `12418de8b`;
  one `pendingTeardown` predicate, which no longer counts a `failed` row the
  teardown sweep already stamped (it blocked target changes and disconnects
  forever) — `ad6f0299d`.

**Security and correctness, same round** (a second review of the branch):

- **Custom hostnames are never orphaned** — `be35db303`, `7345b5179`: a
  certificate is recorded with its issuer (`domains.certificateIssuer` /
  `certificateScope`: the target and its SaaS zone) and released through it,
  whatever the project's target is by then. Deleting a project or purging an
  organization queues its domains' certificates in `certificateReleases`,
  which the hourly certificate sweep releases, then forgets. The sweep refreshes
  each row through its own issuer (not the first fleet that has one), and
  `DomainOps` is `issue` / `platformTargets` / `domainsChanged?`; releasing is
  the fleet's `certificates` issuer, since the placement may have moved.
- **No certificate is shared by two rows** — `46e1f7d09`: issuing reuses only
  the custom hostname the row recorded, and refuses one the zone holds for the
  name otherwise.
- **An alias outlives its project until its tenant is gone** — `eb972553f`:
  deleting a project or organization keeps an alias with a tenant left to tear
  down claimed, and the teardown sweep releases only the torn-down project's
  claim, never another project's reservation.
- **No stale push rolls production back** — `4df9f4cf5`: webhook deliveries
  are deduped by `X-GitHub-Delivery` (`githubDeliveries`, four days), and a
  push re-releases an earlier build only when its `before` is the newest
  commit pushed to the branch.
- **The enrolment token is off the install command** — `f33c98d27`: the
  studio shows `sudo bash install.sh --control-plane … --bucket … --version …`
  and the token separately, to paste at install.sh's hidden prompt. Needs
  `fix/hostd-round2`'s install.sh (W7 follow-ups above).
- **Usage readback drains the deployments once** — `4260e051c`, four scopes
  at a time.
- **Naming has one home** — `49cd61165`: the alias rule, `{alias}--{binding}`
  and the binding types celld runs live in `@lunora/config/celld`; the
  `celld-vps` binding row and `tenantResourceName` are built from them.
- **Lows:** the seed's `dev-cell` rename shim is gone — `b54a79a80`;
  `jobMovesFleets` — `c5b43dfd6`; the provision plan carries no `state`, and
  an account job's credentials travel beside the plan — `eff0a62d3`; the
  schema-boots test gets a cold-import timeout — `b3c41e586`; the schema
  baseline is re-blessed (it predated the whole branch and blocked
  `lunora verify`) — `89beb4579`.

## 12. Cross-branch close-out (`work/cloud-vps-gaps`, 2026-10-03)

`fix/hostd-round2` and `docs/byo-server` merged onto one branch with the
`apps/cloud` halves they were waiting for, each with tests:

- **The `config` frame** (W6) — `f9b480044`; see W6.
- **Explicit rollbacks with `allowDowngrade`** (W7) — `6793d9adb`; see W7.
- **hostd's alias rule pinned** — `15772e863`: hostd's protocol stays
  dependency-free and runs in workerd, so `apps/hostd/src/wire/validate.ts`
  keeps its own `isAlias`; `apps/cloud/__tests__/alias-rules.test.ts` holds it
  to `@lunora/config/celld`'s `isReleaseAlias` over a corpus, a fixed-seed
  random sweep and the 63-character cap.
- **The capability tables generate again** (W10) — `8a94bade1`: the `celld-vps`
  row became `@lunora/config`'s `CELLD_RELEASE_BINDINGS` behind a spread and an
  `Object.fromEntries(Object.keys(…).map(…))`, which the restricted evaluator
  refused, so `--check` failed. It now follows imports from listed modules
  (`MODULE_SOURCES`) and knows exactly those calls; anything else still throws.
  The working check then caught real drift (Billing Read was missing from the
  BYO-Cloudflare permissions table). The docs build passes.
- **`_headers` / `_redirects` reach every target** (W5, §6): the CLI read and
  dropped both files, so an app's custom headers and redirects vanished on
  every Lunora Cloud target. They now travel as `assets.config._headers` /
  `._redirects` — the field names wrangler puts in Cloudflare's script-upload
  `metadata.assets.config` — with Cloudflare's documented rule and line limits
  enforced by the CLI; the provision box hands them to Alchemy's `headers` /
  `redirects` assets props, and hostd writes them into the release's assets
  root for celld. See W5.

**Still open after this branch:**

- **Release key** (🌐 ops): generate the Ed25519 release key, commit its
  public half to `trusted-release-keys.ts` and `install.sh`, set the
  `hostd-release` environment secret (W7). Until then every release is refused.
- **A running cell** (G1, 🌐 ops): PR #85 merged, staging/production
  `wrangler.jsonc` ids, the GitHub App credentials.
- **Box DNS** (W5, 🌐 ops): the box zone and the token's Zone → DNS:Edit scope.
- **Gates not yet run:** the conformance run through a real `hostd` (W4);
  HTTPS against Pebble (W5); the studio Traffic and Logs panels for a
  `celld-vps` project in `test:hostd` (W6).
