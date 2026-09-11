# {{name}}

A multi-tenant SaaS on Lunora, scaffolded with the kit already composed:
organizations, projects, an activity feed, and a platform admin view. Every
query is a live subscription, so a change in one tab lands in the others with no
reload.

```bash
pnpm install
pnpm run dev
```

## A tenant is a shard

`saas_projects` and `saas_activity` are `.shardBy("organizationId")`, so one
organization's data lives in one Durable Object. Isolation, per-tenant OCC and
per-tenant reactive fan-out follow from that line rather than from remembering a
`WHERE` clause.

Two pieces make it real, and both are in `lunora/server.ts`:

- **`resolveIdentity`** turns the better-auth session into the claim set declared
  in `lunora/identity.ts`. No function takes an `organizationId` argument — the
  tenant comes from the verified claim, because a client-supplied tenant id is a
  tenant-escape bug with a type annotation on it.
- **`authorizeShard`** is the boundary. A caller may enter their active
  organization's shard and the root shard, nothing else. Without it the model is
  decoration: the functions would read the right tenant while the transport
  still carried requests anywhere.

The one cross-tenant read — the admin's organization list — goes through
`saas_organizations`, a `.global()` projection served from D1, because a query
runs inside one shard and fanning out over every tenant per page view is a bill,
not a design.

## Before you deploy

1. **Create the D1 database** better-auth persists into, and put its id in
   `wrangler.jsonc`'s `DB` binding:

    ```bash
    wrangler d1 create {{name}}-db
    ```

2. **Set the auth secrets** — `BETTER_AUTH_SECRET` (32+ chars,
   `openssl rand -base64 32`) and `BETTER_AUTH_URL`. In dev they live in
   `.dev.vars`; in production use `wrangler secret put`.

3. **Enable the organization and admin plugins** in `lunora/auth/index.ts`. They
   own the records this app projects — users, organizations, members and
   invitations live in better-auth's own tables, and `saas_organizations` is a
   projection of them, never a second source of truth. Call
   `internal.saas.syncOrganization` when an organization is created, renamed or
   changes plan.

4. **Seed the admin** so it has something to show before you have customers:

    ```bash
    pnpm run seed
    ```

## Layout

| Path                    | What it is                                                           |
| ----------------------- | -------------------------------------------------------------------- |
| `lunora/schema.ts`      | Your tables, with the kit's merged in via `.extend(saas.extension)`  |
| `lunora/identity.ts`    | The claim contract — `userId`, `activeOrganizationId`, roles         |
| `lunora/saas/`          | The kit's queries and mutations                                      |
| `lunora/saas-ui/core/`  | The view model — framework-agnostic, imports no framework            |
| `lunora/saas-ui/react/` | The React components                                                 |
| `src/routes/`           | Your app. The routes own the subscriptions; the cards own the pixels |

Every file under `lunora/` is yours to edit; `lunora registry add` three-way
merges on upgrade rather than overwriting.

`projects` is a placeholder for whatever your product actually is. It is here so
the kit ships a working CRUD surface — table, form, optimistic write, live
update — rather than an empty shell.
