# Cirrus Cloud — Managed Platform Plan

> Direction doc, 2026-06-12. Synthesized from three research passes: (1) a repo-grounded
> inventory of the control-plane primitives Cirrus already ships, (2) a teardown of
> Convex's managed cloud (the product model to copy), and (3) a survey of Cloudflare
> primitives + OSS prior art for building a deploy platform on Cloudflare (the
> implementation substrate). Companion docs: `VOID-TEARDOWN.md` (DX reference),
> `CONVEX-PARITY.md` (feature parity), `STUDIO-VS-CLOUDFLARE.md` (dashboard boundary).

---

## 0. Decision reversal

Two prior docs marked the managed deploy plane as a deliberate **won't-do**:

- `VOID-TEARDOWN.md` §0/§6 — "the managed plane is a business decision Cirrus skips."
- `CONVEX-PARITY.md` gap #23 — "Deployments / rollbacks / routes remain an explicit
  non-goal (PLAN3 §3.1–3.2) — CF's control plane, reached via deep-links, not
  half-reimplemented."

**This plan reverses that decision** — with a crucial scoping nuance that keeps the old
rationale intact: we still do not reimplement Cloudflare's control plane for users
deploying to _their own_ Cloudflare accounts (that path stays as-is: `cirrus deploy` →
wrangler → their account, studio self-hosted). What we add is a **managed tier**: Cirrus
Cloud runs customer apps inside _our_ Cloudflare account via Workers for Platforms, and
there a control plane is not "half-reimplementing CF" — it is the product. The
app-observation philosophy (`STUDIO-VS-CLOUDFLARE.md`) carries over unchanged: the hosted
dashboard is the studio, multi-tenant.

Why now:

1. **DX ceiling.** The single biggest remaining DX gaps — zero-setup onboarding, cloud
   dev deployments, per-branch preview deployments, team collaboration, "it deployed and
   I have a URL in 30 seconds" — are all control-plane features. They cannot be shipped
   as a CLI flag against a user-owned account (D1 placeholder IDs, wrangler OAuth, custom
   domains, secrets ceremony all remain the user's problem).
2. **The substrate matured.** Workers for Platforms (dispatch namespaces, per-tenant
   bindings, custom limits, tags), remote bindings GA, Cloudflare for SaaS, and the
   `cloudflare-typescript` SDK make the platform layer dramatically thinner than what
   Convex had to build from scratch (they wrote a database _and_ a cloud; our data plane
   is already Cloudflare's).
3. **Validation + urgency.** void proved the model (framework + managed CF platform);
   VoidZero was acquired by Cloudflare (June 2026, parts of void to be open-sourced).
   Convex's entire business is the control plane around an OSS backend. Every
   self-hostable Convex-like (Convex, Instant, Supabase) open-sources the data plane and
   monetizes the control plane.

---

## 1. Reference models (what each one contributes)

| Reference                                                                                               | What we take from it                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Convex Cloud**                                                                                        | The product model: teams → projects → three deployment classes (prod, **per-developer dev**, **TTL'd per-branch previews**); deploy-key types that encode the target (`prod` / `dev:…` / `preview:team:project`); `deploy --cmd` wrapping the frontend build + injecting the backend URL; a deliberately small management API. |
| **void** (`VOID-TEARDOWN.md`)                                                                           | The DX bar: one-command deploy with NDJSON progress events, schema-drift gate, post-deploy migration handshake before traffic switch, rollback, remote-binding dev, `auth login/whoami/token` + `project link/list/logs/rollback` CLI verbs.                                                                                   |
| **PartyKit** ([partykit/partykit](https://github.com/partykit/partykit))                                | The deploy UX + the **managed-vs-BYO split**: build locally (esbuild facade injecting DO class exports — exactly our `ShardDO`/`SessionDO` shape), push the bundle to the platform API, get `{name}.{user}.partykit.dev`; setting `CLOUDFLARE_API_TOKEN` flips the same CLI to the customer's own account ("cloud-prem").      |
| **cloudflare/vibesdk** ([repo](https://github.com/cloudflare/vibesdk))                                  | The most complete open end-to-end reference of a control plane on WfP: dispatch namespace deploys, D1+Drizzle control-plane DB, R2/KV, wildcard subdomain routing. Study before writing ours.                                                                                                                                  |
| **workers-for-platforms-example** ([repo](https://github.com/cloudflare/workers-for-platforms-example)) | Minimal dispatcher skeleton (hostname → tenant → `env.DISPATCHER.get(script, …, { limits, outbound })`).                                                                                                                                                                                                                       |
| **Alchemy** ([sam-goodwin/alchemy](https://github.com/sam-goodwin/alchemy))                             | TS-native, embeddable IaC for CF resources (no wrangler dependency, runs inside a CLI) — candidate provisioning engine or design model for ours.                                                                                                                                                                               |

---

## 2. Architecture

```
 developer machine                        Cirrus Cloud (our CF account)
┌──────────────────────┐                ┌──────────────────────────────────────────────┐
│ cirrus CLI / @cirrus │   deploy API   │  Control plane (Worker + D1 + Queues)        │
│ /vite plugin         ├───────────────▶│  orgs · projects · deployments · deploy keys │
│                      │                │  secrets vault · usage metering · audit      │
│  vite build ──▶ bundle                │  provisioning via cloudflare-typescript      │
│  (facade injects DO  │                └───────┬──────────────────────────────────────┘
│   class exports)     │                        │ multipart script upload + bindings
│                      │                        ▼
│  remote-bindings     │   wss/https    ┌──────────────────────────────────────────────┐
│  proxy session ──────┼───────────────▶│  Dispatch namespaces (prod · preview · dev)  │
└──────────────────────┘                │  per-project user Worker = Cirrus runtime    │
                                        │  + per-tenant D1 / R2 / KV / DO bindings     │
 end users ────────────────────────────▶│  Dispatcher Worker: hostname→tenant routing, │
  {project}.cirrus.app / custom domain  │  custom limits, tags, outbound worker        │
  (Cloudflare for SaaS)                 └──────────────────────────────────────────────┘
```

### 2.1 Data plane: Workers for Platforms

- **One dispatch namespace per environment class** (`production`, `preview`, `dev`) —
  not per customer (WfP best practice). User Workers run untrusted-mode-isolated.
- Each project's Worker is the standard Cirrus runtime (`createWorker(...)` — unchanged)
  uploaded via the multipart script API with **per-tenant bindings in the metadata
  JSON**: its own D1 database (`.global()` tables), R2 bucket, DO classes with
  migrations. `@cirrus/config`'s inference output maps 1:1 onto this metadata — the
  reconciler that today edits `wrangler.jsonc` emits the upload metadata instead.
- **Dispatcher Worker** resolves `{project}.cirrus.app` / custom hostname → tenant
  script, applies per-plan `limits: { cpuMs, subRequests }`, tags
  (`org:…`, `project:…`, `env:…`, `plan:…`) for lifecycle/bulk-delete, and an outbound
  worker for egress policy. WebSockets (our subscription path) pass through dispatch.
- **Custom domains** via Cloudflare for SaaS custom hostnames ($0.10/mo per hostname
  past 100).
- **Watch: DO facets / Dynamic Workers.** Cloudflare is shipping per-tenant dynamic
  counterparts to every binding (child DOs with isolated SQLite, runtime-loaded code).
  If that lands fully, most per-tenant REST provisioning disappears. Design the
  provisioning module behind an interface so it can be swapped.

### 2.2 Control plane

A boring Cirrus-shaped service (we should dogfood: build it _on Cirrus_):

- **Entities:** org → project → deployments (`prod` ×1, `dev` ×N per member,
  `preview` ×N TTL'd) — Convex's model verbatim, including auto-cleanup of previews
  (5–14 days by plan).
- **Deploy API** (the only API the CLI needs, Convex-sized):
  `POST /projects` · `POST /projects/:id/deployments` · `GET /projects/:id/deployments`
  · `POST /deploy-keys` (type-prefixed: `prod:` / `dev:` / `preview:org:project`) ·
  `POST /deployments/:id/deploy` (bundle upload → NDJSON/SSE progress events:
  provisioning, migration, worker_upload, done — void's protocol) ·
  `POST /deployments/:id/rollback`.
- **Provisioning:** `cloudflare-typescript` (`workersForPlatforms.dispatch.namespaces.
scripts.update`, `d1.database.create`, `r2.buckets.create`, `customHostnames`).
  Bundling stays client-side in our existing Vite pipeline (PartyKit model) — the
  platform never builds user code in v1.
- **Secrets:** per-deployment env vars/secrets stored in the control plane, applied via
  the WfP script-secrets API; the `.dev.vars` grammar + placeholder/secret detection in
  `@cirrus/config` becomes the dashboard's guided setup.
- **Tokens:** today's single static `CIRRUS_ADMIN_TOKEN` becomes platform-issued,
  role-scoped (admin / viewer / ci), per-deployment, rotatable, audited.

### 2.3 Cloud dev DX (the actual point of all this)

Three rungs, shipped in this order:

1. **Remote-binding dev** (PLAN5 Phase 5, `VOID-TEARDOWN.md` §4.5) — works for BYO
   _and_ managed users. Wrangler ≥4.37 exposes the machinery programmatically
   (`startRemoteProxySession` / `pickRemoteBindings`); `@cirrus/vite` can run local code
   against real platform-provisioned D1/R2/KV. We do not need to build void's
   hand-rolled proxy — Cloudflare shipped it. Shard DOs keep running locally in v1
   (same pragmatic cut void made for its hard cases).
2. **Per-developer cloud dev deployments** — `cirrus dev --cloud`: watch → bundle →
   push to a personal deployment in the `dev` namespace → tail logs. Zero local
   Miniflare/wrangler setup; the team-onboarding story becomes "clone, `cirrus dev`,
   you have a backend." (Convex shipped cloud-dev-first then retrofitted local; we
   have the luxury of keeping local-first as the default and making cloud dev opt-in —
   local stays quota-free and offline-capable.)
3. **Preview deployments** — `CIRRUS_DEPLOY_KEY=preview:…` in Vercel/Netlify/GH Actions
    - `cirrus deploy --cmd 'npm run build'` provisions a fresh TTL'd deployment named
      after the branch and injects the client URL env var into the frontend build.

---

## 3. What we already have vs build (repo-grounded)

**Reuse, mostly as-is** (per the repo inventory):

- **Deploy pipeline** — `packages/cli/src/commands/deploy/handler.ts` already does
  codegen → binding inference → reconcile → validate → deploy → `--migrate` via
  `/_cirrus/migrate`. The managed path replaces only step "invoke wrangler" with
  "upload bundle to deploy API"; everything before it is target-agnostic.
- **Binding inference + reconciliation** (`@cirrus/config`) — the inference result
  becomes the script-upload binding metadata; the placeholder-D1 footgun disappears
  entirely on the managed path (the platform creates the database).
- **Admin RPC layer** (`__cirrus_admin__:*`, ~28 functions; `packages/studio/src/admin.ts`,
  intercepted in `ShardDO.handleAdminRpc`) — this _is_ the per-deployment management
  API. The hosted dashboard talks to it through a control-plane proxy that adds org/
  project routing, ACLs, rate limits, and server-side audit.
- **Studio** (`packages/studio`, 16 panels) — becomes the hosted dashboard with a
  deployment-selector shell around it (Convex renders the _same_ full dashboard for
  prod/dev/preview deployments; so do we). `mountStudio({ baseUrl, adminToken })` is
  already the right seam.
- **Observability** — function metrics, correlated request log, health/insights panels
  are the differentiated "app-observation" features no generic PaaS has
  (`STUDIO-VS-CLOUDFLARE.md`'s "beat" column is the managed tier's selling point).

**Build new** (all wrapper/integration — no new runtime features required):

| Component                                                            | Effort |
| -------------------------------------------------------------------- | ------ |
| Control-plane service (orgs/projects/deployments/keys/audit)         | L      |
| Dispatcher Worker + namespace setup + subdomain/custom-host routing  | M      |
| Provisioning module over `cloudflare-typescript`                     | M      |
| CLI verbs: `login/logout/whoami`, `link`, `deploy` (managed target), |        |
| `logs`, `rollback`; device-flow auth (PartyKit model)                | M      |
| Hosted-studio multi-tenant shell (org/project/deployment selector)   | M      |
| Secrets vault + role-scoped token issuance                           | M      |
| Preview-deployment lifecycle (TTL cleanup, branch naming, `--cmd`)   | M      |
| Usage metering → billing (Analytics Engine + dispatch tags → Stripe) | L      |

---

## 4. Product / business shape

- **Open core, Convex-style split.** Everything that runs a _single_ deployment stays
  OSS exactly as today (runtime, DO, studio, CLI, BYO-account deploy). The multi-tenant
  control plane is the product. Decide the control-plane license deliberately (Convex
  uses FSL-1.1→Apache-2.0 to block competing hosts; our packages are currently
  permissive — the control plane likely lives in a separate repo).
- **Two deploy targets, one CLI** (PartyKit's cleanest idea): `cirrus deploy` →
  managed cloud when logged in / `CIRRUS_DEPLOY_KEY` present; → user's own CF account
  when `CLOUDFLARE_API_TOKEN`/wrangler auth is configured. BYO stays first-class and
  free forever — it is also the credible exit hatch that makes the managed tier easy
  to adopt.
- **Monetization levers** (Convex's, adapted): seats, usage overages (requests/CPU-ms
  map directly onto WfP's $0.30/M + $0.02/M cost basis), preview deployments +
  retention, log-stream integrations, custom domains, team size.
- **Platform cost floor:** WfP add-on $25/mo (20M req, 60M CPU-ms, 1k scripts incl.) +
  Workers Paid + Advanced Certificate Manager — negligible relative to the build cost;
  unit economics are well-defined from day one.

---

## 5. Phased roadmap

Ordered so every phase ships standalone DX value even if we stop there.

- **Phase 0 — Remote-binding dev (no cloud required).** Wire wrangler's remote-bindings
  proxy session into `@cirrus/vite` (`remote: true` per binding / `CIRRUS_REMOTE=1`).
  Closes the long-standing PLAN5-Phase-5 gap for BYO users and is a hard prerequisite
  for the cloud-dev story. _Independent; start immediately._
- **Phase 1 — Control-plane MVP + managed deploy.** Dispatch namespaces, dispatcher
  Worker, provisioning module, deploy API + NDJSON progress, `cirrus login/link/deploy`,
  `{project}.cirrus.app`, per-deployment secrets + scoped tokens. Exit criterion:
  `cirrus init && cirrus deploy` → live URL in under a minute with zero Cloudflare
  account, zero wrangler config, zero D1 placeholder editing.
- **Phase 2 — Preview + cloud dev deployments.** Deploy-key types, branch-named TTL'd
  previews with `--cmd` + URL injection (Vercel/Netlify/GH Actions recipes),
  per-developer dev deployments with push-on-save + log tail.
- **Phase 3 — Hosted studio.** Multi-tenant shell over `packages/studio`; admin-RPC
  proxy with ACL/audit/rate limits; team invites; guided secret setup.
- **Phase 4 — Domains, billing, ops.** Custom hostnames (CF for SaaS), usage metering →
  Stripe, rollback UI, log-stream egress (reuse `@cirrus/runtime` sinks: Axiom/Datadog/
  webhook), alerting.

---

## 6. Risks & open questions

1. **Cloudflare × void.** Cloudflare acquired VoidZero and may ship a first-party
   framework-deploy platform (parts of void going OSS). Mitigation: our moat is the
   reactive backend + app-observation studio, not generic deploys; watch what they
   open-source — it may become reusable substrate for Phase 1.
2. **Shard-DO remote dev** is genuinely hard (DO addressing + subscription path).
   Deliberately out of scope for Phase 0 (D1/KV/R2 only, shards local) — same cut void
   made. Revisit with DO facets.
3. **WebSockets + dispatch.** Validate early (Phase 1 spike) that the hibernated-WS
   subscription path and per-invocation limits behave correctly through
   `env.DISPATCHER.get()` — this is our hottest path and the least-documented WfP case.
4. **Untrusted-mode constraints** (no `request.cf`, isolated cache) — audit the runtime
   for any dependence.
5. **Migration handshake.** void's deploy-then-migrate-then-switch-traffic protocol
   needs an equivalent; today `--migrate` runs after traffic is live. Phase 1 can ship
   with today's semantics; the gate is a Phase 4 refinement.
6. **Control-plane repo + license** — decide before Phase 1 code exists.

---

## 7. Source index

Cloudflare: [WfP docs](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/) ·
[WfP pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) ·
[multipart metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/) ·
[remote bindings GA](https://developers.cloudflare.com/changelog/2025-09-16-remote-bindings-ga/) ·
[remote-bindings architecture](https://blog.cloudflare.com/connecting-to-production-the-architecture-of-remote-bindings/) ·
[DO facets / Dynamic Workers](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/) ·
[CF for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/).
Repos: [workers-for-platforms-example](https://github.com/cloudflare/workers-for-platforms-example) ·
[vibesdk](https://github.com/cloudflare/vibesdk) · [cloudflare-typescript](https://github.com/cloudflare/cloudflare-typescript) ·
[workers-sdk](https://github.com/cloudflare/workers-sdk) · [partykit/partykit](https://github.com/partykit/partykit) ·
[alchemy](https://github.com/sam-goodwin/alchemy) · [convex-backend](https://github.com/get-convex/convex-backend).
Convex: [dev workflow](https://docs.convex.dev/understanding/workflow) ·
[deploy CLI](https://docs.convex.dev/cli/reference/deploy) ·
[deploy keys](https://docs.convex.dev/cli/deploy-key-types) ·
[preview deployments](https://docs.convex.dev/production/hosting/preview-deployments) ·
[local deployments](https://docs.convex.dev/cli/local-deployments) ·
[management API](https://docs.convex.dev/management-api) ·
[self-hosting](https://docs.convex.dev/self-hosting) · [pricing](https://www.convex.dev/pricing).
void: `VOID-TEARDOWN.md` (this repo) · [void guide](https://void.cloud/guide/) ·
[VoidZero joins Cloudflare](https://voidzero.dev/posts/voidzero-cloudflare).
