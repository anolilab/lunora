# Plan 166 — Enterprise auth: SAML SSO + SCIM

- **Category**: feat (competitive parity — gap #11 in `plans/README.md` Wave 14)
- **Priority**: P2
- **Effort**: M–L · **Risk**: MED (LOW for the OIDC-SSO + SCIM-Users half;
  MED–HIGH for SAML-on-workerd — see Phase 0)
- **Status**: **Phase 1a SHIPPED** (OIDC SSO + SCIM Users) — Phase 1b (SAML) and the
  real-IdP exit criterion still open. See "Progress" below.
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: make enterprise SSO and SCIM directory provisioning first-class in
  `@lunora/auth`, closing the enterprise-auth gap vs Supabase / Firebase Identity
  Platform / WorkOS-style offerings.

## Progress (2026-07-26, branch `feat/166-sso-scim`)

**A plan premise was wrong and is corrected here.** The plan split risk as "OIDC
edge-safe, SAML risky", but that split does not exist at the module level:
`@better-auth/sso`'s `dist/index.mjs` **statically** imports `samlify` (which
`require`s `fs`, `crypto`, `zlib`) and `node:crypto`'s `X509Certificate`. Configuring
only the OIDC mode still loads the whole SAML dependency tree, so the Phase-0 load
question gated _both_ halves, not just SAML.

That question is now answered **GO**: a worker importing and constructing both
plugins boots in real workerd. The standing proof is a gated workerd suite
(`LUNORA_WORKERD_TESTS=1`, mirroring the x402/do pattern) at
`packages/auth/__tests__/workerd/enterprise-auth.workerd.test.ts`.

Shipped:

- `@better-auth/scim` + `@better-auth/sso` at **exact 1.6.23**, joining the existing
  `catalog:auth` lockstep (both peer on `better-auth ^1.6.23`; a caret would float
  them to 1.6.24+, which the comment there explains breaks the expo client generics).
  No `minimumReleaseAgeExclude` entry needed — 1.6.23 predates the window.
- `sso` + `scim` on the curated server surface, `ssoClient` + `scimClient` on the
  client surface, each carrying the caveat that bit during implementation.
- Behaviour tests (`__tests__/enterprise-auth.behaviour.test.ts`, real better-auth
  against `memoryAdapter`, only the external IdP stubbed at the fetch boundary):
  `authTables` derivation, OIDC provider registration, **domain→provider
  resolution**, unknown-domain refusal, and SCIM `PUT`/`PATCH`/`DELETE` routing.
- Docs section covering setup plus three things that are not obvious:
  registration makes an **outbound discovery call**; `trustedOrigins` is an **SSRF
  gate** (public-routability first, then allowlist — `discovery_untrusted_origin`
  otherwise); and `scimProvider.scimToken` is **credential material at rest in D1**.

Verified against live code, replacing plan guesses:

- `authTables` auto-derives `ssoProvider` (issuer, oidcConfig, samlConfig, userId,
  providerId, organizationId, domain) and `scimProvider` (providerId, scimToken,
  organizationId) — the plan's claim holds.
- The dispatch chain passes SCIM's non-GET/POST verbs: `dispatchAuth`
  (`packages/runtime/src/create-worker.ts`) runs ahead of routing with no method
  gate, and `handleAuthRequest` hands the whole `Request` to `auth.handler`. Only the
  shared 1 MiB body cap applies.

Still open (do not read this plan as finished):

- **Phase 1b SAML.** Module loads; the ACS _code path_ (pure-JS RSA assertion verify)
  is unmeasured against a Worker CPU budget. Documented as unverified rather than
  half-wired, with better-auth#10343 / PR #10347 named as the sanctioned edge path.
- **Real-IdP exit criterion.** No Okta/Entra tenant was exercised — the IdP is
  stubbed at the fetch boundary. The token exchange and userinfo mapping are
  therefore unproven against a real provider.
- **`lunoraAuthAdapter` compat.** The behaviour tests run on `memoryAdapter`. The
  no-join CRUD adapter was _not_ driven against the sso/scim endpoints, so that
  Phase-0 item stands.
- **SSO identity → `ctx.auth`.** SSO sign-in issues a standard better-auth session,
  so session resolution needs no new code — but that path was not exercised
  end-to-end, so treat it as inherited-by-construction, not tested.
- **Phase 2 SCIM Groups.** Untouched; `@better-auth/scim` is Users-only.

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
- [x] **Workerd LOAD spike — GO.** `@better-auth/sso` + `@better-auth/scim` import
      and construct in real workerd (`nodejs_compat`), samlify tree and
      `X509Certificate` included. Standing suite:
      `packages/auth/__tests__/workerd/enterprise-auth.workerd.test.ts`.
- [ ] **Workerd SAML ACS spike (still blocking Phase 1b).** Run a real ACS verify
      (signed + encrypted assertion) and measure CPU ms — `node-rsa` is pure-JS RSA.
      Loading is proven; _executing_ the SAML path is not.
- [x] Track better-auth#10343 / PR #10347 (pluggable remote SAML executor) as the
      sanctioned edge path — named in both the `sso` re-export JSDoc and the docs
      page. Fallback if it stays unmerged: OIDC is the supported mode, which every
      major IdP offers, so the façade is only needed for SAML-only tenants.
- [x] `authTables` auto-picks up `ssoProvider` / `scimProvider` — asserted in
      `__tests__/enterprise-auth.behaviour.test.ts`.
- [ ] Adapter compat: the endpoints were driven against `memoryAdapter`, NOT
      `lunoraAuthAdapter`'s no-join CRUD. Still open.
- [x] Generated worker dispatch passes PUT/PATCH/DELETE: `dispatchAuth`
      (`runtime/src/create-worker.ts`) runs ahead of routing with no method gate and
      `handleAuthRequest` forwards the whole `Request`. Pinned by a test.

## Phase 1a — OIDC-based enterprise SSO + SCIM Users (LOW, do first)

- [x] Added to `catalog:auth` at **exact 1.6.23** (the catalog is exact-pinned, not
      caret); `ssoClient` + `scimClient` exported from `plugins-client.ts`.
- [x] `sso` (OIDC/OAuth2 mode) + `scim` wired into the curated plugin surface; D1
      tables auto-surface via `authTables`.
- [~] SSO identity → `ctx.auth`: inherited by construction (SSO sign-in issues a
  standard better-auth session, so session resolution is unchanged) but not
  exercised end-to-end. SCIM create/replace/patch/delete routing is tested;
  `active:false` deactivation needs the `admin` plugin, documented not tested.

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
- [x] SAML explicitly deferred with the remote-executor path documented — not
      silently half-wired (docs say OIDC is the supported mode).
- [x] Docs + tests over the schema derivation, the domain→provider map, and SCIM
      request routing. (A runnable example app is not included.)

## Non-goals

- Building SAML/SCIM from scratch — adapt better-auth, don't rebuild.
- Custom IdP admin UI (config via `.dev.vars` / dashboard is sufficient v1).
- Blocking the whole plan on SAML — ship the OIDC + SCIM-Users value first.
