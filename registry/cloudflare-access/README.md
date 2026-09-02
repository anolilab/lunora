# cloudflare-access

Cloudflare Zero Trust identity for Lunora. Verifies the `Cf-Access-Jwt-Assertion` header from Cloudflare Access against your team's JWKS endpoint, and feeds the verified identity into `ctx.auth` via a `resolveIdentity` adapter. Ships with an admin gate for the Studio.

Built on [`@lunora/cloudflare-access`](../../packages/cloudflare-access) — the Cloudflare Access JWT verification and identity resolution library.

## Install

```bash
lunora registry add cloudflare-access
```

This:

1. Adds `@lunora/cloudflare-access` and `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/access/index.ts` (the `resolveIdentity` resolver) into your project — this is **yours** to edit.
3. Scaffolds `CF_ACCESS_TEAM_DOMAIN` into `.dev.vars`.

Then set your secrets and regenerate types:

```bash
echo "CF_ACCESS_AUD=your-aud-tag" | wrangler secret put CF_ACCESS_AUD
lunora codegen
```

## How it works

`lunora/access/index.ts` exports a `resolveIdentity` function built with `createAccessResolver` from `@lunora/cloudflare-access`:

```ts
export const resolveIdentity = createAccessResolver({
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN as string,
    aud: env.CF_ACCESS_AUD as string,
});
```

- **`teamDomain`** — your Cloudflare Access team domain, e.g. `"acme"` (which resolves to `acme.cloudflareaccess.com`). This is used to fetch the JWKS public key for JWT verification.
- **`aud`** — the Access Application AUD (audience) tag from the Zero Trust dashboard. This must match the `aud` claim in the JWT.
  There is no `isAdmin` option here: `createAccessResolver` resolves identity, it does not authorize the admin plane. That is a separate gate — see [Admin gate](#admin-gate) below.

Wire it into your Worker entry:

```ts
import { createWorker } from "#lunora/_generated/worker.js";
import { resolveIdentity } from "./lunora/access/index.js";

export default createWorker({
    resolveIdentity,
    // ...
});
```

### The JWT verification flow

1. Every request to your Worker includes a `Cf-Access-Jwt-Assertion` header (set by Cloudflare Access).
2. On each request, the resolver:
    - Fetches your team's JWKS from `https://<teamDomain>.cloudflareaccess.com/cdn-cgi/access/certs`.
    - Verifies the JWT signature, expiry, and `aud` claim.
    - Returns the verified identity (`{ userId, email, name, groups, ... }`).
3. Lunora feeds this into `ctx.auth` — available in every query, mutation, and action.

### Admin gate

Gating the Studio is a **separate, opt-in** wiring — this item does not scaffold it, so out of the box the admin bearer (`LUNORA_ADMIN_TOKEN`) remains the only way in. Build the gate with `accessAdminGate` from the `/admin` subpath and pass it as the worker's `adminGate`:

```ts
import { accessAdminGate } from "@lunora/cloudflare-access/admin";

export default createWorker({
    resolveIdentity,
    adminGate: accessAdminGate({
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN as string,
        aud: env.CF_ACCESS_ADMIN_AUD as string, // a dedicated Access app over /_lunora/admin
        isAdmin: (claims) => claims.groups?.includes("lunora-admins") ?? false,
    }),
    // ...
});
```

`isAdmin` is required — it is the entire boundary, so there is no implicit grant, and omitting it throws at wiring time. A member of the `lunora-admins` Access group can then reach the Studio's admin **HTTP** routes (`/_lunora/admin/*`, `/_lunora/migrate`) without the shared bearer. The Studio's live WebSocket views still need `LUNORA_ADMIN_TOKEN` configured: the gate does not cover `/_lunora/ws`, and the short-lived WS sub-token is signed with the admin token, so minting refuses without one.

## Environment variables

| Variable                | Secret | Description                                                   |
| ----------------------- | ------ | ------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN` | No     | Your Cloudflare Access team domain (e.g. `acme`).             |
| `CF_ACCESS_AUD`         | Yes    | The Access application AUD tag from the Zero Trust dashboard. |

`CF_ACCESS_TEAM_DOMAIN` is safe to put in `.dev.vars`. `CF_ACCESS_AUD` is sensitive (it's a proof of your application's identity) — set it via `wrangler secret put CF_ACCESS_AUD`.

## What you own

`lunora/access/index.ts` is copied into your repo — change the team domain, aud, admin logic, or add custom claim processing however you like. `@lunora/cloudflare-access` provides the JWT verification machinery; this component is the idiomatic Lunora glue that integrates it with `ctx.auth`.
