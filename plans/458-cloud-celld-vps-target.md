# Plan 458 — Lunora Cloud manages a customer VPS: the `celld-vps` target

**Baseline:** `f79680910` (`alpha`, 2026-10-02) + `48023e8e7` (PR
[#85](https://github.com/anolilab/lunora/pull/85) head, `apps/cloud`)
**Status:** TODO — gated on PR #85 merging. `MULTIPLATFORM.md` Phase 1 (the
`TargetDriver` extraction, G3–G10) landed 2026-10-02 on `work/cloud-vps-gaps`. Decision recorded in
[`apps/cloud/MULTIPLATFORM.md` §7.9](../apps/cloud/MULTIPLATFORM.md).
**Rulings (2026-10-02):**

- Q1: `hostd` ships under FSL-1.1-Apache-2.0 and only works with Lunora Cloud
  (D15–D17).
- Q6: BYO-VPS and BYO-Cloudflare are built in parallel (§7).

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
| Scheduler      | `scheduler.ts:40-131`, `token-bucket.ts:83-84`      | per-cell priority queue, gated by Cloudflare's API budget (1200 per 5 min)                                                                                                                               | budget is CF's                  |
| Verify         | `router.ts:944-952`                                 | `fetch(url)`, healthy if status < 500                                                                                                                                                                    | no (URL-based)                  |
| Rollback       | `release.ts:149-231`                                | re-provisions a stored release; refuses to drop a DO class                                                                                                                                               | no (goes through `Provisioner`) |
| Teardown       | `teardown.ts:21-94`, `sweeps.ts:43`                 | hourly sweep, `TeardownTarget {alias, destroyWorker, dispatchNamespace}`                                                                                                                                 | **yes**                         |

### 1.2 Everything else that reaches a tenant

| Concern          | Where                                                                                 | Mechanism                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing          | `src/dispatcher/{route,worker}.ts`                                                    | separate Worker; subdomain → `scriptName`, custom domain via `/v1/tenants/custom-domain`; `env.DISPATCHER.get(scriptName, …, {limits})`     |
| Cron             | `src/fanout/cron.ts`, `server.ts:838-847`                                             | fan-out through `DISPATCHER` to `/_lunora/scheduled`, because WfP drops cron triggers                                                       |
| Queues           | `server.ts:722-752`                                                                   | `handleQueueBatch` through `DISPATCHER` to `/_lunora/queue`                                                                                 |
| Requests metered | `src/metering/analytics.ts:87,160`, `metering/rollback.ts:59-96`, `sweeps.ts:124-166` | dispatcher → Analytics Engine `lunora_tenant_usage` → hourly readback into `platformUsage{kind:"requests"}`                                 |
| Logs             | `src/tail/worker.ts`, `router.ts:477-525`                                             | tail consumer → `/v1/logs/tail`                                                                                                             |
| OTLP             | `routes/otlp.ts:117-263`, `src/telemetry/ingest-key.ts:48-89`                         | standard `/v1/{traces,logs,metrics}`, deploy or ingest key; one ingest key minted per org                                                   |
| Admin / backups  | `src/admin/proxy.ts:71-104`, `src/backup/tenant-transport.ts:76-90`                   | `fetch(${url}/_lunora/admin/…)`; `tenantSender` falls back to `fetch(url)` when no dispatcher is bound                                      |
| Domains          | `lunora/domains.ts:52-217`, `src/domains/verify.ts:26-83`, `router.ts:726-755`        | TXT + CNAME check against `platformTargets: [LUNORA_APP_DOMAIN]`; certificate issuance **not wired** (`createCustomHostname` has no caller) |
| Secrets          | `src/secrets/crypto.ts:56-65`, `router.ts:833-867`                                    | AES-256-GCM under `SECRET_ENCRYPTION_KEY`, decrypted at the edge into `spec.secrets`                                                        |
| Fleet upgrade    | `src/fleet/upgrade.ts:38-98`                                                          | canary + batches of 25 over a `release` port; **no production caller**                                                                      |

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

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                                              | Owner                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------ |
| G1  | No cell is running. PR #85 is open; staging and production `wrangler.jsonc` still hold `<replace-with-…>` ids, which `deploy:check` refuses; the GitHub App credentials (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`) are unset. A box has no control plane to enrol into                                                                                                                                                                                                                            | PR #85 "Before this can deploy"; `GAPS.md` A3, A4, E3 | ops (🌐)                 |
| G2  | **A git push builds but never deploys.** `runBuild` supports a `release` port (`src/builds/runner.ts:107-163`), but `lunora/builds.ts:441-511` does not pass one. The build box returns only `index.js` + a hash (`containers/build/server.mjs:191-197`): no binding manifest, no assets, and the bundle is never stored (only `bundleHash` reaches the `builds` row). Only the CLI upload (`lunora cloud deploy`) reaches `/v1/deploy`. `GAPS.md` A3 reads "wired end to end", which overstates it | listed                                                | **W0b**                  |
| G3  | Placement is process-global. The deploy path uses `env.LUNORA_CELL` (`router.ts:805`) and never reads `organizations.cellId`. Per-project targets need placement read from the database                                                                                                                                                                                                                                                                                                             | listed                                                | Phase 1 — ✅ `93803df29` |

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

| #   | Gap                                                                                                                                                                                                                                           | Workstream |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G11 | No WebSocket endpoint and no custom Durable Object; `RouteAuth` has no box-key class (`route-registry.ts:20-32`)                                                                                                                              | W2         |
| G12 | No `boxes` / `boxEnrolments` tables, functions or `projects.boxId`                                                                                                                                                                            | W2         |
| G13 | `CloudflareApi` has no DNS-record methods, only `createCustomHostname` and `exportD1Database` (`src/cloudflare/api.ts:12-21`). The cell token also lacks Zone → DNS:Edit (PR #85's token scope list), and there is no `boxes.lunora.app` zone | W5         |
| G14 | No box-signed release route (`GET /v1/boxes/releases/:deploymentId`)                                                                                                                                                                          | W4         |
| G15 | No usage write path for a box: `usage.ingest` requires an org-wide deploy key (`lunora/usage.ts:96`), so `BoxSessionDO` needs an internal mutation                                                                                            | W6         |
| G16 | No per-box line item or entitlement (`src/billing/plans.ts`, `lunora/entitlements.ts`)                                                                                                                                                        | W6         |
| G17 | No store or CI workflow for signed `hostd` releases; `deploy-cloud.yml` publishes Workers only                                                                                                                                                | W7         |
| G18 | The studio has no target selector and no Boxes pages                                                                                                                                                                                          | W9         |

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
  sign, verify against pinned keys, artifact size + hash checks).
- `apps/hostd/scripts/build-sea.mjs`: Node 24 single executable (esbuild
  bundle + SEA blob + postject), smoke-tested with `--version`.
- `apps/hostd/scripts/make-release-manifest.mjs` + `release-pins.json`: make,
  sign and `--verify` manifests. celld is pinned to v0.6.0 (checksums verified
  against the downloaded assets).
- `.github/workflows/hostd-release.yml`: on a `hostd-v*` tag or dispatch, build
  and test, single executables on x64 and arm64 (`ubuntu-24.04-arm`) runners,
  sign in the `hostd-release` environment, attest, publish the GitHub Release.

Still open: no release key is committed (a placeholder that verification
refuses); Caddy with `caddy-ratelimit` needs our own xcaddy build before its
pins are real, so the workflow stops at signing until then. Next in W7:
`install.sh`, the control plane's `hostdReleases` table and `boxes.desiredReleaseId`,
and the `upgrade` job on the box.

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

| Binding type (`BindingRequirement["type"]`) | `cloudflare-wfp` (today) | `celld-vps`          | Notes                                                                                                                   |
| ------------------------------------------- | ------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `durable_object`                            | bound                    | native               | SQLite-backed classes only; celld refuses KV-backed migrations                                                          |
| `d1`                                        | provisioned              | native               | fleet SQLite; 100k rows / 32 MiB result cap; no read replicas                                                           |
| `kv`                                        | provisioned              | native               | no edge cache; single writer per namespace                                                                              |
| `r2`                                        | provisioned              | native               | served from the fleet bucket under `r2/<name>/`; no SSE-C or jurisdiction                                               |
| `queue_producer`                            | provisioned              | native               | one writer per queue; four-day retention                                                                                |
| `queue_consumer`                            | routed (fan-out)         | native               | push consumers on the `fetch` worker; pull mode refused                                                                 |
| `workflow`                                  | unsupported              | native               | celld implements Workflows (exercised by the TCK)                                                                       |
| `assets`                                    | bound                    | native               | `ASSETS` binding must be explicit; celld serves `max-age=0`, so `hostd`'s Caddy sets immutable headers for hashed paths |
| `container`                                 | unsupported              | **unsupported (v1)** | celld supports it with Docker on the node; deferred to keep the box Docker-free (§9 Q5)                                 |
| `ai`                                        | bound                    | unsupported          | not a celld binding                                                                                                     |
| `analytics_engine`                          | provisioned              | unsupported          | not a celld binding                                                                                                     |
| `browser`                                   | bound                    | unsupported          | not a celld binding                                                                                                     |
| `images`                                    | bound                    | unsupported          | not a celld binding                                                                                                     |
| `hyperdrive`                                | unsupported              | unsupported          | not a celld binding                                                                                                     |
| `vectorize`                                 | unsupported              | unsupported          | not a celld binding                                                                                                     |
| `pipeline`                                  | unsupported              | unsupported          | not a celld binding                                                                                                     |

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
- **Risk:** the 1 MiB WebSocket message cap. _Mitigate:_ releases never travel
  over the socket (D6). Cap `report` and `progress` frames in the protocol.
- **Risk:** celld is Deno's, and alpha. _Mitigate:_ `TargetDriver` keeps the
  target removable. The pin-and-upstream policy is in `MULTIPLATFORM.md` §7.8.
- **Perf watch:**
    - deploy latency from `accepted` to `released` for a 5 MiB release on a
      2 GB box, measured in `test:hostd`. Budget: under 30 s, matching WfP;
    - `BoxSessionDO` memory with 1,000 hibernated sockets. Add a `__bench__`
      suite in W2.

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
