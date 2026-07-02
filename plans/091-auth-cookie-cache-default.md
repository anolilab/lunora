# Plan 091: Make authenticated calls skip the D1 session read by default (cookie-cache)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c490bad..HEAD -- packages/auth/src/create-auth.ts packages/auth/src/session.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `c490bad`, 2026-07-01

## Why this matters

Every authenticated Lunora call ultimately resolves identity through
better-auth's `getSession`, and better-auth backs sessions in D1. Without a
session cookie cache, **each `getSession` is a D1 read** — added to the latency
of every query/mutation/action that reads `ctx.auth`, and to the WebSocket
upgrade handshake. On the "runs on your Cloudflare account" pitch, D1 latency is
the caller's latency; a per-request session read is the most common avoidable
cost in the auth hot path.

better-auth already solves this with `session.cookieCache`: a short-lived,
signed cookie that carries the session payload so `getSession` can return
without hitting the database until the cache window elapses. `@lunora/auth`
**documents** this lever (`session.ts:17`) but never enables it — so the
out-of-the-box experience, and even the recommended `sessionPresets`, pay the
D1 read on every call.

This plan turns cookie-cache on for the common path, exactly the way
`@lunora/auth` already fills other smart defaults (secure cookies in
`hardenAuthOptions`; `rateLimit.enabled: true` in `createAuth`) — filled only
when the caller has not made an explicit choice, forwarded verbatim otherwise.
The one real tradeoff (a revoked session stays valid until the cache window
expires) is bounded by a short TTL and documented; the security-sensitive
`strict` preset opts out.

## Current state

- `packages/auth/src/session.ts` — `sessionPresets` (lines ~75–90) defines
  `rolling` / `strict` / `longLived`. **None sets `cookieCache`.** The doc block
  above it (line 17) already names `cookieCache` as "opt-in signed-cookie
  session cache to skip DB reads" — so the concept is known here, just unused.

    ```ts
    const sessionPresets: Record<"longLived" | "rolling" | "strict", SessionPolicy> = {
        longLived: { expiresIn: 30 * DAY, freshAge: DAY, updateAge: DAY },
        rolling: { expiresIn: 7 * DAY, freshAge: DAY, updateAge: DAY },
        strict: { expiresIn: HOUR, freshAge: 5 * MINUTE, updateAge: 15 * MINUTE },
    };
    ```

- `packages/auth/src/create-auth.ts` — `createAuth` (line 153). It already
  establishes the "fill a default only when the caller was silent" pattern for
  `rateLimit` (the block ending ~line 195):

    ```ts
    const resolvedOptions: LunoraAuthOptions =
        hardened.rateLimit?.enabled === undefined ? { ...hardened, rateLimit: { ...hardened.rateLimit, enabled: true } } : hardened;

    return betterAuth(resolvedOptions);
    ```

    and the `hardenAuthOptions` helper (lines 66–108) does the same for cookie
    attributes (`?? { httpOnly, path, sameSite }`). There is **no** equivalent
    default for `session.cookieCache`.

- `grep -rn "cookieCache" packages/auth/src` returns exactly one hit — the doc
  comment in `session.ts`. Confirming it is set nowhere today.

## Commands you will need

| Purpose          | Command                                       | Expected on success      |
| ---------------- | --------------------------------------------- | ------------------------ |
| Build deps first | `pnpm run build:packages`                     | exit 0 (run once)        |
| Typecheck        | `pnpm --filter "@lunora/auth" run lint:types` | exit 0, no errors        |
| Tests            | `pnpm --filter "@lunora/auth" run test`       | all pass, incl. new test |
| Lint             | `pnpm run lint:eslint`                        | exit 0 (0 errors)        |

> `dist/` is gitignored and built on demand; a raw per-package test does not
> rebuild workspace deps. Run `pnpm run build:packages` once before the first
> typecheck/test so cross-package `@lunora/*` types resolve.

## Design decisions (settle before coding)

1. **Default TTL**: `cookieCache.maxAge = 60` (seconds). Long enough to erase
   the per-request D1 read for a burst of calls; short enough that a revoked or
   role-changed session self-corrects within a minute. This is the value the
   `createAuth` default and the `rolling` / `longLived` presets use.
2. **`strict` opts out**: the `strict` preset sets `cookieCache: { enabled: false }`.
   Its whole point is fast revocation / short freshness; a cache would undercut
   that. Keeping it explicit (rather than absent) documents the intent and
   prevents the `createAuth` default from re-enabling it.
3. **`createAuth` fills the default only when the caller was silent about
   `session.cookieCache`** — mirror the `rateLimit.enabled === undefined` gate
   exactly. If the caller passed _any_ `cookieCache` (including
   `{ enabled: false }`), forward it verbatim. If the caller passed a `session`
   block without `cookieCache`, still fill the cache default (they opted into a
   policy, not out of the cache). Concretely: default applies when
   `resolved.session?.cookieCache === undefined`.
4. **No new public API.** This is defaults + presets only. `cookieCache` remains
   configurable through the existing `session` option; we are choosing its
   default value, not adding a surface.

> If any of these four cannot hold against the live better-auth types (e.g.
> `cookieCache` is not a valid `session` sub-key in the pinned better-auth
> version), that is a STOP condition — report the actual `SessionPolicy` shape.

## Scope

**In scope** (the only files you should modify):

- `packages/auth/src/session.ts` — add `cookieCache` to the presets per the
  decisions above; extend the doc block if needed.
- `packages/auth/src/create-auth.ts` — add the `cookieCache` default to
  `resolvedOptions`, gated on caller silence, next to the `rateLimit` default.
- `packages/auth/__tests__/create-auth.test.ts` and/or
  `packages/auth/__tests__/session.test.ts` — add regression tests (see Test plan).

**Out of scope** (do NOT touch, even though they look related):

- The `jwt` / stateless-verification path (`packages/auth/src/plugins.ts`) — a
  separate, larger tradeoff; not this plan.
- `hardenAuthOptions`' cookie-attribute logic — unrelated; leave as is.
- Any runtime/DO identity-forwarding code — the cache is entirely inside
  better-auth's `getSession`; no worker change is needed.
- The `ctx.auth` codegen binding and the advisor lint (see "Follow-ups").

## Git workflow

- Branch: `advisor/091-auth-cookie-cache-default` (or match the repo's
  convention if one is evident in `git branch`).
- Commit message: Angular conventional commits, e.g.
  `perf(auth): default a short-lived session cookie cache to skip the D1 read`.
  (Enforced commit types include `perf`.)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0 (blocking): Verify the better-auth `session.cookieCache` API

**Do this before writing any code.** The entire plan assumes better-auth
(`^1.6.22`, per `pnpm-workspace.yaml`) exposes a session cookie cache at
`session.cookieCache` with `{ enabled: boolean; maxAge: number }` (seconds).
That shape was **not** verified when this plan was written — better-auth is not
installed in a fresh clone, and the version postdates the plan author's
reference knowledge. If it is wrong, Steps 1–3 are wrong.

Verify against the installed types, not from memory:

```bash
pnpm install   # if node_modules is absent
# Inspect the real SessionPolicy / session-option type:
grep -rn "cookieCache" node_modules/better-auth/dist/**/*.d.ts | head
# Or open the type of BetterAuthOptions["session"] in an editor / ts probe.
```

Confirm three things and record them at the top of the PR description:

1. The key is `session.cookieCache` (not e.g. `advanced.cookieCache` or a
   top-level option).
2. Its fields are `enabled` and `maxAge`, and `maxAge` is in **seconds**
   (historically better-auth defaulted `maxAge` to `300`; confirm the current
   default so `60` is a deliberate lowering, not a guess).
3. `cookieCache` is assignable within the `session` object that
   `@lunora/auth`'s `SessionPolicy` (`= NonNullable<BetterAuthOptions["session"]>`)
   already forwards verbatim.

**If any of the three does not hold → STOP** and report the real shape. The rest
of the plan (preset keys, the `createAuth` default gate, the tests) must then be
rewritten to the actual API before proceeding. Do not adapt on the fly.

### Step 1: Add `cookieCache` to the presets

In `packages/auth/src/session.ts`, give `rolling` and `longLived` a
`cookieCache: { enabled: true, maxAge: 60 }`, and `strict`
`cookieCache: { enabled: false }`. Update the preset doc lines so the
one-line descriptions mention the cache posture (e.g. "rolling — … 60s cookie
cache").

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0. If
`cookieCache` is not assignable to `SessionPolicy`, STOP (decision 4 note).

### Step 2: Default the cache in `createAuth` when the caller is silent

In `packages/auth/src/create-auth.ts`, extend the `resolvedOptions`
construction so that, in addition to the existing `rateLimit` default, it fills
`session.cookieCache` when `resolved.session?.cookieCache === undefined`. Keep
the caller's `session` fields otherwise verbatim. Add a comment mirroring the
existing `rateLimit` rationale block: why a cache (skip the per-request D1
read), the bounded-staleness tradeoff, and how to opt out
(`session: { cookieCache: { enabled: false } }`).

Do the `rateLimit` fill and the `cookieCache` fill in one composed object; do
not reshape `session` in a way that narrows better-auth's inferred `Auth<…>`
type away from `LunoraAuth` (the file already warns about this for the
pass-through).

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0.

### Step 3: Tests

Add regression tests asserting:

- `createAuth({ secret, database })` (no `session`) yields options whose
  `session.cookieCache.enabled === true` and `maxAge === 60`.
- A caller-supplied `session: { cookieCache: { enabled: false } }` is forwarded
  verbatim (the default does NOT re-enable it).
- A caller-supplied `session: { expiresIn: … }` **without** `cookieCache` still
  gets the cache default filled.
- `sessionPresets.strict.cookieCache.enabled === false`; `rolling` and
  `longLived` have `enabled: true, maxAge: 60`.

Reuse the existing harness in the auth `__tests__` dir (find how `createAuth` is
already asserted against — e.g. how the `rateLimit` default is tested — and
mirror it; do not invent a new betterAuth mock if one exists).

**Verify**: `pnpm --filter "@lunora/auth" run test` → all pass.

## Test plan

- Unit tests as in Step 3, colocated with the existing `createAuth` / session
  assertions.
- Manual (optional, not gating): in `apps/playground`, sign in and confirm the
  session cookie now carries a cache segment and that repeated authenticated
  reads within the TTL do not emit a D1 session query in the dev logs. Documented
  here as a sanity check, not a CI gate.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Step 0 completed: the real `session.cookieCache` shape (`enabled`/`maxAge`,
      seconds) is confirmed against the installed better-auth types and noted in
      the PR description; if it differed from the assumption, the plan was
      rewritten to the actual API before coding.
- [ ] `pnpm --filter "@lunora/auth" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/auth" run test` exits 0; new tests pass.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] `grep -n "cookieCache" packages/auth/src/create-auth.ts` shows the default
      is set (not just referenced in a comment).
- [ ] `grep -n "cookieCache" packages/auth/src/session.ts` shows all three
      presets carry an explicit `cookieCache`.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `cookieCache` is not a valid key on the pinned better-auth `session` option
  type (the pass-through would not typecheck) — report the real shape.
- An existing test asserts that `getSession` always hits the database / that no
  cookie cache is present — that would mean something downstream depends on the
  uncached read, and enabling it needs wider discussion.
- Enabling the cache breaks an auth e2e (`tests/e2e/tests/auth.spec.ts`) around
  sign-out / revocation — the revocation-latency tradeoff may be load-bearing in
  a test and needs a decision on TTL rather than a silent change.

## Maintenance notes

- If a future security requirement needs immediate revocation everywhere, the
  answer is per-deployment `session: { cookieCache: { enabled: false } }` (or
  the `strict` preset), not removing the default — most apps want the cache.
- Reviewer should confirm the default is gated on caller silence (decision 3),
  so a caller who explicitly disabled the cache is never overridden.

## Follow-ups (NOT in this plan — sequenced after it)

These are the DX half of "smooth + fast auth"; each is its own plan, filed
separately so this perf win can land on its own:

- **092 — generic typed identity layer (`plans/092-typed-identity-layer.md`).**
  A _declared_ claim contract (`defineIdentity`) that codegen reads the same way
  it reads `defineSchema`, plus `composeResolvers` for ordered resolver
  composition. `ctx.auth.identity`, RLS predicates, and the
  `authorizeShard`/`authorizeFanOut` hooks all narrow to the declared type, and
  resolver output is validated at the trust boundary. Scheme-agnostic — not
  coupled to better-auth. (Static plugin-introspection — the old framing — is
  demoted to an optional Phase 3 spike; the declared contract is authoritative.)
  L for Phase 1+2; touches `@lunora/server` + `@lunora/codegen` + `@lunora/runtime`.
- **094 — advisor lint `auth_session_read_without_cache`.** Lives as the
  "Follow-on 094" section inside `plans/092-typed-identity-layer.md` (not a
  separate file). Static lint (splinter-style, like `index_utilization`) that
  flags an authenticated function resolving identity when the deployment has
  neither a session `cookieCache` nor the `jwt` plugin — i.e. "every call hits
  D1." Small; **it builds its own `createAuth`-config reader** (neither this plan
  nor 092 produces one) and is gated on 091's cookie-cache default existing on
  `alpha`. Pairs naturally with this plan: 091 sets the good default, 094 catches
  the case where a caller disabled it and still reads identity on a hot path.
- **Auto-derive `.shardBy` from tenant claim** — let a table opt into
  `.shardBy(ctx => ctx.auth.identity.tenantId)` (typed once 092 Phase 1 lands, so
  the tenant claim is a real field) so tenant isolation follows auth without
  hand-wiring. Depends on 092's typed `ctx.auth.identity`. Scope carefully — it
  crosses the RLS/shard security boundary, so it should carry a STOP condition
  like the Wave 4 sync-engine plans.
