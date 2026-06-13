# @cirrus/cloud — Cirrus Cloud control plane

The managed-platform control plane from [`CLOUD-PLAN.md`](../../CLOUD-PLAN.md),
**dogfooded on Cirrus itself** — the platform's own metadata store is a Cirrus
app. This is the service that provisions and tracks tenant deployments on
Cloudflare Workers for Platforms; it is **not** a tenant worker.

> Status: **Phase 1 scaffold.** Schema + core mutations/queries + the
> provisioning seam are in place; the deploy API, dispatcher, auth, billing,
> and the Alchemy-backed provisioner body are still to come (see the roadmap and
> "Forgotten must-haves" in `CLOUD-PLAN.md`).

## Layout

```
cirrus/
  schema.ts          control-plane data model (cells, organizations, members,
                     projects, deployments, deployKeys, auditLog)
  cells.ts           list / register cells (CF accounts, §2.5)
  organizations.ts   create / list / getBySlug  (+ seeds owner member)
  projects.ts        create / listByOrg
  deployments.ts     create (queued) / listByProject / updateStatus
src/
  server.ts          control-plane Worker entry (D1-backed global tables)
  provision.ts       @cirrus/provision seam — the ONLY coupling to Alchemy v2
```

### Topology (provisional — a real decision flagged in the plan)

- `cells`, `organizations` are `.global()` (D1-backed): fleet-wide, low volume,
  cross-org admin reads. They live in the control-plane D1 bound as `DB`.
- `members`, `projects`, `deployments`, `deployKeys`, `auditLog` are
  `.shardBy("organizationId")` — each org's control-plane state in its own
  shard, so "everything in org X" reads stay shard-local.

### The provisioning seam (`src/provision.ts`)

Per `CLOUD-PLAN.md` §2.2, the control plane's only coupling to the provisioning
engine (Alchemy v2 / `alchemy@next`, Effect-based) lives behind the `Provisioner`
interface. It is currently a **stub that rejects loudly** — wiring it over
`alchemy@next` (and confirming v2 exposes the `DispatchNamespace` resource + a
control-plane-D1-backed state store) is the first Phase 1 spike deliverable
(risk #7).

## Develop

```bash
pnpm install                         # from the repo root
pnpm --filter "@cirrus/cloud" run codegen     # generate cirrus/_generated/*
pnpm --filter "@cirrus/cloud" run lint:types  # codegen + tsc --noEmit
pnpm --filter "@cirrus/cloud" run test        # vitest
pnpm --filter "@cirrus/cloud" run dev         # local dev (cirrus dev)
```

Copy `.dev.vars.example` → `.dev.vars` and fill `CIRRUS_ADMIN_TOKEN`. Before a
real deploy, create the D1 database and replace the `database_id` placeholder in
`wrangler.jsonc`.

## Licensing

Marked `UNLICENSED` (not the framework's `FSL-1.1-Apache-2.0`): per
`CLOUD-PLAN.md` §4 the control plane is the proprietary product layer and will
likely move to a separate repo. Final license is an open decision.
