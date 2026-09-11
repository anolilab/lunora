# SaaS kit — tenancy, activity, admin projection

The framework-independent backend of the Lunora SaaS kit. It is the half of the
kit that does not care what renders it: `lunora/` is identical across every
template, so this one item serves the React, Vue, Svelte, Solid, Angular and
React Native shells alike.

```bash
lunora registry add saas
```

## What it installs

| File                    | What it is                                                                    |
| ----------------------- | ----------------------------------------------------------------------------- |
| `lunora/identity.ts`    | The `defineIdentity` claim contract — `userId`, `activeOrganizationId`, roles |
| `lunora/saas/schema.ts` | The schema extension — `saas_projects`, `saas_activity`, `saas_organizations` |
| `lunora/saas/index.ts`  | The dashboard and admin functions                                             |

Every file is yours to edit; upgrades are three-way merged.

## A tenant is a shard

`projects` and `activity` are `.shardBy("organizationId")`, so one organisation's
data lives in one Durable Object. Isolation, per-tenant OCC and per-tenant
reactive fan-out follow from that rather than from discipline — there is no
`WHERE organizationId = ?` to forget, because the shard key _is_ the tenant.

The cost is explicit: a query runs inside one shard, so nothing can list across
organisations. That is what `saas_organizations` is for — a `.global()` (D1)
projection serving the two reads a shard cannot:

1. the admin's cross-organisation lists, which would otherwise fan out over every
   shard on every page view;
2. resolving an organisation _before_ you know its shard — slug lookups, the org
   switcher, seat counts on a billing page.

It is a projection, never a source of truth. Users, organisations, members and
invitations live in better-auth's D1 tables, which are not Lunora tables and
cannot be read through `ctx.db`. `internal.saas.syncOrganization` keeps the two
in step; when they disagree, better-auth wins.

## The tenant comes from the identity, never from an argument

No function here takes an `organizationId`. They read
`ctx.auth.activeOrganizationId`, which is declared in `lunora/identity.ts` and
validated at the runtime trust boundary before it becomes `ctx.auth`. A
client-supplied tenant id is a tenant-escape bug with a type annotation on it.

That is also why the contract sets `onInvalid: "reject"`: a malformed claim set
fails closed with a 401 instead of silently downgrading to anonymous, which in a
multi-tenant app would turn "your credential is broken" into "you have no
organisation" — a bug that reads as data loss.

## Wiring

1. **Re-export the functions** from your `lunora/` entry so codegen emits
   `api.saas.*`.
2. **Resolve the identity** in your Worker's `createWorker(...)` call. The
   snippet is in `lunora/identity.ts`; without it, every org-scoped function
   fails closed with `FAILED_PRECONDITION`.
3. **Enable better-auth's `organization()` and `admin()` plugins** in
   `lunora/auth/index.ts` — they own the records this item projects.
4. **Call `internal.saas.syncOrganization`** after an organisation is created,
   renamed or changes plan, so the admin projection stays current.

## Functions

| Function                         | Kind               | Scope                                  |
| -------------------------------- | ------------------ | -------------------------------------- |
| `saas.overview`                  | `query` (live)     | The tenant's projects + activity tail  |
| `saas.listProjects`              | `query` (live)     | The tenant's projects                  |
| `saas.listActivity`              | `query` (live)     | The tenant's activity feed             |
| `saas.createProject`             | `mutation`         | Writer roles (`admin`, `owner`)        |
| `saas.archiveProject`            | `mutation`         | Writer roles                           |
| `saas.listOrganizations`         | `query` (live)     | Platform admins — reads the projection |
| `internal.saas.syncOrganization` | `internalMutation` | Server only                            |

Every query is a subscription: create a project in one tab and the other tabs'
project lists and activity feeds update without a reload. That is the part no
other SaaS starter kit ships.

`projects` is a placeholder for whatever your product actually is. It exists so
the kit ships a working CRUD surface — table, form, optimistic write, live
update — rather than an empty shell.
