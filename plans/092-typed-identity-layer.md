# Plan 092: Generic typed identity layer — declared claim contract + resolver composition

> **Executor instructions**: This plan has three phases. **Phase 1 and Phase 2
> are implementation plans** (executor-ready). **Phase 3 is an optional spike**
> (the old better-auth-plugin-introspection idea, now demoted to convenience
> sugar). Do Phase 1, then Phase 2; do Phase 3 only if someone asks for it. On
> any STOP condition, stop and report. Update the `plans/README.md` row when done.
>
> **Numbering note**: the `auth_session_read_without_cache` lint is the
> "Follow-on 094" section at the end of this file (not a separate file).
>
> **Drift check (run first)**: `git diff --stat c490bad..HEAD -- packages/server/src/types.ts packages/runtime/src/create-worker.ts packages/codegen/src/emit.ts packages/server/src/schema.ts`
> If any changed, re-verify the "Current state" excerpts before proceeding.

## Status

- **Priority**: P2
- **Effort**: L (Phase 1+2) · XL if Phase 3 is attempted
- **Risk**: MEDIUM (Phase 1+2 are declared, not inferred — the old HIGH-risk
  introspection is now optional Phase 3)
- **Depends on**: none (unblocks the `.shardBy(ctx => ctx.auth.identity.*)` follow-up)
- **Category**: dx / codegen / auth
- **Planned at**: commit `c490bad`, 2026-07-01 (reframed from a plugin-introspection spike)

## Why this matters — and why _generic_

Identity in Lunora is **not** coupled to better-auth. The runtime seam is
`resolveIdentity(request, env) => ResolvedIdentity | null`
(`create-worker.ts:784`); whatever it returns _becomes_ `ctx.auth`. better-auth
is one implementation of that function (`.auth()` auto-wires it), but a site's
real auth is often a mix: session login on one route, a signed preview/magic
link on another, per-tenant bearer tokens on a third, mTLS or an upstream JWT
somewhere else. better-auth's plugin surface does not — and should not — cover
those. The identity layer must be **generic for all cases**: any scheme that can
produce a `userId` plus claims should flow into the same typed `ctx.auth`, RLS
policies, and `authorizeShard`/`authorizeFanOut` hooks.

Two gaps stop that today:

1. **Claims are untyped.** Beyond `userId`, `getIdentity()` returns
   `Record<string, unknown>`, so every RLS predicate and authorize hook reads
   custom claims (`tenantId`, `scopes`, `kind`) through unchecked casts. "Auth is
   part of the type system" fails exactly where apps put their bespoke logic.
2. **Composition is DIY.** Combining several resolvers (session + token + magic
   link, or a per-route map) means hand-wrapping `derived.resolveIdentity`
   through the builder escape hatch. It works (`examples/blog`,
   `examples/auth-playground`, `examples/offline-rejections` all set
   `resolveIdentity`), but there is no first-class, ordered, validated way to say
   "try these verifiers in order."

The generic answer is two declared primitives, plus one optional convenience:

- **`defineIdentity(shape)`** — declare the claim contract once. It is the single
  source of truth for `ctx.auth.identity`'s type _and_ a runtime validator at the
  trust boundary. Because it is **declared, not inferred**, codegen reads it as
  reliably as `defineSchema` — which dissolves the entire introspection cliff the
  earlier version of this plan was built around (see "What changed").
- **`composeResolvers([...])`** — ordered, first-match-wins composition of
  `IdentityResolver`s, each validated against the `defineIdentity` shape. Generic
  over every scheme; the better-auth session resolver is just one entry.
- **(Phase 3, optional) better-auth plugin inference** — sugar that _contributes_
  better-auth's session claim shape into the contract so you needn't re-declare
  it. Optional because the declared contract is authoritative; if inference can't
  resolve, you declare those fields yourself. No correctness cliff.

## What changed from the introspection framing (why this is safer)

The prior version made `ctx.auth` typing depend on statically discovering which
better-auth plugins were enabled — which the review showed fails on the repo's
own auth example (`createAuth({ ...options(env) })` spreads a helper's return,
defeating static AST; runtime import risked the Kysely `$context` hang). By
making the **declared contract** the primary source of truth, that whole risk
class moves to optional Phase 3. Phase 1+2 never introspect anything: they read a
`defineIdentity(...)` call the same way codegen already reads `defineSchema(...)`.

## Current state (verified at `c490bad`)

- `packages/runtime/src/create-worker.ts:96` — `ResolvedIdentity` is already
  generic: `{ userId: string; exp?: number; expiresAtMs?: number; [key: string]: unknown }`
  — arbitrary JSON claims plus native credential expiry (the WS path drops the
  socket at `expiresAtMs`). The runtime shape needs no change; it needs a _type_
  and a _validator_.
- `create-worker.ts:784` `resolveIdentity`, `:1042` `resolveForwardContext`
  (strips client `x-lunora-*`, re-injects verified headers — server-authoritative),
  `:559` `authorizeFanOut(identity, …)`, `:577` `authorizeShard(identity, shardKey)`.
  These are the generic consumers that should all see the declared claim type.
- `packages/server/src/types.ts:662` — `AuthState` = `{ getIdentity(): Promise<Record<string, unknown> | null>; userId: string | null }`.
  The `Record<string, unknown>` is what Phase 1 narrows to the declared shape.
- `packages/codegen/src/emit.ts:3179`, `emit-app.ts:379,407` — ctx-build sites
  emit `auth: { identity, userId }`; only the _type_ of `identity` is generic.
- `define*` conventions already present: `defineSchema`, `defineTable`,
  `defineShape`, `definePolicy`, `defineMutator`, `defineMigration`,
  `defineSchemaExtension` (`packages/server/src/index.ts:48,82`). `defineIdentity`
  slots into this family, and **reuses `defineShape`** for the claim schema so it
  inherits the existing codec/validation machinery rather than inventing one.
- The builder escape hatch (`examples/offline-rejections/lunora/_generated/app.ts:44`)
  passes `derived` so callers "compose rather than clobber — e.g. wrap
  `derived.resolveIdentity` instead of replacing it." Phase 2 makes that a
  first-class helper instead of a comment.

## Phase 1 — `defineIdentity`: the declared, validated, typed claim contract

**Goal**: one declaration types `ctx.auth.identity` everywhere and validates
resolver output at the boundary. Nothing scheme-specific.

Design:

- `defineIdentity(shape)` where `shape` is a `defineShape`-style contract whose
  inferred type extends `{ userId: string }`. It yields (a) the TS type for
  `ctx.auth.identity`, and (b) a runtime parse/validate function.
- **Where declared**: co-located with the app config (alongside `defineSchema` /
  `.auth()`), so codegen picks it up statically. Exactly one per app; zero → the
  identity stays `Record<string, unknown>` (fully backward compatible).
- **Codegen**: emit the identity type into `_generated/server.ts` and narrow
  `getIdentity(): Promise<TIdentity | null>`, plus the `identity` parameter of
  `authorizeShard`/`authorizeFanOut` and the `ctx.auth.identity` seen by
  `definePolicy` (RLS). All additive: with no `defineIdentity`, output is
  byte-identical to today.
- **Runtime validation (the trust-boundary win)**: `resolveForwardContext`
  validates the resolver's returned claims against the contract before they
  become `ctx.auth`. Claims arrive from untrusted tokens; a forged/malformed set
  is rejected (treated as anonymous, or a 401 per a declared policy) rather than
  flowing in as an unchecked cast. This is a generic security property, not a
  per-app feature. **Decide**: reject-to-anonymous vs. reject-to-401, and make it
  configurable on `defineIdentity`.
- Fields must stay honest: every claim beyond `userId` is optional unless the
  contract _and_ validation guarantee it — a required-but-absent claim inside an
  RLS predicate is the same class of bug the review flagged. Validation makes
  "required" safe here (unlike inference), because the boundary enforces it.

Phase 1 is executor-plannable: it reads a declaration (no introspection), emits a
type, and adds a validation call at one seam.

## Phase 2 — `composeResolvers`: generic ordered composition

> **Shipped naming**: these combinators landed as `composeIdentityResolvers` /
> `routeIdentityResolvers` (not the bare `composeResolvers` / `routeResolvers`
> below) to avoid a name clash with `@lunora/cloudflare-access`'s existing
> variadic `composeResolvers`. The design is otherwise as specified here.

**Goal**: combine any number of verifiers, generically, with the better-auth
resolver as one participant.

Design:

- `type IdentityResolver = (request: Request, env: unknown) => Promise<ResolvedIdentity | null> | ResolvedIdentity | null` (matches the existing `resolveIdentity` signature).
- `composeResolvers(resolvers: IdentityResolver[]): IdentityResolver` — first
  non-null wins; short-circuits; errors from one resolver are contained per a
  declared policy (skip-and-continue vs. fail-closed — **decide**, default
  fail-closed for safety). Output validated against the Phase 1 contract.
- Thin generic helper for the per-route case, built _on_ composition, not beside
  it: `routeResolvers({ "/admin": r1, "/partner": r2, "*": rDefault })` → picks by
  `new URL(request.url).pathname`. Still generic (route→resolver map); no
  portal/preview/tenant concepts baked in — those live in the app's resolvers.
- The better-auth session resolver (from `.auth()`) is obtained via the existing
  `derived.resolveIdentity` escape hatch and dropped into the list like any other
  entry, so composition never means losing better-auth.

Phase 2 is executor-plannable and independent of codegen; it is small runtime +
types + tests.

## Phase 3 (optional spike) — better-auth plugin inference as convenience

Only if requested. Infer better-auth's session claim shape (from enabled
`organization`/`admin`/… plugins) and _merge_ it into the `defineIdentity`
contract so the app needn't re-declare those fields. This is the old spike, with
its risks intact (static AST defeated by spread configs; runtime import vs. the
Kysely `$context` hang) — but now **non-blocking**: if inference can't resolve,
the caller declares those claims in `defineIdentity` and nothing is typed
_wrongly_. Keep the fail-safe: inference may only _widen_ toward the declared
contract, never contradict it. Verdict-driven, like plan 063.

## Commands you will need

| Purpose          | Command                                                             | Expected          |
| ---------------- | ------------------------------------------------------------------- | ----------------- |
| Build deps first | `pnpm run build:packages`                                           | exit 0 (run once) |
| Typecheck        | `pnpm --filter "@lunora/{server,codegen,runtime}" run lint:types`   | exit 0            |
| Tests            | `pnpm --filter "@lunora/{server,codegen,runtime}" run test`         | pass incl. new    |
| Codegen timing   | `LUNORA_CODEGEN_TIMING=1 pnpm --filter apps/playground run codegen` | prints split      |
| Lint             | `pnpm run lint:eslint`                                              | exit 0            |

## Git workflow

- Branch: `advisor/092-typed-identity-layer`.
- Commits: `feat(server): defineIdentity claim contract` (P1),
  `feat(auth): composeResolvers + routeResolvers` (P2). Angular conventional.
- Do NOT push or open a PR unless instructed.

## Scope

**In scope (Phase 1+2):**

- `packages/server/src/*` — `defineIdentity` (reusing `defineShape`); export it
  from the `define*` barrel.
- `packages/codegen/src/*` — discover the single `defineIdentity(...)` decl (like
  `defineSchema`), emit `TIdentity` into `_generated/server.ts`, narrow
  `getIdentity` + the authorize-hook + policy ctx types.
- `packages/runtime/src/create-worker.ts` — validate resolver output against the
  contract in `resolveForwardContext`; ship `composeResolvers` / `routeResolvers`
  (or place these in `@lunora/auth` if that is the better home — decide, but keep
  them scheme-agnostic).
- Tests for the contract typing, the validation boundary, and composition order.

**Out of scope:**

- Phase 3 inference unless explicitly requested.
- The cookie-cache lint (094 section below) and cookie-cache default (091).
- Any specific scheme (preview links, tenant tokens, portals) — those are docs
  examples of using these primitives, never features in the framework.

## Done criteria (Phase 1+2)

- [ ] With no `defineIdentity`, generated output for `apps/playground` is
      byte-identical to pre-change (backward compatible).
- [ ] With a `defineIdentity({ userId, tenantId, scopes, kind })`, `ctx.auth.identity`,
      `authorizeShard`'s `identity`, and RLS policy ctx are all typed to it — a
      test asserts a wrong claim access fails typecheck.
- [ ] Resolver output that violates the contract is rejected at the boundary
      (test: forged/missing claim → anonymous or 401 per config, never reaches a
      policy as a valid identity).
- [ ] `composeResolvers` first-match-wins + error policy proven by test;
      `routeResolvers` dispatches by path; the better-auth resolver composes via
      `derived.resolveIdentity` without being clobbered.
- [ ] `lint:types`, package tests, and `pnpm run lint:eslint` exit 0.
- [ ] `plans/README.md` row updated.

## STOP conditions

- `defineShape`'s inference cannot express "extends `{ userId: string }` with
  arbitrary extra claims" cleanly → report; the contract may need its own light
  type rather than reusing `defineShape` wholesale.
- Narrowing `getIdentity()`'s return breaks an existing `@lunora/server` /
  RLS-middleware consumer of the bare `Record<string, unknown>` → verify against
  those tests before shipping (the index signature should keep it compatible).
- Validating at `resolveForwardContext` measurably regresses the hot path (it is
  per-request) → make validation opt-out or move it to the resolver boundary.

## Maintenance notes

- Keep the framework scheme-agnostic: `defineIdentity` + `composeResolvers` know
  nothing about tokens, portals, or tenants. Ship those as **docs recipes**
  (preview magic link, per-tenant token → `authorizeShard`, per-route login) that
  compose the generic primitives, so the surface stays small and general.
- The declared contract is authoritative over any Phase 3 inference — document
  that precedence so a future inference feature can't silently override it.

## Relationship to the sibling plans

- **091 (cookie-cache, ready)** — independent; land first.
- **`.shardBy(ctx => ctx.auth.identity.tenantId)`** — becomes trivial and typed
  once Phase 1 lands, since the tenant claim is a typed field. File it after this;
  it still crosses the RLS/shard boundary, so carry a STOP condition.

---

## Follow-on 094: `auth_session_read_without_cache` advisor lint

> Kept here (per operator request) because it is auth-config-shaped like the rest
> of this plan. **Gated**: begin only after 091's cookie-cache default exists on
> `alpha` (so the "cache on by default" baseline is real). Orthogonal to the
> identity-typing work above — it does **not** reuse Phase 1/2's `defineIdentity`
> discovery. **Note on the reader**: neither 091 (defaults only, no new API) nor
> 092 Phase 1+2 (reads `defineIdentity`, never introspects `createAuth`) produces
> a `createAuth`-config reader. So **094 builds its own**, small and self-contained
> (see scope). Do not block on a sibling plan to supply it.

### 094 status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW
- **Depends on**: 091's cookie-cache default on `alpha` (the baseline it lints
  against). Builds its own `createAuth`-config reader; no dependency on 092's
  `defineIdentity` discovery.
- **Category**: feat (advisor) / perf

### 094 why

091 sets a good default (a short cookie cache), but a caller can pass
`session: { cookieCache: { enabled: false } }` and then read identity on a hot
path — reintroducing the per-request D1 session read invisibly. A static lint
makes that cost visible: _this function resolves identity, and this deployment
has neither `cookieCache` nor the `jwt` plugin, so every call hits D1._

### 094 current state (verified at `c490bad`)

- `packages/advisor/src/lints/static/auth-api-call-without-headers.ts` — the
  template: a `Lint` object with `categories`, `description`, `facing`, `level`,
  `name`, `remediation`, `run(context)`, reading evidence from
  `context.authApiCalls` and returning `[]` when evidence is absent. Findings use
  `emit(lint, { cacheKey, … })` with an occurrence-suffixed key.
- `packages/advisor/src/index.ts:14` — lints register by import.
- `packages/advisor/src/types.ts` — **verified**: `Category = "PERFORMANCE" | "SCHEMA" | "SECURITY"`
  (so `["PERFORMANCE"]` is valid), `Facing = "EXTERNAL" | "INTERNAL"` (use
  `EXTERNAL` — a per-request D1 read is latency a user feels), `Level` carries
  `WARN`. New `context` evidence fields (`identityReads`, `authConfig`) are
  declared here and fed from codegen, mirroring `authApiCalls`.

### 094 evidence design

The lint needs two facts in `context`:

1. **Identity-read evidence** — does any function read identity beyond a bare
   `userId` (call `getIdentity()` / destructure `ctx.auth`)? A new
   `discover-identity-reads.ts`, modeled 1:1 on `discover-authapi-calls.ts`:
   walk `listLunoraSourceFiles`, match `ctx.auth.getIdentity(...)` and the
   destructured form, record `{ file, line, function }`. Conservative.
2. **Cache/JWT posture** — is `session.cookieCache.enabled !== false` **or** the
   `jwt` plugin enabled? A new, self-contained `createAuth`-config reader (this
   plan builds it — see scope) returns `cookieCacheEnabled` / `jwtEnabled`. It
   reads the `createAuth({...})` call statically and, like
   `discover-authapi-calls.ts`, returns "unresolved" whenever the config is not
   statically analyzable (e.g. `createAuth({ ...options(env) })` spread configs).
   On "unresolved" the lint returns `[]` — no evidence, no alarm.

Fires only when: identity read **and** config resolved **and** cache off **and**
jwt off. Any "unresolved" → silent.

### 094 lint object (target shape)

```ts
const authSessionReadWithoutCache: Lint = {
    categories: ["PERFORMANCE"], // verified valid in types.ts
    description:
        "A function reads the session identity (`ctx.auth.getIdentity()`) but the deployment has neither a session cookie cache nor the `jwt` plugin — so every authenticated call performs a D1 session read.",
    facing: "EXTERNAL", // per types.ts: EXTERNAL = performance a user can feel
    level: "WARN",
    name: "auth_session_read_without_cache",
    remediation:
        "Enable a short-lived cookie cache (`session: { cookieCache: { enabled: true, maxAge: 60 } }`, or a `sessionPresets` value) so `getSession` skips the D1 read, or add the `jwt` plugin. See plan 091.",
    run: (context) => {
        if (context.identityReads === undefined || context.authConfig === undefined) return [];
        if (context.authConfig.unresolved) return [];
        if (context.authConfig.cookieCacheEnabled || context.authConfig.jwtEnabled) return [];
        // …emit one finding per identity-read site, occurrence-suffixed cacheKey.
    },
};
```

### 094 scope

- `packages/codegen/src/discover-identity-reads.ts` (new) + test.
- `packages/codegen/src/discover-auth-config.ts` (new) + test — the self-contained
  `createAuth`-config reader returning `cookieCacheEnabled` / `jwtEnabled` (or
  "unresolved"), modeled on `discover-authapi-calls.ts`. This plan owns it; no
  sibling plan supplies it.
- Thread both into the advisor `context` (feeder + `types.ts` context shape).
- `packages/advisor/src/lints/static/auth-session-read-without-cache.ts` (new) + test.
- Register in `packages/advisor/src/index.ts`.

### 094 done criteria

- [ ] 091's cookie-cache default has landed on `alpha` (the baseline; else STOP).
- [ ] The new `discover-auth-config.ts` reader (built by this plan) returns
      `cookieCacheEnabled` / `jwtEnabled` / "unresolved" and has a test.
- [ ] Fires only when identity read AND config resolved AND cache off AND jwt
      off; fixtures for cache-on, jwt-on, unresolved, and no-identity-read each
      assert **zero** findings.
- [ ] One fixture (identity read + cache `enabled: false`) asserts exactly one
      finding with the shared cacheKey convention.
- [ ] Registered; `@lunora/advisor` + `@lunora/codegen` tests and `lint:types`
      exit 0; `pnpm run lint:eslint` exit 0.
- [ ] `plans/README.md` row updated.

### 094 STOP conditions

- 091's cookie-cache default is not yet on `alpha` → stop; 094 lints against that
  baseline.
- The `createAuth` call cannot be read statically at all (even the conservative
  reader can't extract `cookieCache`/`jwt` from any real app config, always
  "unresolved") → stop; the lint would never fire and is not worth shipping.
- Any fixture shows the lint firing on an "unresolved config" case → the
  fail-safe is broken; fix the guard (a false perf-warning on every
  un-analyzable app is alarm fatigue).
