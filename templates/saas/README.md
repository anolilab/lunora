# {{name}}

A multi-tenant SaaS on Lunora, scaffolded with the kit already composed:
organizations, projects, an activity feed, and a platform admin view. Every
query is a live subscription, so a change in one tab lands in the others with no
reload.

## Quickstart

```bash
pnpm install
cp .dev.vars.example .dev.vars   # then set BETTER_AUTH_SECRET: openssl rand -base64 32
pnpm exec lunora add auth-ui     # the sign-in, sign-up and organization screens
pnpm run dev
```

`BETTER_AUTH_SECRET` is the one value the app cannot start without. Billing
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) is optional until you use it:
without the keys every other function works, and checkout or the billing portal
fails with "payments are not configured".

**The auth screens.** The template ships the auth _server_ (better-auth with the
`organization()` and `admin()` plugins, served at `/api/auth/*`) but not the
screens: `lunora add auth-ui` copies them into `lunora/auth-ui/`, and they are
yours to restyle. Mount them on the `/auth/*` path the landing page links to, in
`src/routes/auth.$view.tsx`:

```tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { authClient } from "../../lunora/auth-ui/client";
import { AuthUIProvider, AuthView, OrganizationsCard } from "../../lunora/auth-ui/react";

import "../../lunora/auth-ui/styles.css";

export const Route = createFileRoute("/auth/$view")({
    component: AuthPage,
});

function AuthPage() {
    const { view } = Route.useParams();
    const navigate = useNavigate();

    return (
        <AuthUIProvider
            authClient={authClient}
            nav={{ navigate: (to) => navigate({ to }), replace: (to) => navigate({ replace: true, to }) }}
            redirects={{ afterSignIn: "/auth/organizations" }}
            viewPaths={{ base: "/auth" }}
        >
            {view === "organizations" ? <OrganizationsCard /> : <AuthView view={view} />}
        </AuthUIProvider>
    );
}
```

Sign up (in dev the verification link is printed to the terminal until you run
`lunora add email`), create an organization, and open `/dashboard`.

## A tenant is a shard

`saas_projects` and `saas_activity` are `.shardBy("organizationId")`, so one
organization's data lives in one Durable Object. Isolation, per-tenant OCC and
per-tenant reactive fan-out follow from that line rather than from remembering a
`WHERE` clause.

Three pieces make it real:

- **`resolveIdentity`** (`lunora/server.ts`) turns the better-auth session and
  the caller's `member` row into the claim set declared in `lunora/identity.ts`.
  No function takes an `organizationId` argument — the tenant comes from the
  verified claim, because a client-supplied tenant id is a tenant-escape bug
  with a type annotation on it.
- **The client names the shard.** The routes read `api.saas.me` on the root
  shard and pass `{ shardKey: organizationId }` on every org-scoped call — see
  `src/routes/dashboard.tsx`. Without it every tenant would land in `__root__`.
- **`authorizeShard`** (`lunora/server.ts`) is the boundary. A caller may enter
  their active organization's shard and the root shard, nothing else, so the
  shard key a client sends cannot be someone else's.

The one cross-tenant read — the admin's organization list — goes through
`saas_organizations`, a `.global()` projection served from D1, because a query
runs inside one shard and fanning out over every tenant per page view is a bill,
not a design. better-auth's organization hooks in `lunora/auth/index.ts` keep it
current as organizations are created, renamed, deleted and gain or lose members.

Billing is the deliberate exception: a provider webhook arrives with no tenant
to route by, so the payment tables live on the root shard and carry the
organization in `referenceId`. The plan catalog is `lunora/plans.ts`, read by
both the pricing page and the server's entitlements.

## Before you deploy

1. **Create the D1 database** better-auth persists into, and put its id in
   `wrangler.jsonc`'s `DB` binding:

    ```bash
    wrangler d1 create {{name}}-db
    ```

2. **Set the secrets** with `wrangler secret put`: `BETTER_AUTH_SECRET`, and for
   billing `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Point the Stripe
   webhook at `https://<your-domain>/payment/webhook`.

3. **Set `APP_BASE_URL`** to this deployment's public origin. It builds the
   checkout return URLs, and a Lunora context carries no `Request` to derive an
   origin from, so it has to be configured rather than inferred.
   `wrangler.jsonc` ships it empty on purpose — that key is deployed
   configuration, so a committed localhost value would be read in production,
   where `checkout` would hand the payment provider a `success_url` on the
   customer's own machine. For local dev it lives in `.dev.vars`, which wins
   over `wrangler.jsonc` under `wrangler dev`.

4. **Replace the `price_*` ids** in `lunora/plans.ts` with your Stripe prices.

Users, organizations, members and invitations live in better-auth's own tables;
`saas_organizations` is a projection of them, never a second source of truth.

## Layout

| Path                    | What it is                                                           |
| ----------------------- | -------------------------------------------------------------------- |
| `lunora/server.ts`      | The worker: auth, identity, the shard gate, payments, HTTP routes    |
| `lunora/schema.ts`      | Your tables, with the kit's merged in via `.extend(saas.extension)`  |
| `lunora/identity.ts`    | The claim contract — `userId`, `activeOrganizationId`, roles         |
| `lunora/plans.ts`       | The plan catalog — pricing page and entitlements both read it        |
| `lunora/saas/`          | The kit's queries and mutations                                      |
| `lunora/saas-ui/core/`  | The view model — framework-agnostic, imports no framework            |
| `lunora/saas-ui/react/` | The React components                                                 |
| `src/routes/`           | Your app. The routes own the subscriptions; the cards own the pixels |

Every file under `lunora/` is yours to edit; `lunora registry add` three-way
merges on upgrade rather than overwriting.

`projects` is a placeholder for whatever your product actually is. It is here so
the kit ships a working CRUD surface — table, form, optimistic write, live
update — rather than an empty shell.
