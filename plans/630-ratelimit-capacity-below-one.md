# Plan 630: A rate-limit `capacity` that can never admit a request is refused at construction

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/ratelimit/src/rate-limiter.ts packages/ratelimit/src/algorithms.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/ratelimit-plugin-dispatch-and-capacity`; PR #1641

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`new RateLimiter({ config })` validates each limit up front so a config bug fails at boot. `capacity` is only checked for "finite and not negative". A capacity below the default request count of 1 (for example `0.5`, or `0`) passes construction, and then **every** `limit()` call throws `INTERNAL` "requested count 1 exceeds the limiter capacity", which the middleware re-throws as a 500 on every request — the opposite of failing fast.

## Current state

`packages/ratelimit/src/rate-limiter.ts` (~line 167):

```ts
if (config.capacity !== undefined && (!Number.isFinite(config.capacity) || config.capacity < 0)) {
    throw new LunoraError("INTERNAL", `rate limit "${name}": capacity must be a non-negative number`);
}
```

In the algorithms module (`rg -n "capacityOf|throwCountExceedsCapacity" packages/ratelimit/src`): `const capacityOf = (config) => config.capacity ?? config.rate;` and both the token bucket and fixed window do `if (options.count > capacity) { throwCountExceedsCapacity(options.count, capacity); }`. A sliding window ignores `capacity` and caps at `rate`.

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

## Commands you will need

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                              | Expected on success |
| ----------------------------- | -------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                     | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/ratelimit..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/ratelimit" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/ratelimit" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/ratelimit" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/ratelimit" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

1. Read how `count` is validated (`rg -n "count" packages/ratelimit/src/rate-limiter.ts`). If `count` must be a positive **integer** (or defaults to 1 with no fractional use documented): require `capacity >= 1`; message `capacity must be at least 1`.
2. If fractional counts are supported and documented: require only `capacity > 0`, and say so in the report.
3. Apply the same lower bound to `rate` **only if** the same always-throws outcome exists for it (a sliding window with `rate` < 1, or any kind with no `capacity` and `rate` < 1): check, and if so refuse it with a matching message. If `rate` < 1 is a meaningful config (e.g. 0.5 per period accumulating in a bucket with capacity ≥ 1), leave `rate` alone and add a test pinning that it still works.

## Steps

1. Tests first in the existing constructor-validation test file (`rg -ln "must be a positive number" packages/ratelimit/__tests__`): `capacity: 0.5` and `capacity: 0` throw at construction with the new message; `capacity: 1` constructs and admits one request; plus the `rate` cases from Design 3. **Verify**: red at baseline.
2. Implement; update the doc comment/JSDoc of `capacity` on the config type and any docs table (`rg -n "capacity" packages/ratelimit/docs packages/ratelimit/README.md apps/docs/src --glob '*.md*' | head`).
3. `pnpm run lint:registry:sync` (vendored ratelimit copies); if drift, run the sync script and include it.
4. Build, test, types, eslint for `@lunora/ratelimit`.

## Scope

**In scope**: the constructor validation in `rate-limiter.ts`, tests, docs for the field, vendored copies via the sync script. **Out of scope**: the algorithms; the middleware's error mapping.

## Git workflow

- Branch: `fix/ratelimit-plugin-dispatch-and-capacity (same branch as plan 629, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(ratelimit): refuse a capacity no request can fit`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## Done criteria

- [ ] New tests pass and were seen red
- [ ] `pnpm --filter "@lunora/ratelimit" run test`, `lint:types`, `lint:eslint` exit 0; `pnpm run lint:registry:sync` exits 0

## STOP conditions

- An existing test or doc uses `capacity: 0` deliberately (for example as a kill switch): STOP and report it.
