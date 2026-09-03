# Lunora Cloud — Multi-Platform Gap Analysis & Build Plan

> Written 2026-07-29. Companion to [`GAPS.md`](./GAPS.md), which analyses the
> control plane **within** its Cloudflare substrate. This file analyses the
> substrate assumption itself: what a general-purpose deploy platform does that
> we don't, and what it would take to make Lunora Cloud deploy to more than one
> target.
>
> Three inputs: a teardown of [oblien/openship](https://github.com/oblien/openship)
> (Apache-2.0, ~9.4k★, TypeScript — patterns _and_ code portable with attribution),
> the open platform-abstraction PR
> ([#190](https://github.com/anolilab/lunora/pull/190), plan 114), and an
> evaluation of [alchemy](https://alchemy.run) as the provisioning engine.

Legend (same as `GAPS.md`): ✅ wired end-to-end · 🧩 pure module, tested, no
production caller · 🔨 code-tractable now · 🌐 needs live infra/credentials ·
🧭 decision, not code.

---

## 0. The one-sentence finding

Lunora Cloud is not a deploy platform that happens to run on Cloudflare — it is
**a Cloudflare Workers-for-Platforms control plane**, and the coupling is far
deeper than the one `Provisioner` interface in `src/provision.ts` suggests: it
also lives in the schema (`cells.cloudflareAccountId`,
`cells.dispatchNamespacePrefix`, `deployments.scriptName`), in the dispatcher,
in the metering readback (Analytics Engine), in the log path (tail consumers),
and in the teardown sweep. Adding a second target is **not** a matter of writing
a second `Provisioner`.

---

## 1. Openship teardown — what it actually is

Openship is a self-hosted PaaS in the Coolify / Dokploy / Dokku lineage: it takes
a git repo, detects how to build it, builds a Docker image (or a "bare" release),
runs it on a VPS or dedicated box you own, and fronts it with an OpenResty edge
that terminates TLS.

Shape (`bun` + `turbo` monorepo):

| Path                          | Role                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/{api,dashboard,web}`    | Control plane API + React dashboard + marketing site                                                     |
| `apps/desktop`                | Electron control plane for solo devs — drives remote servers over SSH                                    |
| `apps/cli`                    | `openship up`, deploys, scripting                                                                        |
| `apps/edge`                   | OpenResty/nginx edge image                                                                               |
| `apps/email`                  | Full SMTP server (engine + client + server) with DKIM/SPF/DMARC                                          |
| `packages/core`               | Language detection, workspace detection, config parsing/import, service routing, update advisories       |
| `packages/adapters`           | The interesting half: runtime adapters, infra adapters, backup engine, system/module management over SSH |
| `packages/{db,db-email,ui,…}` | Drizzle schemas, shared UI                                                                               |

### The parts worth studying

**Detection is a real subsystem, not a heuristic.** `packages/core/src/languages/`
has one module per stack (`javascript`, `python`, `go`, `rust`, `php`, `ruby`,
`java`, `elixir`, `docker`) and `packages/core/src/workspaces/` has one per
monorepo format (`node`, `cargo`, `gradle`, `maven`, `python-uv`, `rush`,
`dotnet`, `elixir`, `go`, plus `toml-helpers`). Detection returns a build plan,
not a boolean.

**Config import from competitors is a first-class feature.**
`packages/core/src/metadata/` parses `vercel.json`, Railway, and Render metadata
alongside its own `openship.json` — so migrating _in_ is a paste, not a rewrite.
Same idea in `packages/adapters/src/system/proxy/import/`: it imports existing
nginx, Caddy, Traefik, and Apache configs **and their certificates**, then takes
over the box (`takeover.ts`, `takeover-journal.ts`, `proxy-takeover.test.ts`).
That is a migration story with an undo log.

**The backup engine is a clean 3-axis matrix.** `backup/producers/`
(`pg-dump`, `mysql-dump`, `mongo`, `redis`, `volume`, `custom-command`, plus
`detect`) × `backup/destinations/` (`local`, `s3`, `sftp`) × `backup/executors/`
(`bare`, `docker`, `cloud`), glued by `registry.ts`, `manifest.ts`,
`sha256-stream.ts`, `key-builder.ts`. Any producer works with any destination.

**Host management is versioned and reconciled.**
`adapters/src/system/modules/` keeps a component catalog with versions
(`catalog.json`), an on-box manifest, a `reconcile.ts` that converges the box to
it, and `verify.ts`. Plus `available-version.ts` and `updates/advisories.ts` +
`release-advisories.json` — a security-advisory feed gating upgrades.

**Operational realism.** `port-conflict.ts`, `host-port.ts`, `port-scan.ts`,
`volume-namespace.ts`, `image-transfer.ts` (ship an image to a remote host
without a registry), `reverse-tunnel.ts`, `remote-journal.ts`,
`elevated-executor.ts` (sudo boundary), `reachability.ts`. This is the long tail
that separates a demo from a platform.

### What does _not_ transfer

Openship's substrate is **long-lived processes on machines you rent**. Ours is
**ephemeral isolates on machines nobody rents**. So Docker/compose, systemd/nohup
supervisors, OpenResty + certbot, port allocation, volume namespacing, SSH
executors, and the whole `system/` tree are answers to problems Workers deletes.
Copying them would be cargo-culting.

What transfers is one level up: **the shape of the abstractions** —
detect→plan→build→run→route as named stages; a producer×destination×executor
matrix for backups; import-from-competitor as a feature; versioned host state
with a reconcile loop.

---

## 2. Capability gap table

`apps/cloud` today vs. openship. Verdict column is a recommendation, not a
commitment.

| #   | Capability                      | Openship                                                              | Lunora Cloud today                                                                          | Verdict                                                                                                                                      |
| --- | ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-target deploy**         | VPS, dedicated, multi-node, its own cloud                             | Cloudflare WfP only, hardcoded to the schema                                                | **Adopt** — §4–6, the point of this file                                                                                                     |
| 2   | **Language/framework detect**   | 10 languages + 9 workspace formats → build plan                       | `projects.framework` — an optional free-text hint nothing consumes                          | **Adapt, narrow.** We deploy Lunora apps, not arbitrary repos; but framework (TanStack Start / Astro / Nuxt) genuinely changes the build. 🔨 |
| 3   | **Config import**               | `vercel.json`, Railway, Render metadata parsers                       | none                                                                                        | **Adopt later.** Cheap, high conversion value once there's something to convert to. 🔨                                                       |
| 4   | **Build execution**             | Docker buildkit / bare, on your box, streamed logs                    | `src/builds/runner.ts` orchestration ✅, `execute` port 🌐 (needs the Container)            | **Adopt** — and it becomes the natural home for Alchemy (§5.3)                                                                               |
| 5   | **Backups & restore**           | producer×destination×executor matrix, manifests, checksums            | GAPS.md D1 — 🌐, nothing built                                                              | **Adopt the matrix shape.** Producers become `d1-export` / `do-pitr` / `r2-sync`; destinations `r2` / `s3` / `customer-bucket`. 🔨           |
| 6   | **Managed databases**           | Postgres, MySQL, MongoDB, Redis as first-class provisionable services | D1 + R2 only, implicit in the tenant binding spec                                           | **Adopt via Alchemy** — Neon/PlanetScale/Upstash providers exist (§4)                                                                        |
| 7   | **Edge / TLS / custom domains** | OpenResty + certbot + Lua, proxy takeover, cert import                | `lunora/domains.ts` + `src/domains/verify.ts` ✅ model, 🌐 cert issuance (CF for SaaS)      | **Reject openship's approach.** Cloudflare issues certs. Keep ours; per-target the _interface_ is what generalises.                          |
| 8   | **App catalog / one-click**     | `core/src/apps/catalog/*.json` + templates                            | none                                                                                        | **Adopt later** — GAPS.md already lists "templates & marketplace" under Later                                                                |
| 9   | **Mail server**                 | Ships an entire SMTP stack                                            | `@lunora/mail` → Resend for transactional only                                              | **Reject.** Running MTAs is a business, not a feature.                                                                                       |
| 10  | **Host state reconcile**        | versioned module catalog + on-box manifest + reconcile + verify       | fleet runtime versioning (`src/fleet/upgrade.ts`, GAPS.md E4) — same idea, one axis         | **Adapt.** Our "host" is the runtime version pinned into each tenant bundle; generalise `fleet/upgrade.ts` into a per-target reconcile. 🔨   |
| 11  | **Security advisories**         | `release-advisories.json` + `updates/advisories.ts` gating upgrades   | none — fleet upgrades are version-floor only                                                | **Adopt.** Small, and it's the honest reason to force a fleet upgrade. 🔨                                                                    |
| 12  | **Desktop / local control**     | Electron app driving remote hosts over SSH                            | `@lunora/studio` local + hosted studio                                                      | **Reject.** Different product shape; our local story is the OSS CLI.                                                                         |
| 13  | **Multi-node / scheduling**     | Places services across a fleet of boxes                               | `src/deploy/scheduler.ts` + `cells` — same problem, different unit (accounts, not machines) | **Already have it.** Note for §6: the cell abstraction is target-shaped and needs widening.                                                  |
| 14  | **Agent/MCP surface**           | `agents`/`ai` topics; not a shipped subsystem                         | `src/mcp/{handler,tools}.ts` ✅                                                             | **We're ahead.** Keep.                                                                                                                       |
| 15  | **Observability**               | live logs + container metrics                                         | logs, traces, metrics, issues, incidents, alerts, uptime, dashboards ✅                     | **We're well ahead.** Keep.                                                                                                                  |

**Summary:** we are ahead of openship on observability, alerting, billing,
metering, auth/RBAC and agent surface. We are behind on **substrate breadth**
(1, 6), **build execution** (4), **backups** (5), and the **migration-in story**
(3). Only (1) is architectural; the rest are features.

---

## 3. The multi-platform problem — three seams, one exists

"Multi-platform" is used for three different seams in this repo. Conflating them
is why the problem looks smaller than it is.

| Seam                     | Question it answers                                                                               | Who owns it                                                 | Status                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| **Engine host**          | Can the reactive engine run somewhere that isn't a Durable Object?                                | `@lunora/platform` + `@lunora/shard-engine` (PR #190)       | ✅ contracts + TCK; one host implemented       |
| **App config emission**  | What does an app need, and how does one host encode it?                                           | `@lunora/config` `ResourceGraph` + `DeployDriver` (PR #190) | ✅ contract; only the Cloudflare driver exists |
| **Managed provisioning** | How does _the control plane_ create, route, meter and tear down a tenant's resources on a target? | `apps/cloud`                                                | ❌ **does not exist** — Cloudflare is inlined  |

PR #190 lands the first two. It deliberately does **not** touch `apps/cloud`,
and its own follow-up note says to mint `@lunora/platform-<target>` "when a
second target actually exists (plan 115)." That is exactly the hole this plan
fills — plus the observation that the OSS `DeployDriver` is **CLI-shaped**
(`ToolchainCommand` — "run `wrangler deploy`"), which is useless to a control
plane that must provision _on behalf of a tenant_ with no shell, no repo
checkout and no interactive auth.

### Where Cloudflare is currently hardcoded in `apps/cloud`

Enumerated so the size is not a surprise:

| Location                                 | Coupling                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lunora/schema.ts` `cells`               | `cloudflareAccountId`, `dispatchNamespacePrefix`, `jurisdiction` (DO/R2 terms)                                                                                      |
| `lunora/schema.ts` `deployments`         | `scriptName` (dispatch-namespace script id), `cronSpecs` (wrangler `triggers.crons`), `bindings[].type` = wrangler kinds, `adminToken*` (tenant `/_lunora/admin/*`) |
| `src/provision.ts`                       | `TenantBindingSpec` = `{d1, r2, durableObjects}`; `tenantD1Name` / `tenantR2Bucket`                                                                                 |
| `src/cloudflare/api.ts`                  | the whole REST port                                                                                                                                                 |
| `src/dispatcher/{route,worker}.ts`       | `env.DISPATCHER.get()` — WfP dispatch is _the_ routing mechanism                                                                                                    |
| `src/metering/analytics.ts`              | Analytics Engine as the request-count source of truth                                                                                                               |
| `src/deploy/teardown.ts`                 | deletes a dispatch script; D1/R2 named by convention                                                                                                                |
| `src/fanout/{cron,queue}.ts`             | exists **because** WfP drops cron triggers for namespaced workers                                                                                                   |
| `lunora/logs.ts` + `tail.wrangler.jsonc` | tail consumers                                                                                                                                                      |
| `src/fleet/upgrade.ts`                   | "runtime version" == the `@lunora/runtime` bundled into a Worker                                                                                                    |

Nine of those are not `Provisioner` implementations. They are **assumptions
about what a deployment is**.

---

## 4. Alchemy evaluation

[alchemy-run/alchemy](https://github.com/alchemy-run/alchemy) — TypeScript-native
IaC where resources are memoized async functions with explicit create/update/
delete lifecycles and a pluggable state store. No CloudFormation/Terraform layer;
it calls provider APIs directly.

**Two live lines, and the choice matters:**

|           | `alchemy@latest` (0.93.12)                                                                                                    | `alchemy@next` (2.0.0-beta.65)                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Model     | plain async/ESM, `alchemy()` app + `Scope`                                                                                    | rewritten on **Effect** — `Alchemy.Stack`, `Effect.gen`, provider layers |
| Providers | cloudflare, aws, vercel, neon, planetscale, upstash, clickhouse, prisma-postgres, docker, github, stripe, sentry, dns, os, fs | cloudflare, aws, neon, planetscale, github, axiom (**no vercel**)        |
| Maturity  | shipping, broad                                                                                                               | beta, narrower surface, larger conceptual dependency                     |

**Recommendation: pin `alchemy@0.93.x`.** The provider breadth _is_ the reason we
want it (Vercel and Upstash are absent from v2 today), and adopting Effect into
the control plane is a much larger bet than adopting an IaC library. Revisit v2
once its provider matrix catches up — the port boundary in §5 makes that a
swap, not a migration.

### The blocker nobody has written down

`src/provision.ts` already says an Alchemy-backed implementation "can replace
`createHttpCloudflareApi` later with no change above this module." **It cannot,
not in the control-plane Worker.** `alchemy@0.93`'s top-level dependencies
include `wrangler`, `miniflare`, `esbuild`, `execa`, `find-process`,
`proper-lockfile`, `signal-exit`, `open` and `glob` — Node/process-shaped, not
workerd-shaped. The control plane is a Worker. Alchemy cannot run in it.

This is not fatal; it decides the architecture. **Alchemy runs where a Node
process already has to exist: the build/provision container.** `src/builds/runner.ts`
already models that container as an injected `execute` port (GAPS.md A3, 🌐).
The same container that runs `lunora build` runs the Alchemy program. The
control plane keeps its thin, workerd-safe REST port for the hot path
(dispatcher route lookups, secret writes, teardown) and delegates _convergence_
to the runner.

That split is also the right one on the merits: convergence is slow, retryable
and stateful; the control plane's request path is none of those.

### What Alchemy buys, honestly

- ✅ **Provider breadth we will not write.** Neon and PlanetScale (branchable
  Postgres/MySQL — directly serves GAPS.md "preview environments / database
  branching"), Upstash Redis, S3, Vercel, plus AWS.
- ✅ **A real state model.** Today convergence state is implicit in
  `deployments` rows plus naming conventions (`tenantD1Name`). Alchemy's state
  store makes "what exists" explicit and diffable, with a D1-backed store that
  fits our substrate.
- ✅ **Destroy that actually works.** `src/deploy/teardown.ts` currently
  best-efforts an R2 delete and logs a known leak for non-empty buckets.
  Lifecycle-managed resources are the cure for convention-named ones.
- ⚠️ **Not a WfP replacement.** Alchemy's Cloudflare provider is
  regular-Worker-shaped. Dispatch-namespace script upload, per-plan limits and
  outbound workers are our differentiator and stay on our own REST port.
- ⚠️ **New supply-chain surface.** ~30 transitive deps in a path that holds
  tenant credentials. Runs in the container, never in the control plane — which
  is also the right blast radius.
- ⚠️ **Pre-1.0.** Pin exactly; wrap behind our own port (§5.1) so a v2 move or
  a drop-out is local.

---

## 5. Target architecture

### 5.1 `TargetDriver` — the control-plane seam (`src/targets/`)

The managed analogue of the OSS `DeployDriver`. It is **API-shaped, not
CLI-shaped**, and it is what `src/provision.ts` generalises into.

```ts
// src/targets/driver.ts — sketch, not final
export interface TargetDriver {
    /** `"cloudflare-wfp"` | `"cloudflare-workers"` | `"vercel"` | `"aws-lambda"` … */
    readonly id: string;

    /** What this target can actually do — gates codegen and the studio UI. */
    readonly capabilities: TargetCapabilities;

    /** Neutral requirements (from @lunora/config's ResourceGraph) → a converge plan. */
    plan: (request: TenantDeploymentRequest) => Promise<ConvergePlan>;

    /** Execute a plan. Idempotent; retryable; streams progress lines. */
    converge: (plan: ConvergePlan, sink: ProgressSink) => Promise<ConvergeResult>;

    /** Reverse a converge. Must be safe to run twice. */
    destroy: (reference: DeploymentRef) => Promise<void>;

    /** Where does a request for `alias` go, and is the tenant allowed to serve it? */
    route: (alias: string) => Promise<RouteResolution>;

    /** Request counts / CPU / egress for a window — the metering readback. */
    usage: (cell: CellRef, sinceMs: number) => Promise<UsageDelta[]>;

    /** Bind a verified custom domain to a deployment. */
    domains: DomainOps;

    /** Where do tenant logs come from on this target? */
    logs: LogSourceOps;
}
```

`TargetCapabilities` is the honest part. Not every target has Durable Objects,
hibernated WebSockets, cron triggers, or per-request isolate limits. It composes
with `@lunora/platform`'s `PlatformCapabilities` from PR #190 — same vocabulary,
one on the engine side, one on the provisioning side — and drives:

- codegen (`runCodegen({ target })` already omits unsupported `ctx.*` surfaces
  with a `platform_unsupported_feature` diagnostic);
- the studio, which must **not** show a Bindings graph for a target with no
  bindings;
- plan/entitlement gating (`.global()` replication is not free everywhere).

### 5.2 Schema changes

Additive, so existing rows keep working:

```
cells:        + target: string                 // "cloudflare-wfp" (default for existing rows)
              + credentialsRef: string         // → secrets store, replaces cloudflareAccountId
              ~ cloudflareAccountId            // deprecated; migrate into a target-config blob
              + config: object                 // target-specific (dispatchNamespacePrefix, region, …)

projects:     + target: optional string        // inherits the org/cell default when unset

deployments:  + target: string
              + resourceRef: string            // replaces `scriptName` as the neutral handle;
                                               // `scriptName` stays as the Cloudflare encoding
              + convergeState: optional string // Alchemy state-scope id for this deployment
```

Rule: **no new Cloudflare noun in a shared table.** Target-specific fields go in
`config` / the driver's own state.

### 5.3 Where Alchemy sits

```
control plane Worker  ──►  TargetDriver (workerd-safe half)
                             ├── route()   — dispatcher lookups, hot path
                             ├── usage()   — metering readback
                             └── destroy() — teardown sweep, via REST
                                   │
                                   │ enqueue converge job
                                   ▼
build/provision container (Node)  ──►  TargetDriver (converge half)
                             ├── lunora build            → bundle
                             ├── alchemy program          → resources
                             │     ├─ alchemy/cloudflare  (D1, R2, KV, Queues)
                             │     ├─ alchemy/neon        (branchable Postgres)
                             │     ├─ alchemy/planetscale (branchable MySQL)
                             │     └─ alchemy/vercel|aws  (second targets)
                             ├── our own WfP REST upload  (dispatch script + secrets)
                             └── progress → buildLogs (existing NDJSON stream)
```

State store: **D1 in the control plane's own account**, one Alchemy scope per
`(cell, project, environment)`. Never the tenant's account — convergence state
is platform state, and a tenant must not be able to corrupt it.

### 5.4 What the first non-Cloudflare target should be

Not AWS. The cheapest honest second target is **`cloudflare-workers`** — a plain
Worker in the _tenant's own_ Cloudflare account, no dispatch namespace. It is
the BYO-Cloudflare tier the ROADMAP already promises as "Now/Next", it exercises
every seam in §5.1 (different routing, different metering source, different
teardown, no WfP outbound worker), and it fails fast if the abstraction is
wrong — without also debugging IAM.

**Second: Neon or PlanetScale as a `.global()` backend.** Not a compute target
at all, but it proves the resource matrix independent of compute, and
`@lunora/hyperdrive/global` already supports PlanetScale as a reactive
`.global()` backend on the framework side. Highest value per unit of risk in the
whole plan.

**Third (only if demand is real): `vercel` or `aws-lambda`.** Both require the
engine-host work from PR #190's deferred phase (the 19-module / ~9,400-line
`ctx-db` + `relay` closure) to actually land, because a non-DO host needs a
non-DO `ShardHost`. Do not start these before that closure moves.

---

## 6. Phased plan

Each phase is independently shippable and independently useful — the same rule
plan 114 §6 sets. Phases 0–2 have value even if multi-target is never finished.

### Phase 0 — Prove the runner (🌐 → ✅) · unblocks everything

The `execute` seam in `src/builds/runner.ts` is the single blocker shared by
build execution, Alchemy, and every non-Cloudflare target.

1. Stand up the build container via `@lunora/container` (`defineContainer`),
   Node-based, no network egress except the git host + provider APIs.
2. Implement `fetchSource` (GitHub App installation token → repo tarball) and
   `execute` (`lunora build` → bundle + hash), streaming into `buildLogs`.
3. Wire `src/builds/dispatch.ts`'s claim→run→drain loop into `scheduled()` —
   deliberately unwired today because claiming builds with no executor burns them.
4. Add `alchemy@0.93.x` (pinned) to the container image only. **Never** to
   `apps/cloud/package.json` — a Node-only dep in the Worker bundle is a
   build-time footgun waiting to happen.

**Exit:** a git push produces a live deployment with streamed build logs, no
local bundle upload.

### Phase 1 — Extract `TargetDriver`, behaviour-preserving (🔨)

1. `src/targets/driver.ts` — the interface and `TargetCapabilities`.
2. `src/targets/cloudflare-wfp/` — move `src/provision.ts`, `src/cloudflare/api.ts`,
   the dispatcher route resolution, the AE metering reader and the teardown sweep
   behind it. Zero behaviour change; the existing tests are the proof.
3. `src/targets/registry.ts` — id → driver, mirroring `@lunora/config`'s driver
   registry so the two stay conceptually aligned.
4. Schema §5.2, with `target` defaulting to `"cloudflare-wfp"` for existing rows.
5. A **driver conformance suite** in `__tests__/`, modelled on PR #190's
   `/conformance` TCK: N legs every driver must pass (converge is idempotent,
   destroy is idempotent, converge-after-destroy re-creates, route returns 404
   for an unknown alias, usage never double-counts across a checkpoint). Written
   against an in-memory reference driver **first** — PR #190's most expensive
   lesson was that an abstraction nothing exercised was wrong in four separate
   ways, and only wiring a second implementation revealed it.

**Exit:** `apps/cloud` has no Cloudflare import outside `src/targets/cloudflare-wfp/`
and the dispatcher Worker. Enforceable with an ESLint `no-restricted-imports`
boundary — add it in this phase, not later.

### Phase 2 — Alchemy inside the converge half (🔨 + 🌐)

1. `src/targets/alchemy/` — a thin port over Alchemy: app/scope construction,
   the D1 state store, error normalisation into `@lunora/errors`.
2. Move per-tenant D1/R2 creation from convention-named REST calls to
   Alchemy-managed resources. **Adopt existing resources** rather than
   re-creating them (Alchemy supports adoption) — live tenants must not churn.
3. Keep the WfP dispatch-script upload on our own REST port. Alchemy does not
   model dispatch namespaces, and this is our differentiator.
4. Replace the teardown sweep's best-effort deletes with `destroy` over the
   Alchemy scope. This closes the known non-empty-R2-bucket leak in GAPS.md.

**Exit:** provisioning state is explicit and diffable; teardown has no
documented leak.

### Phase 3 — Second target: `cloudflare-workers` (BYO account) (🔨 + 🌐)

1. `src/targets/cloudflare-workers/` against the driver + conformance suite.
2. OAuth-scoped, revocable Cloudflare account linking (the ROADMAP's
   "connect-your-Cloudflare onboarding") — credentials in the existing
   AES-256-GCM envelope store (`src/secrets/crypto.ts`), never in plaintext columns.
3. Routing without a dispatcher: `workers.dev` subdomain or a customer zone.
4. Metering without our Analytics Engine: read the customer account's
   GraphQL Analytics API. **Expect this to be the phase's hardest part** —
   it is also the one that proves `usage()` was the right seam.
5. Studio: capability-gated tabs; a BYO deployment has no per-plan runtime limits
   and no outbound worker, and the UI must say so rather than render an empty box.

**Exit:** the ROADMAP's BYO-Cloudflare tier ships, and the abstraction has been
tested by a second implementation instead of by inspection.

### Phase 4 — Resource breadth (🔨)

1. Neon / PlanetScale as `.global()` backends via Alchemy providers, surfaced in
   the tenant binding spec.
2. **Database branching for previews** — the feature that actually needs this
   work. A PR preview branches the database instead of sharing production's,
   closing the caveat in GAPS.md's wiring pass ("previews that reuse the
   production alias would share its D1").
3. Backups on openship's matrix shape: `producers` (`d1-export`, `do-pitr`,
   `r2-sync`, `neon-branch`) × `destinations` (`r2`, `s3`, customer bucket) ×
   `executors` (control-plane cron, container), with manifests + SHA-256 streams.
   Closes GAPS.md D1.

### Phase 5 — Migration-in and fleet hygiene (🔨)

1. Config import: `vercel.json` / Railway / Render → a Lunora project (openship's
   `core/src/metadata/` is Apache-2.0 and directly portable **with attribution**).
2. Security advisories: an advisory feed + `updates/advisories.ts`-style
   resolution gating fleet upgrades — the honest reason to force a re-release,
   generalising `src/fleet/upgrade.ts` per target.

---

## 7. Decisions needed (🧭)

| #   | Decision                          | Options                                                     | Recommendation                                                                                                                                                      |
| --- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alchemy line                      | `0.93.x` stable vs `2.0.0-beta` (Effect)                    | **0.93.x, exact pin.** Provider breadth is the reason to adopt; Effect is a separate, larger bet. Re-evaluate at v2 GA.                                             |
| 2   | Alchemy scope                     | all provisioning vs resources-only (WfP stays ours)         | **Resources-only.** Alchemy does not model dispatch namespaces, and WfP is the differentiator.                                                                      |
| 3   | Second target                     | `cloudflare-workers` (BYO) vs Vercel vs AWS                 | **BYO Cloudflare.** Already on the ROADMAP, exercises every seam, no new engine-host work.                                                                          |
| 4   | Multi-target scope of the promise | "same code anywhere" vs "same code, capability-gated"       | **Capability-gated, stated loudly.** A target without DOs cannot honour hibernated WS subscriptions; promising it is a lie the runtime will expose.                 |
| 5   | Where converge runs               | control-plane Worker vs build container vs separate service | **Build container.** Forced by Alchemy's Node deps, and correct on blast radius anyway.                                                                             |
| 6   | Openship code reuse               | patterns only vs port Apache-2.0 modules                    | **Port `core/src/metadata/` (config import) with attribution; patterns only elsewhere.** The rest is machine-shaped. Record it in `LICENSE.md` third-party notices. |
| 7   | Relationship to PR #190           | wait for it vs build in parallel                            | **Parallel, but take its vocabulary.** `TargetCapabilities` must compose with `PlatformCapabilities`, not compete. Phases 0–2 do not depend on #190 merging.        |
| 8   | Own the runtime or rent it        | rent Cloudflare vs fork a runtime vs build one              | **Rent, and keep the seam.** The runtime is a cost centre; the control plane and the DX are the product. celld ships unforked as the self-host tier — see below.    |

### 7.8 Own the runtime or rent it — the long form

Row 8 is the only decision here that changes what Lunora Cloud _is_, so it does
not fit in a cell.

**The question.** Cloud today is a Workers-for-Platforms control plane (§0), so
Cloudflare is both the substrate and the COGS floor. Owning a runtime instead —
forking [celld](https://github.com/denoland/celld) (Apache-2.0, executes Wrangler
bundles, self-hosted distributed Durable Objects; see `@lunora/platform-celld`)
or building one — would recover that margin and unlock deployments Cloudflare
structurally cannot sell.

**The answer is rent, for three reasons that are not "it is hard".**

1. **It contradicts a published promise.** `ROADMAP.md` says "there is no
   proprietary runtime to get stuck in" and sells no-lock-in as the reason to
   trust Cloud. A fork _is_ a proprietary runtime. Reversing that is a
   positioning change to make deliberately, not to arrive at by way of a
   dependency.
2. **Stateful blast radius.** Lunora apps keep customer rows in the shard. On
   Cloudflare, a Durable Object losing data is Cloudflare's incident; on a fleet
   we operate, a split-brain cell eating a tenant's rows is an existential
   incident for us, at a headcount with nobody on call for object-store
   consistency. That risk is not proportional to the margin recovered until the
   customer count makes it obviously so.
3. **The seam is the asset, not the runtime.** `PlatformCapabilities` plus the
   `TargetDriver` extraction (Phase 1) is what makes "we can move" true. It pays
   for itself inside the Cloudflare-only product, and every option below stays
   open behind it — including eventually owning a fleet.

**Where celld fits anyway**, and it does fit — unforked, which is _better_ for
the no-lock-in promise than a fork would be:

- **Self-hosted / sovereign / air-gapped.** The tier Cloudflare cannot sell.
  Already costs ~55 lines (`@lunora/platform-celld` recomposes the Cloudflare
  adapters under a celld capability matrix), and it is a real enterprise line
  item against every Workers-shaped competitor.
- **Fully-managed "Later" (`ROADMAP.md` phase 2).** Operating a celld fleet
  needs no fork either — Apache-2.0, `celld deploy` works today.

**When to revisit.** Two triggers, both concrete: a patch upstream refuses (they
take `git format-patch` by email under a CLA assigning rights, so friction is
real), or an SLA that cannot sit on an upstream alpha with no LTS. The answer to
the second is a **pinned vendored build carrying patches we upstream**, not a
fork we let diverge. Fork the day we are already carrying a rejected patch.

**Risk to keep in view.** celld is Deno Land's, and hosted celld is a plausible
product for them — the same platform risk Cloudflare already represents. That is
an argument for the abstraction, not for owning a second runtime.

---

## 8. Non-goals

Stated so they don't creep back in:

- **We are not building a general-purpose PaaS.** No Docker, no VPS, no systemd,
  no port allocation, no OpenResty, no SSH executors. Lunora Cloud deploys
  **Lunora apps**. Gaps 9, 12 in §2 are permanent rejections, not backlog.
- **We are not running an MTA.** `@lunora/mail` → Resend, full stop.
- **We are not promising target parity.** Capability-gated, per §7.4.
- **We are not building or forking a runtime.** Per §7.8: we rent the substrate
  and own the control plane. celld ships unforked as the self-host tier.
- **We are not rewriting the observability stack per target.** OTel is the
  substrate-neutral floor (alpha owns it, PR #189); a target that cannot emit
  OTLP gets degraded observability and says so.

---

## 9. Ordering vs. `GAPS.md`

This plan competes with `GAPS.md` for the same hands, so the interleave matters:

1. **Phase 0 first, unconditionally.** It is already GAPS.md A3's blocker; this
   plan just adds a second reason. Nothing else in either file is as leveraged.
2. **Phase 1 before any new deploy-path feature.** Every feature added to
   `src/provision.ts` before the extraction is a feature that has to be extracted
   twice.
3. **Phase 2 before GAPS.md D1 (backups).** Backups over convention-named
   resources are backups over a leak.
4. **Phase 3 gates on the ROADMAP**, not on this file. If BYO-Cloudflare is not
   a near-term commercial priority, stop after Phase 2 — Phases 0–2 pay for
   themselves inside the Cloudflare-only product, and Phase 1's conformance
   suite keeps the seam honest until a second target arrives.
