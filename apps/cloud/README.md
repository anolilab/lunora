# @cirrus/cloud — Cirrus Cloud control plane

The managed-platform control plane from [`CLOUD-PLAN.md`](../../CLOUD-PLAN.md),
**dogfooded on Cirrus itself** — the platform's own metadata store is a Cirrus
app. This is the service that provisions and tracks tenant deployments on
Cloudflare Workers for Platforms; it is **not** a tenant worker.

> Status: **Phases 1–4 implemented as code**, verified by codegen, tsc, eslint,
> and unit tests; end-to-end runs need live Cloudflare and provider keys. In
> place: the data model, CRUD functions, org/deploy-key authorization, the deploy
> orchestration core (token bucket, per-cell scheduler, state machine) and the
> `POST /v1/deploy` streaming endpoint, a **real Cloudflare REST provisioner**
> (`src/cloudflare/api.ts` — D1/R2 create, dispatch-script upload, secrets), the
> dispatcher Worker with **per-plan runtime limits**, the hosted-studio React SPA
> (`src/client`), **billing on `@cirrus/payment`** (Stripe checkout/portal/webhook,
> entitlements, metering ingestion), and **hardened better-auth** (mail-backed
> verification/reset, optional OAuth, 2FA/passkeys, rate limiting). Still open
> (needs live infra/services): end-to-end deploy validation, the billing-provider
> charge wiring against a real Stripe account, cell bring-up IaC, custom domains,
> and the remaining "Forgotten must-haves" in `CLOUD-PLAN.md`.

## Layout

```
cirrus/
  schema.ts          control-plane data model (cells, organizations, members,
                     projects, deployments, deployKeys, auditLog, invitations,
                     platformUsage + the @cirrus/payment billing tables)
  authz.ts           assertMember (session) + authorizeDeployKey (CI) — the ACL gate
  cells.ts           list / register cells (CF accounts, §2.5)
  organizations.ts   create / list / getBySlug  (+ seeds owner member + audit)
  members.ts         list / add / remove (owner-admin gated)
  invitations.ts     invite / list / revoke / accept (team invites, §3)
  projects.ts        create / listByOrg
  deployments.ts     create / listByProject / updateStatus / cleanupExpiredPreviews
  deploy-keys.ts     issue / list / revoke / verify (SHA-256 hashed)
  billing.ts         checkout / portal / entitlements / subscription / webhook (§4)
  entitlements.ts    live quota resolution from synced subscription state (§4)
  secrets.ts         tenant env secrets: store / list / listEncrypted / remove (§7)
  usage.ts           platform metering: record / ingest / rollup (cron) / summary
  audit-log.ts       record + list (the studio Activity tab)
  fanout.ts          every-minute heartbeat that emits the tenant cron-tick trigger (§2.4)
  crons.ts           code-first crons (preview cleanup + usage rollup + cron-tick)
src/
  server.ts          control-plane Worker entry (D1 global tables + deploy router
                     + crons + better-auth `/api/auth/*` + studio identity; also the
                     tenant cron/queue fan-out scheduled()/queue() handlers, §2.4)
  client/            hosted studio — React SPA served alongside the Worker by @cirrus/vite
    main.tsx         CirrusProvider + StrictMode mount
    auth-client.ts   better-auth React client (relative /api/auth basePath)
    App.tsx          session gate → org picker → org dashboard
    Login.tsx        email/password sign-in + sign-up
    OrganizationList.tsx       list + create orgs (cell-scoped)
    OrganizationDashboard.tsx  per-org tabs (projects/members/keys/invites/usage)
    ProjectsSection.tsx        projects + create → DeploymentsSection
    DeploymentsSection.tsx     a project's deployments (read-only; live status)
    MembersSection.tsx         members + add/remove
    DeployKeysSection.tsx      issue (show-once) / revoke deploy keys
    InvitationsSection.tsx     invite via /v1/invitations/send (token emailed) / revoke
    SecretsSection.tsx         per-project tenant secrets (set via /v1/secrets) / delete
    UsageSection.tsx           current-month usage summary
    BillingSection.tsx         entitlements + subscriptions + checkout / portal
    ActivitySection.tsx        the org's audit log (who did what)
    AsyncList.tsx              loading/empty/populated helper for live lists
    styles.css                 studio styling
  provision.ts       @cirrus/provision seam over the Cloudflare REST port
  cloudflare/
    api.ts           Cloudflare REST port: D1/R2 create, dispatch-script upload, secrets
  secrets/
    crypto.ts        AES-256-GCM envelope encryption for tenant secrets (§7)
  metering/
    analytics.ts     Analytics Engine writer (dispatcher) + reader port (rollup, §4)
  fanout/
    cron.ts          tenant cron fan-out: cron-expression matching + due ticks (§2.4)
    queue.ts         tenant queue fan-out: group a shared-queue batch by tenant (§2.4)
  deploy/
    token-bucket.ts  per-cell API budget (CF 1,200/5min, §2.5)
    scheduler.ts     CellScheduler — paces provisioner work, priority + concurrency
    orchestrator.ts  runDeployment state machine (queued→provisioning→live/failed)
    keys.ts          deploy-key format / parse / hash helpers
    preview.ts       preview script-name + TTL helpers (§2.3)
    handler.ts       POST /v1/deploy handler (auth → orchestrate → stream NDJSON)
    client.ts        cirrus-deploy client (POST + consume NDJSON stream)
    router.ts        httpRouter: /v1/{deploy,github/webhook,billing/webhook,usage,
                     invitations/send,secrets,admin,tenants/plan} + per-IP rate limiting
  dispatcher/
    route.ts         hostname → tenant script (+ plan) resolution; cached plan resolver
    worker.ts        WfP dispatcher Worker — per-plan limits + per-request usage emit
  github/
    webhook.ts       GitHub webhook: HMAC verify + PR→preview-intent parse (§2.3)
  mail/
    notify.ts        transactional email (invitations) on @cirrus/mail
  billing/
    plans.ts         plans + quota entitlements + per-plan runtime limits (§4)
    usage.ts         pure usage roll-up (aggregateUsage)
  admin/
    proxy.ts         hosted-studio admin proxy to a tenant deployment (§3)
  cli/               cirrus login / link / deploy
spikes/
  ws-dispatch/       Phase 1 spike: hibernated-WS subscriptions + per-invocation
                     limits through env.DISPATCHER.get() (deploy + probe; see its README)
```

> **Moving to a private repo:** the control plane is the proprietary layer and is
> meant to live in its own repo. It imports only published `@cirrus/*` entry points
> (no monorepo-internal reaches), so extraction is mechanical — see
> [`EXTRACT.md`](./EXTRACT.md).

### Topology (provisional — a real decision flagged in the plan)

All control-plane tables are `.global()` (D1-backed): the plan's "Worker + D1"
control plane, with relational, cross-queried, low-volume metadata. Reads use the
per-table `findMany({ where })` facade. (Per-tenant _sharding_ in the plan refers
to the tenant apps' own ShardDOs, not the control plane's own bookkeeping.)

### Authorization (`cirrus/authz.ts`)

Two paths gate every org-scoped function:

- **User session** → `assertMember(ctx, orgId, roles?)` — dashboard callers must
  be members; closes the IDOR hole where any signed-in user could touch any org.
- **Deploy key** → `authorizeDeployKey(ctx, orgId, key, projectId?)` — CI/deploy
  callers have no session; a valid, unrevoked, org-matching key is the credential.

### The deploy API (`POST /v1/deploy`)

Mounted as the worker's `httpRouter` (lowest-priority matcher). Flow: read the
`Authorization: Bearer <deployKey>`, `deploy_keys:verify` it, `deployments:create`
a queued record, then drive `runDeployment` while streaming **NDJSON progress**
(`accepted` → `queued` → `provisioning` → `live`/`failed` → `done`), patching
status via `deployments:updateStatus` per phase. All Cloudflare work is paced by
the per-cell `CellScheduler`. The route reaches these mutations through the Cirrus
action context (`env.__cirrusCtx.runMutation`); they stay **public** (not
`internalMutation`) because that dispatch carries no system flag — an internal
function would 404 at the RPC visibility gate — so authorization is enforced
inside each mutation (deploy key or membership).

### The provisioning seam (`src/provision.ts`)

Per `CLOUD-PLAN.md` §2.2, the control plane's only coupling to the deploy
substrate lives behind the `Provisioner` interface. The shipped implementation
(`createCloudflareProvisioner`) talks to Cloudflare through the injected
`CloudflareApi` port (`src/cloudflare/api.ts`) over the **documented REST API**:
`deploy` provisions per-tenant D1/R2, uploads the user Worker into the dispatch
namespace with binding + DO-migration metadata, applies secrets, and returns the
content hash + routed URL; `destroy` removes the script. The port boundary keeps
orchestration unit-testable with a fake, and means an `alchemy@next`-backed
implementation could replace `createHttpCloudflareApi` later with no change above
this module. (What still needs a live account is end-to-end validation against
real Cloudflare — the wire calls themselves are implemented, not stubbed.)

### Billing & metering (`cirrus/billing.ts`, `src/billing/`, §4)

Billing rides `@cirrus/payment` with the **organization id as the payment
`referenceId`**. `src/server.ts` wires a Stripe adapter into `createShardDO({
payment })`, so the billing functions get `ctx.payments`: `checkout` / `portal`
(owner/admin actions that redirect to Stripe), `entitlements` / `subscription`
(member reads that resolve plan → features/limits through `CIRRUS_CLOUD_PLANS`,
falling back to the free baseline), and `processWebhook` (signature-verified,
mounted at `POST /v1/billing/webhook`). Entitlement reads work without Stripe
keys; only live calls need them.

**Quota is enforced against live subscription state**, not the static
`organizations.plan` column: `cirrus/entitlements.ts` resolves the org's
entitlements from its synced `subscriptions` (the single source of truth), and
`projects`/`members` creation call `assertWithinQuota` — so a Stripe upgrade
raises the limits immediately, with no column to keep in sync.

Platform **metering** is end-to-end: the dispatcher emits one Analytics Engine
data point per tenant request (`src/metering/analytics.ts`, the source) and
applies **per-plan runtime limits** (`limitsForPlan` → `env.DISPATCHER.get`,
resolved via the cached `GET /v1/tenants/plan` lookup). Events also land in the
`platformUsage` ledger via `usage.ingest` (`POST /v1/usage`, deploy-key auth);
an hourly `usage.rollup` cron compacts closed periods, and `usage.summary` reads
the total. The AE→ledger reader (`createHttpAnalyticsReader`) is the prod rollup
seam (runs at the edge with the account token).

### Tenant secrets (`cirrus/secrets.ts`, `src/secrets/crypto.ts`, §7)

Tenant env secrets are **AES-256-GCM encrypted at the edge** before storage:
`POST /v1/secrets` encrypts with the `SECRET_ENCRYPTION_KEY` master key, so the
control-plane D1 only ever holds ciphertext + a per-secret IV. `list` returns
names only; at deploy time the handler fetches `listEncrypted` and decrypts the
values into the tenant Worker's script secrets (alongside the platform-owned
`CIRRUS_ADMIN_TOKEN`). The plaintext never reaches a browser.

### Auth (`src/server.ts`, §3)

The hosted studio runs on hardened better-auth (`@cirrus/auth`): email/password
with **mail-backed verification + password reset** (`@cirrus/mail`, captured into
the studio Mail tab in dev), optional GitHub/Google OAuth (enabled only when the
env creds are present), the `admin` / `twoFactor` / `passkey` plugins, and
better-auth's built-in request rate limiting. The `/v1/*` control-plane surface
adds a per-IP `@cirrus/ratelimit` cap. Org membership stays the Cirrus
`organizations`/`members` model — the better-auth `organization` plugin is
deliberately omitted to avoid two parallel org models.

## Develop

```bash
pnpm install                         # from the repo root
pnpm --filter "@cirrus/cloud" run codegen     # generate cirrus/_generated/*
pnpm --filter "@cirrus/cloud" run lint:types  # codegen + tsc --noEmit
pnpm --filter "@cirrus/cloud" run test        # vitest
pnpm --filter "@cirrus/cloud" run build       # vite build (Worker + studio SPA)
pnpm --filter "@cirrus/cloud" run dev         # vite dev server (Worker + studio on one origin)
```

The hosted studio (`src/client`) and the control-plane Worker (`src/server.ts`)
are served together by `@cirrus/vite` on a single origin — the SPA talks to the
Worker's `/api/auth/*` (better-auth) and Cirrus query/mutation endpoints with no
cross-origin setup, mirroring how the playground app wires worker + client.

Copy `.dev.vars.example` → `.dev.vars` and fill `CIRRUS_ADMIN_TOKEN` and
`AUTH_SECRET` (the studio's better-auth session secret). Before a real deploy,
create the D1 database and replace the `database_id` placeholder in
`wrangler.jsonc`.

## Licensing

Marked `UNLICENSED` (not the framework's `FSL-1.1-Apache-2.0`): per
`CLOUD-PLAN.md` §4 the control plane is the proprietary product layer and will
likely move to a separate repo. Final license is an open decision.
