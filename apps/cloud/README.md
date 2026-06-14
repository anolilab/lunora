# @cirrus/cloud — Cirrus Cloud control plane

The managed-platform control plane from [`CLOUD-PLAN.md`](../../CLOUD-PLAN.md),
**dogfooded on Cirrus itself** — the platform's own metadata store is a Cirrus
app. This is the service that provisions and tracks tenant deployments on
Cloudflare Workers for Platforms; it is **not** a tenant worker.

> Status: **Phase 1, in progress.** In place: the data model, CRUD functions,
> org/deploy-key authorization, the deploy-orchestration core (token bucket +
> per-cell scheduler + state machine), and the `POST /v1/deploy` streaming
> endpoint. Still to come: the Alchemy-backed provisioner body (currently a
> rejecting stub — deploys terminate at `failed`), the dispatcher, billing, and
> the rest of the roadmap / "Forgotten must-haves" in `CLOUD-PLAN.md`.

## Layout

```
cirrus/
  schema.ts          control-plane data model (cells, organizations, members,
                     projects, deployments, deployKeys, auditLog, invitations)
  authz.ts           assertMember (session) + authorizeDeployKey (CI) — the ACL gate
  cells.ts           list / register cells (CF accounts, §2.5)
  organizations.ts   create / list / getBySlug  (+ seeds owner member + audit)
  members.ts         list / add / remove (owner-admin gated)
  invitations.ts     invite / list / revoke / accept (team invites, §3)
  projects.ts        create / listByOrg
  deployments.ts     create / listByProject / updateStatus / cleanupExpiredPreviews
  deploy-keys.ts     issue / list / revoke / verify (SHA-256 hashed)
  crons.ts           code-first crons (hourly preview cleanup)
src/
  server.ts          control-plane Worker entry (D1 global tables + deploy router
                     + crons + better-auth `/api/auth/*` + studio identity)
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
    InvitationsSection.tsx     invite (token shown once) / revoke
    UsageSection.tsx           current-month usage summary
    AsyncList.tsx              loading/empty/populated helper for live lists
    styles.css                 studio styling
  provision.ts       @cirrus/provision seam — the ONLY coupling to Alchemy v2
  deploy/
    token-bucket.ts  per-cell API budget (CF 1,200/5min, §2.5)
    scheduler.ts     CellScheduler — paces provisioner work, priority + concurrency
    orchestrator.ts  runDeployment state machine (queued→provisioning→live/failed)
    keys.ts          deploy-key format / parse / hash helpers
    preview.ts       preview script-name + TTL helpers (§2.3)
    handler.ts       POST /v1/deploy handler (auth → orchestrate → stream NDJSON)
    client.ts        cirrus-deploy client (POST + consume NDJSON stream)
    router.ts        httpRouter mount (/v1/deploy + /v1/github/webhook)
  github/
    webhook.ts       GitHub webhook: HMAC verify + PR→preview-intent parse (§2.3)
  billing/
    plans.ts         plans + quota entitlements on @cirrus/payment (§4)
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

Per `CLOUD-PLAN.md` §2.2, the control plane's only coupling to the provisioning
engine (Alchemy v2 / `alchemy@next`, Effect-based) lives behind the `Provisioner`
interface. It is currently a **stub that rejects loudly** — so a deploy today runs
the full pipeline and terminates at `failed` with a clear "not wired" message.
Wiring it over `alchemy@next` (and confirming v2 exposes the `DispatchNamespace`
resource + a control-plane-D1-backed state store) is the first Phase 1 spike
deliverable (risk #7).

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
