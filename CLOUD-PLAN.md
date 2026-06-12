# Cirrus Cloud — Managed Platform Plan

> Direction doc, 2026-06-12. Synthesized from four research passes: (1) a repo-grounded
> inventory of the control-plane primitives Cirrus already ships, (2) a teardown of
> Convex's managed cloud (the product model to copy), (3) a survey of Cloudflare
> primitives + OSS prior art for building a deploy platform on Cloudflare (the
> implementation substrate), and (4) a Supabase platform teardown (open-core
> packaging, branching/preview DX, and the platform-API growth model). Companion docs:
> `VOID-TEARDOWN.md` (DX reference), `CONVEX-PARITY.md` (feature parity),
> `STUDIO-VS-CLOUDFLARE.md` (dashboard boundary).

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

| Reference                                                                                               | What we take from it                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Convex Cloud**                                                                                        | The product model: teams → projects → three deployment classes (prod, **per-developer dev**, **TTL'd per-branch previews**); deploy-key types that encode the target (`prod` / `dev:…` / `preview:team:project`); `deploy --cmd` wrapping the frontend build + injecting the backend URL; a deliberately small management API.                                                                                                         |
| **void** (`VOID-TEARDOWN.md`)                                                                           | The DX bar: one-command deploy with NDJSON progress events, schema-drift gate, post-deploy migration handshake before traffic switch, rollback, remote-binding dev, `auth login/whoami/token` + `project link/list/logs/rollback` CLI verbs.                                                                                                                                                                                           |
| **PartyKit** ([partykit/partykit](https://github.com/partykit/partykit))                                | The deploy UX + the **managed-vs-BYO split**: build locally (esbuild facade injecting DO class exports — exactly our `ShardDO`/`SessionDO` shape), push the bundle to the platform API, get `{name}.{user}.partykit.dev`; setting `CLOUDFLARE_API_TOKEN` flips the same CLI to the customer's own account ("cloud-prem").                                                                                                              |
| **cloudflare/vibesdk** ([repo](https://github.com/cloudflare/vibesdk))                                  | The most complete open end-to-end reference of a control plane on WfP: dispatch namespace deploys, D1+Drizzle control-plane DB, R2/KV, wildcard subdomain routing. Study before writing ours.                                                                                                                                                                                                                                          |
| **workers-for-platforms-example** ([repo](https://github.com/cloudflare/workers-for-platforms-example)) | Minimal dispatcher skeleton (hostname → tenant → `env.DISPATCHER.get(script, …, { limits, outbound })`).                                                                                                                                                                                                                                                                                                                               |
| **Alchemy** ([sam-goodwin/alchemy](https://github.com/sam-goodwin/alchemy))                             | TS-native, embeddable IaC for CF resources (no wrangler dependency, runs inside a CLI) — candidate provisioning engine or design model for ours.                                                                                                                                                                                                                                                                                       |
| **Supabase**                                                                                            | The open-core cut line at fleet scale (every per-project service OSS; everything fleet-shaped — provisioning, branching, billing — proprietary); **one Studio codebase serving cloud + self-host behind an `IS_PLATFORM` flag**; Branching 2.0 preview-environment DX (per-Git-branch, Git-optional, PR comments/check runs); the Management API + OAuth-apps growth engine (>60% of new projects provisioned by AI builders via API). |

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
- **Public platform API (design for it, ship later).** Supabase's growth lesson: over
  60% of their new projects are now provisioned by third-party AI builders
  (Lovable/v0-style) through their Management API + OAuth apps (PKCE, scoped tokens),
  including the Vercel-Marketplace billed-through-partner model; Convex exposes the
  same surface (OAuth apps + embeddable dashboard). The internal deploy API above
  should be designed with token scopes/PATs so it can later be published as
  `api.cirrus.dev/v1` + OAuth apps without a rewrite — that is the channel through
  which app-builder platforms would put Cirrus backends under _their_ users' apps.

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
3. **Preview deployments** — `CIRRUS_DEPLOY_KEY=preview:…` plus
   `cirrus deploy --cmd 'npm run build'` in Vercel/Netlify/GH Actions provisions a
   fresh TTL'd deployment named after the branch and injects the client URL env var
   into the frontend build. Borrow Supabase Branching's refinements: a GitHub app
   posting PR comments + check runs; a "backend changes only" filter (only branch when
   `cirrus/` changes — their `supabase/`-dir filter); **persistent vs ephemeral**
   branches (staging vs per-PR); auto-delete on PR merge/close; dashboard-created
   branches with no Git required (Branching 2.0's lesson for the AI-builder audience).
   And fix their two worst pain points, which our substrate makes cheap: (a) Supabase
   previews start _empty_ (no data branching; users maintain 10k-line `seed.sql`) and
   cost $0.01344/h of dedicated compute each — ours are a dispatch-namespace script +
   fresh DO namespace/D1 with ~zero idle cost, and DO storage + D1 Time Travel make a
   **fork-production-data** option feasible; (b) their branch compute bills outside
   spend caps — preview usage must respect plan caps, no surprise bills.

### 2.4 Known WfP constraints to engineer around

Found while checking the substrate against what Cirrus actually ships, then verified
against the Cloudflare docs (2026-06-12; WfP reference/limits page, KV/D1/R2 limits
pages, WfP isolation + gotcha notes). These go into the Phase 1 spike checklist (§5):

- **Cron Triggers do not fire for namespaced user Workers** — `triggers.crons` is
  **silently dropped** on dispatch-namespace uploads. Note the official WfP limits
  page does not document this; the evidence is the API surface (the schedules
  subresource only exists for account-level scripts) plus
  [workers-sdk#13840](https://github.com/cloudflare/workers-sdk/issues/13840).
  Impact: `@cirrus/scheduler`'s cron entry point (`cronJobs()` → `scheduled()` handler).
  Mitigation is cheap because the heavy lifting already lives in `SchedulerDO` on **DO
  alarms, which work fine in namespaced Workers** (`runAfter`/`runAt` unaffected): the
  platform runs one account-level cron ticker Worker that fans tick events out through
  the dispatcher to each tenant's `scheduled()` path (tenants' cron specs are known to
  the control plane from codegen output).
- **No gradual deployments for user Workers** (the one limitation the official WfP
  limits page _does_ state): every upload deploys all-at-once to 100% of traffic.
  So the deploy API's `rollback` is platform-side — the control plane retains
  prior bundles (R2) and re-uploads; canary/percentage rollout, if ever offered,
  lives in the dispatcher's routing logic, not in Cloudflare versions.
- **Queue consumers (verify)** — namespaced Workers can hold producer bindings, but a
  queue _consumer_ is configured on an account-level Worker; assume tenant Workers
  cannot be consumers until proven otherwise. Impact: `@cirrus/mail`'s queue-backed
  sends and the scheduler's queue-workpool variant. Mitigation mirrors crons: a
  platform-owned consumer Worker that dispatches batches back into the tenant Worker,
  or fall back to the DO-alarm workpool on the managed tier.
- **Per-tenant resource provisioning hits account limits unevenly** (verified
  numbers) — D1: 50,000 databases/account on paid, **raisable by request to
  millions** (explicitly supported for per-tenant patterns); R2: 1,000,000
  buckets/account; **KV: 1,000 namespaces/account on _every_ plan**, so any
  per-tenant KV must multiplex one shared namespace via key prefixes. DO classes
  ship inside each tenant script — DO namespaces are unlimited under WfP.
- **Control-plane API throughput** — the Cloudflare client API allows **1,200
  requests / 5 min per account** (200/s per IP). Provisioning (D1 create + script
  upload + secrets) costs several calls per deployment, so deploy orchestration
  needs a queue with backoff — relevant once preview deployments multiply.
- **Outbound Worker trade-offs** — it intercepts only `fetch()` (not DO or mTLS
  binding calls), and enabling it **disables TCP `connect()`** in user Workers.
  Cirrus doesn't use raw TCP today; re-check before ever adopting a TCP-based driver.
- **Email sending binding (verify)** — `@cirrus/mail`'s default transport (Cloudflare
  Email Workers `send_email` binding) has unknown support inside dispatch namespaces;
  Resend (HTTP) works regardless and is the safe managed-tier default.
- **EU data residency** — Durable Objects support **jurisdiction restrictions**
  (`jurisdiction: "eu"` | `"fedramp"`) at ID-creation time and **R2 buckets support
  the same jurisdictions**; D1 only has _location hints_ (placement preference, not
  a residency guarantee). So an honest per-project "EU" toggle = DO jurisdiction +
  R2 jurisdiction, with D1 hinted-EU documented as best-effort. Cheap to expose
  early; a GDPR prerequisite for European customers later (Supabase's regionality
  is a real selling point we can partially match).

### 2.5 Scaling architecture: cells, not one account

How the platform scales with users without hitting account limits or risking a
platform-wide block. Four principles, in priority order:

1. **Keep tenant state inside the script, not in account-level resources.** This is
   Cirrus's structural advantage: primary state is DO SQLite, and DO namespaces are
   unlimited under WfP — a tenant's baseline footprint is _one script_, full stop.
   Account-level resources (D1, R2, queues) are provisioned **lazily and only when
   binding inference says the project actually uses that capability** (`.global()`
   tables → D1; storage import → R2). Most projects then consume zero scarce
   resources. KV is never provisioned per tenant (1,000-namespace cap) — one shared
   namespace per cell, key-prefixed.
2. **Cell architecture: shard the fleet across multiple Cloudflare accounts.** Every
   per-account ceiling (1,200 API req/5 min, 50k D1 default, KV cap, WfP billing
   blast radius) becomes per-cell capacity. A **cell** = one CF account + its
   dispatch namespaces + shared KV/queues; the control plane assigns each org to a
   cell at creation (org→cell in the control-plane D1) and addresses everything as
   `{cell, namespace, script}`. Start with one cell, but bake the cell ID into every
   identifier from day one — retrofitting multi-account onto a single-account design
   is the expensive mistake. Cells also bound blast radius: an account-level
   suspension or limit incident hits one cell, not the platform. This is the
   **sanctioned** path — Cloudflare's own Tenant docs recommend creating separate
   accounts per customer segment "to avoid getting rate limited."
3. **All Cloudflare API traffic goes through a per-cell scheduler.** A DO-based
   token-bucket (≤1,200/5 min per cell) that queues provisioning + deploy calls with
   backoff and priority (interactive deploy > preview > cleanup). Deploys are
   artifact-first: bundle to R2 once, then the scheduler performs the upload calls —
   a CI stampede degrades to queued-but-ordered, never to dropped API calls.
4. **A graduation ladder instead of one-size tenancy.**
   free/hobby → shared cells; growth → dedicated namespace, then **dedicated cell**
   (their own CF account operated by our control plane — also unlocks true
   per-tenant Enterprise features); whales/regulated → **managed-BYO**: the same
   control plane drives the customer's _own_ CF account via a scoped API token
   (PartyKit's cloud-prem, kept managed). At fleet scale, a Cloudflare **partner
   agreement + Tenant API** lets the control plane create accounts programmatically
   under our umbrella, making "cell per big customer" fully automatic.

**Not getting blocked** is mostly about staying inside sanctioned products and
keeping tenant abuse from looking like platform abuse: WfP untrusted mode + per-plan
`limits` on every dispatch + outbound-Worker egress policy contain each tenant;
signup throttling and payment-gated resource tiers slow farm abuse; the 8-tag
lifecycle (`org/project/env/plan`) gives a one-call kill switch + bulk delete for a
bad tenant; CF for SaaS handles customer domains (never proxy hacks). And establish
the relationship early — D1's "millions of databases by request", WfP itself, and
the Tenant API all assume you _talk to Cloudflare_; an Enterprise/partner agreement
with a named contact is the real insurance against surprise enforcement.

| Ceiling (verified §2.4)   | Strategy                                                     |
| ------------------------- | ------------------------------------------------------------ |
| 1,200 API req/5 min/acct  | per-cell scheduler + artifact-first deploys + more cells     |
| KV 1,000 namespaces/acct  | never per-tenant; shared per-cell namespace, key prefixes    |
| D1 50k databases/acct     | lazy provisioning + raisable to millions + per-cell anyway   |
| 1,000 scripts incl. (WfP) | cost not cap ($0.02/script); TTL cleanup of previews/dev     |
| Queues 10k/acct           | platform-owned queues + consumers, tenant-enveloped messages |
| Per-DO throughput         | already Cirrus's domain: `.shardBy()` fans tenants' load out |

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
  already the right seam. Adopt Supabase's single-codebase pattern: their cloud
  dashboard and self-host Studio are literally the same app gated by an `IS_PLATFORM`
  flag (platform-only panels — orgs, branching, billing — simply don't render
  self-hosted). One studio, two skins; big trust signal, low maintenance.
- **Advisors** (`@cirrus/advisor`) — already mirrors Supabase's splinter model (OSS
  rule pack rendered in the dashboard). Their gap worth closing from day one: expose
  advisor results via CLI/CI (and later the platform API/MCP) — Supabase users are
  still asking for this.
- **Observability** — function metrics, correlated request log, health/insights panels
  are the differentiated "app-observation" features no generic PaaS has
  (`STUDIO-VS-CLOUDFLARE.md`'s "beat" column is the managed tier's selling point).
  The platform side composes cleanly: enabling Workers Logs / a Tail Worker / Logpush
  on the dispatcher covers **every user Worker in the namespace automatically**, and
  Workers Analytics Engine aggregates per tenant by script tag — so hosted-tier log
  search and usage metering ride Cloudflare primitives, not custom pipelines (and the
  `analyticsEngineSink` from `CLOUDFLARE-REUSE-AUDIT.md` is already shipped).

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

- **Open core, Convex/Supabase-style split.** Everything that runs a _single_
  deployment stays OSS exactly as today (runtime, DO, studio, CLI, advisor rules,
  BYO-account deploy). The multi-tenant control plane is the product. Supabase draws
  exactly this line (every per-project service is OSS; provisioning/branching/billing/
  fleet are closed, with portability via standard tooling rather than an open control
  plane) and it demonstrably converts. Decide the control-plane license deliberately
  (Convex uses FSL-1.1→Apache-2.0 to block competing hosts; our packages are currently
  permissive — the control plane likely lives in a separate repo).
- **Two deploy targets, one CLI** (PartyKit's cleanest idea): `cirrus deploy` →
  managed cloud when logged in / `CIRRUS_DEPLOY_KEY` present; → user's own CF account
  when `CLOUDFLARE_API_TOKEN`/wrangler auth is configured. BYO stays first-class and
  free forever — it is also the credible exit hatch that makes the managed tier easy
  to adopt.
- **Make the exit hatch a feature: `cirrus eject`.** The pieces already exist —
  `exportShard`/`importShard` admin RPCs + the studio Export/Import panel for data,
  and the BYO deploy path for code. One command that exports all shards + D1 + R2,
  scaffolds the `wrangler.jsonc` the project would have had on BYO, and imports into
  the user's own CF account turns "no lock-in" from a promise into a demo (Supabase
  earns portability trust via `pg_dump`; ours can be first-party and complete).
- **Monetization levers** (Convex's, adapted): seats, usage overages (requests/CPU-ms
  map directly onto WfP's $0.30/M + $0.02/M cost basis), preview deployments +
  retention, log-stream integrations, custom domains, team size.
- **Platform cost floor:** WfP add-on $25/mo (20M req, 60M CPU-ms, 1k scripts incl.) +
  Workers Paid + Advanced Certificate Manager — negligible relative to the build cost;
  unit economics are well-defined from day one.
- **Structural cost advantage over Supabase — market it.** Supabase's
  dedicated-VM-per-project isolation forces their most-hated behaviors: free projects
  **pause after 1 week** of inactivity, provisioning takes minutes, and every preview
  branch burns $0.01344/h. A Cirrus project/preview is a script in a dispatch
  namespace + DOs that scale to zero natively — near-zero idle cost, sub-second
  creation. "Free projects never pause; previews are free until used" is a direct,
  truthful jab at both Supabase (pausing) and Convex (dev usage burning plan quota).

---

## 5. Phased roadmap

Ordered so every phase ships standalone DX value even if we stop there.

- **Phase 0 — Remote-binding dev (no cloud required).** Wire wrangler's remote-bindings
  proxy session into `@cirrus/vite` (`remote: true` per binding / `CIRRUS_REMOTE=1`).
  Closes the long-standing PLAN5-Phase-5 gap for BYO users and is a hard prerequisite
  for the cloud-dev story. _Independent; start immediately._
- **Phase 1 — Control-plane MVP + managed deploy.** Starts with a **constraint
  spike** that proves the substrate on a real Cirrus app before any control-plane
  code: hibernated-WS subscriptions through `env.DISPATCHER.get()`, the cron
  fan-out workaround, queue-consumer behavior, the mail `send_email` binding, and an
  untrusted-mode audit (`request.cf`, cache isolation) — §2.4 + risks 2–4. Then:
  dispatch namespaces, dispatcher Worker, provisioning module, deploy API + NDJSON
  progress, `cirrus login/link/deploy`, `{project}.cirrus.app`, per-deployment
  secrets + scoped tokens. Exit criterion: `cirrus init && cirrus deploy` → live URL
  in under a minute with zero Cloudflare account, zero wrangler config, zero D1
  placeholder editing.
- **Phase 2 — Preview + cloud dev deployments.** Deploy-key types, branch-named TTL'd
  previews with `--cmd` + URL injection (Vercel/Netlify/GH Actions recipes), GitHub
  app (PR comments/check runs, `cirrus/`-only filter, auto-delete on merge/close),
  persistent branches, per-developer dev deployments with push-on-save + log tail.
  Stretch (differentiator): fork-production-data previews via DO storage snapshot +
  D1 Time Travel — needs a spike; neither Supabase nor Convex offers it.
- **Phase 3 — Hosted studio.** Multi-tenant shell over `packages/studio`; admin-RPC
  proxy with ACL/audit/rate limits; team invites; guided secret setup.
- **Phase 4 — Domains, billing, ops.** Custom hostnames (CF for SaaS), usage metering →
  Stripe, rollback UI, log-stream egress (reuse `@cirrus/runtime` sinks: Axiom/Datadog/
  webhook), alerting (deploy status, error spikes, quota warnings), **managed
  backups/PITR as a paid feature** (the self-managing PITR loop + D1 Time Travel
  already exist; the platform adds scheduling, retention tiers, and off-account R2
  snapshot copies), abuse controls (per-tenant rate limits at the dispatcher, egress
  policy via the outbound Worker, signup throttling).

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
[CF for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) ·
[WfP observability](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/) ·
[WfP limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/) ·
[KV limits](https://developers.cloudflare.com/kv/platform/limits/) ·
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ·
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/) ·
[API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) ·
[crons dropped in dispatch namespaces (workers-sdk#13840)](https://github.com/cloudflare/workers-sdk/issues/13840).
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
Supabase: [architecture](https://supabase.com/docs/guides/getting-started/architecture) ·
[features matrix (cloud vs self-host)](https://supabase.com/docs/guides/getting-started/features) ·
[Branching 2.0](https://supabase.com/blog/branching-2-0) ·
[branching docs](https://supabase.com/docs/guides/deployment/branching) ·
[branching usage/billing](https://supabase.com/docs/guides/platform/manage-your-usage/branching) ·
[Management API](https://supabase.com/docs/reference/api/introduction) ·
[OAuth integrations](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration) ·
[Vercel Marketplace](https://supabase.com/docs/guides/integrations/vercel-marketplace) ·
[splinter (advisors)](https://github.com/supabase/splinter) ·
[Pulumi case study (fleet orchestration)](https://www.pulumi.com/case-studies/supabase/) ·
[pricing](https://supabase.com/pricing).
void: `VOID-TEARDOWN.md` (this repo) · [void guide](https://void.cloud/guide/) ·
[VoidZero joins Cloudflare](https://voidzero.dev/posts/voidzero-cloudflare).
