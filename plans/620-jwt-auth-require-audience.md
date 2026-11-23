# Plan 620: The generic JWT identity resolver refuses to verify without an audience unless the caller opts out

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- shared/jwt-verify.ts packages/jwt-auth packages/cloudflare-access`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** BLOCKED (owner decision, see "Blocked on" below)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Blocked on (2026-11-20, first execution attempt; no code was changed)

The Design assumes the `clerk` and `workos` presets enforce a binding claim unconditionally. They do not, by documented choice:

- `packages/jwt-auth/src/presets.ts` `clerkClaims` (~line 199) rejects only when `azp` is present and not in `authorizedParties`; its doc comment says a token without `azp` (a native app's) passes.
- `workosClaims` (~line 356) rejects only when `client_id` is present and different; its doc comment says absence is not treated as an attack.

The owner picks one before this plan runs again:

1. **Generic resolver only (recommended).** Require `audience` (or `audience: false`) on `jwtIdentityResolver` / `jwtVerifier`; the two presets pass `audience: false` and keep today's party checks, with the why-comment naming the native-app case. Then delete the matching STOP condition.
2. **Tighten the presets too.** Make `azp` / `client_id` mandatory, with a preset option to allow their absence for native apps. Larger break; needs its own tests and docs.

## Why this matters

`@lunora/jwt-auth` verifies third-party JWTs (Auth0, Clerk, Supabase, WorkOS, or any OIDC issuer) and turns them into the Lunora identity. Its generic entry points (`jwtIdentityResolver`, `jwtVerifier`) make `audience` optional and pass `undefined` to `jose` when it is unset, so a token the same issuer minted for a _different application_ verifies. The package's own doc comment says so: "without it, any token the issuer minted for another application verifies too." The sibling package `@lunora/cloudflare-access` already refuses to verify without `aud`. On this pre-release line the safe default should be the default: no audience ⇒ construction error, with an explicit, named opt-out for providers that issue no `aud`.

## Current state

- `shared/jwt-verify.ts` — bundler-inlined source shared by `@lunora/jwt-auth` and `@lunora/cloudflare-access` (not a package; imported by relative path; must stay dependency-free).
    - `JwtVerifierOptionsOf<Key>` (line ~57) has:

```ts
    /**
     * Expected `aud`. Verified only when set — set it whenever your provider
     * issues one (Auth0's API identifier, Supabase's `authenticated`): without
     * it, any token the issuer minted for another application verifies too.
     */
    audience?: string | string[];
```

- `assertKeySource(options)` (line ~303) validates issuer / `jwksUrl` / `keySet` and throws via `fail(...)`. `verifyJwt` (line ~321) calls it first, then `jose.jwtVerify(token, keySet, { algorithms, audience: options.audience, clockTolerance, issuer, requiredClaims })`.
- `packages/jwt-auth/src/verify.ts`, `resolver.ts`, `presets.ts` — public API. Presets: `auth0` requires `audience` (presets.ts ~395-436); `supabase` pins `audience: "authenticated"` (~485); `clerk` and `workos` pass no audience and validate `azp`/`authorizedParties` and `client_id` respectively inside their claims mappers — read both before changing anything.
- `packages/cloudflare-access/src/verify.ts:55-65` — requires `aud` itself before calling the shared verifier.
- Tests: `packages/jwt-auth/__tests__/resolver.test.ts`, `presets.test.ts`; `packages/cloudflare-access/__tests__/`.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.
- `shared/` files are outside per-package ESLint: follow the no-extension and named-export rules by hand, and keep the file free of package imports.

## Commands you will need

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                                                                        | Expected on success |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                                               | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/jwt-auth..." run build`                                                                | exit 0              |
| One test file                 | `pnpm --filter "@lunora/jwt-auth" exec vitest run __tests__/resolver.test.ts`                                  | all pass            |
| Package tests                 | `pnpm --filter "@lunora/jwt-auth" run test`                                                                    | all pass            |
| Types                         | `pnpm --filter "@lunora/jwt-auth" run lint:types`                                                              | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/jwt-auth" run lint:eslint`                                                             | exit 0, 0 warnings  |
| Sibling                       | `pnpm --filter "@lunora/cloudflare-access..." run build && pnpm --filter "@lunora/cloudflare-access" run test` | pass                |
| Public API                    | `pnpm run api:check` (after building both)                                                                     | see step 4          |

## Design (decided)

- `audience` becomes `audience: string | string[] | false` and is **required** in `JwtVerifierOptionsOf`. `false` is the explicit opt-out ("this provider issues no `aud`; another claim binds the token to this app").
- `assertKeySource` (rename to `assertVerifierOptions` if you prefer; keep one function) throws `fail(`${name}: set \`audience\` to the value your provider puts in \`aud\`, or pass \`audience: false\` if it issues none and another claim binds the token to this app`)` when `audience === undefined`, and also when it is an empty string / empty array / contains an empty string. The runtime check stays even though the type requires the field (JS callers, env-derived `undefined`).
- `verifyJwt` passes `audience: options.audience === false ? undefined : options.audience` to `jose`.
- Presets: `auth0` and `supabase` unchanged. `clerk` and `workos` pass `audience: false` **internally** (their party/client checks are the binding), with a one-line why-comment. If either preset does _not_ in fact enforce a binding claim unconditionally, STOP.
- `@lunora/cloudflare-access` already always passes `aud`; only its types may need a touch.

## Scope

**In scope**: `shared/jwt-verify.ts`; `packages/jwt-auth/src/{verify,resolver,presets}.ts`; `packages/cloudflare-access/src/verify.ts` (types only if needed); tests in both packages; `packages/jwt-auth/docs/*.mdx` (every generic-resolver example gains `audience`, plus a short "No audience?" note); `api-snapshots/jwt-auth.api.md` (and `cloudflare-access.api.md` if it moves); `examples/*`, `templates/*`, `registry/*` call sites of `jwtIdentityResolver`/`jwtVerifier` that omit `audience` (`rg -n "jwtIdentityResolver\\(|jwtVerifier\\(" --glob '!**/node_modules/**' --glob '!**/dist/**' .`).

**Out of scope**: `@lunora/auth` (better-auth, unrelated); algorithm defaults; the token-source helpers; the 8 non-JS SDKs.

## Git workflow

- Branch: `fix/545-jwt-require-audience` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `security(jwt-auth): require an audience or an explicit opt-out`.
- Never use `--no-verify`. Do NOT push or open a PR. Put `BREAKING: jwtIdentityResolver/jwtVerifier now require \`audience\` (or \`audience: false\`)` in the commit body.

## Steps

1. **Tests first** in `resolver.test.ts` (copy the file's existing key-set/JWT minting helpers): (a) constructing/using the generic verifier with no `audience` rejects with a message containing `audience`; (b) `audience: ""` rejects; (c) with `audience: "api://a"`, a token minted with `aud: "api://b"` is rejected and one with `aud: "api://a"` verifies; (d) with `audience: false`, a token with no `aud` verifies. **Verify**: (a), (b) fail now (red).
2. Implement the Design in `shared/jwt-verify.ts`, then fix the two packages' types and presets. **Verify**: `lint:types` exit 0 for both packages; step-1 tests pass; `presets.test.ts` passes unchanged except where a test built a generic resolver without `audience` (add `audience` there, do not delete the test).
3. Update call sites and docs found by the scope's `rg`. **Verify**: `rg` shows every generic call has `audience`; `pnpm exec prettier --check packages/jwt-auth/docs`.
4. Build both packages, `pnpm run api:check` → the only diff is the `audience` type; run `pnpm run api:update`; commit snapshots.

## Done criteria

- [ ] jwt-auth and cloudflare-access: `run test`, `lint:types`, `lint:eslint` exit 0
- [ ] `pnpm run api:check` exits 0
- [ ] `rg -n "audience\\?:" shared/jwt-verify.ts` → no match in `JwtVerifierOptionsOf`
- [ ] New tests (a)–(d) exist; (a) and (b) were red before the change

## STOP conditions

- `clerk` or `workos` preset has a code path that verifies with neither an audience nor a binding-claim check.
- An example/template relies on audience-less verification with no binding claim available (report it; do not paper over with `audience: false`).
- `api:check` shows unrelated diffs.

## Maintenance notes

- New presets must either set an audience or justify `audience: false` with the claim that binds the token.
- Reviewer: this is a breaking change for generic-resolver users on alpha; the commit body carries the note for the release log.
