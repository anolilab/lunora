# Plan 166 — Enterprise auth: SAML SSO + SCIM

- **Category**: feat (competitive parity — gap #11 in `plans/README.md` Wave 14)
- **Priority**: P2
- **Effort**: M–L · **Risk**: MED (LOW for the OIDC-SSO + SCIM-Users half;
  MED–HIGH for SAML-on-workerd — see Phase 0)
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: make enterprise SSO and SCIM directory provisioning first-class in
  `@lunora/auth`, closing the enterprise-auth gap vs Supabase / Firebase Identity
  Platform / WorkOS-style offerings.

> **Risk correction (Fable 5 deep-analysis, 2026-07-21).** The original "LOW —
> mostly wiring" rating only holds for the **OIDC-based SSO + SCIM-Users** path.
> **SAML on Cloudflare Workers is the risk**: better-auth's SAML support pulls in
> `samlify` → `xml-crypto` / `node-rsa` (pure-JS RSA) / `@xmldom/xmldom`, and
> upstream better-auth#10343 (open, 2026-07-09) states SAML ACS "is a poor fit
> for Worker CPU budgets and Node-only dependencies," with a pluggable remote
> executor proposed in unmerged PR #10347. Treat SAML-on-workerd as unproven
> until the Phase-0 spike says otherwise.

## Context (verified — code + upstream)

`@lunora/auth` is a thin pass-through to `betterAuth(resolveAuthOptions(options))`
(`create-auth.ts`); `options.plugins` forwards verbatim, `plugins.ts` /
`plugins-client.ts` are one-line-per-plugin curated re-exports (`oidcProvider`
already exported), `schema.ts` auto-derives D1 tables from any plugin via
`getAuthTables`, `migrate.ts` uses better-auth's own diffing, and `handler.ts`
prefix-routes `/api/auth/*` method-agnostically — so adding a plugin is genuinely
low wiring on the D1/OIDC side. Grep for `saml|scim|sso` over `packages/auth/src`
returns **zero** hits today.

The plugins exist and are first-party MIT, version-locked to the repo's pinned
`better-auth ^1.6.23`:

- **`@better-auth/sso` v1.6.23** — OIDC + OAuth2 + SAML 2.0, SP metadata + ACS,
  SP/IdP-initiated, `provisionUser` + `organizationProvisioning` hooks. SAML path
  depends on `samlify` (the workerd risk above); OIDC path is edge-safe.
- **`@better-auth/scim` v1.6.23** — SCIM 2.0 **server**, **Users only** (no
  `/Groups`), zod-only (edge-safe); `active:false` deactivation requires the
  `admin` plugin, org scoping requires the `organization` plugin.

One code caveat: `lunoraAuthAdapter` (`adapter.ts`) is single-table CRUD and does
**not** handle better-auth's relational `join` reads — must be validated against
the sso/scim endpoints.

## Phase 0 — De-risk SAML-on-workerd (blocking spike)

The plugin-availability question is answered (above). What's left is the real
unknown:

- [x] Confirm plugins + licensing + edge-safety of the non-SAML path.
      _Done 2026-07-21 (Fable 5): `@better-auth/sso` + `@better-auth/scim`, MIT,
      v1.6.23; OIDC/SCIM edge-safe, SAML is the risk._
- [ ] **Workerd SAML spike (blocking).** Import `@better-auth/sso`, run a SAML ACS
      verify under `wrangler dev` with `nodejs_compat` (signed + encrypted
      assertion), measure CPU ms (`node-rsa` is pure-JS RSA). GO/NO-GO on
      SAML-on-workerd.
- [ ] Track better-auth#10343 / PR #10347 (pluggable remote SAML executor) as the
      sanctioned edge path; decide the fallback (OIDC façade in front of the IdP)
      if it stays unmerged.
- [ ] Adapter compat: run sso/scim endpoints against `lunoraAuthAdapter`'s no-join
      CRUD; confirm `authTables` auto-picks up `ssoProvider` / `scimProvider`.
- [ ] Confirm the generated worker dispatch passes PUT/PATCH/DELETE through
      `handleAuthRequest` (SCIM requires them).

## Phase 1a — OIDC-based enterprise SSO + SCIM Users (LOW, do first)

- [ ] Add `@better-auth/sso` + `@better-auth/scim` to `catalog:auth` (lockstep with
      `better-auth ^1.6.23`); export `ssoClient` in `plugins-client.ts`.
- [ ] Wire `sso` (OIDC/OAuth2 mode) + `scim` into the curated plugin surface;
      D1 tables auto-surface via `authTables`.
- [ ] Map SSO identity → `ctx.auth` used by RLS; SCIM create/replace/patch/delete + `active:false` deactivation (with the `admin` plugin) → identity lifecycle.

## Phase 1b — SAML (gated on the Phase-0 GO)

- [ ] Only if the workerd spike is GREEN (or via the remote-executor path): enable
      the SAML mode, SP metadata + ACS through `handler.ts`, assertion → `ctx.auth`.

## Phase 2 — SCIM Groups → roles (rescoped)

- [ ] `@better-auth/scim` is **Users-only** — Group sync is custom work. Either
      build `/Groups` → org membership/role mapping on top (requires the
      `organization` plugin) or **defer**; document the admin+organization
      prerequisites.

## Exit criteria

- [ ] OIDC-SSO login + SCIM Users provisioning work end-to-end against a real IdP
      (Okta/Entra test tenant).
- [ ] SAML either works on workerd (spike GREEN) or is explicitly deferred with the
      remote-executor path documented — not silently half-wired.
- [ ] Docs + example; tests over the identity map and SCIM lifecycle.

## Non-goals

- Building SAML/SCIM from scratch — adapt better-auth, don't rebuild.
- Custom IdP admin UI (config via `.dev.vars` / dashboard is sufficient v1).
- Blocking the whole plan on SAML — ship the OIDC + SCIM-Users value first.
