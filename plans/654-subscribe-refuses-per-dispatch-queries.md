# Plan 654: A query with per-dispatch middleware cannot be subscribed to

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/do/src/shard-do.ts packages/codegen/src/emit/shard.ts packages/codegen/src/emit/shard-dispatch.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/subscribe-refuses-per-dispatch-queries`, PR #1661 (workerd: all). Not covered: a per-dispatch query reached through `ctx.runQuery` inside a subscribed query

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

Middleware tagged per-dispatch (`tagPerDispatchMiddleware` in `@lunora/server`: `rateLimit(...)`, `ratelimitPlugin(...)`, the Turnstile middleware in `packages/auth/src/turnstile-middleware.ts`) has an effect that must happen once per request. The reactive cache respects that — `packages/codegen/src/emit/shard.ts` (~851-853) only caches when `registered.perDispatch !== true`. Subscriptions do not: `subscribe()` in `packages/do/src/shard-do.ts` (~6513) refuses only paid functions:

```ts
if (query.functionPath !== undefined && this.isPaidFunction(query.functionPath)) {
    return "paid";
}
```

and `executeSubscription` (`packages/codegen/src/emit/shard-dispatch.ts` ~411) calls the registered handler — the whole middleware chain — on the seed and on **every refresh**. So each write that touches a watched table charges the subscriber's rate-limit bucket, even when someone else made the write, until the subscriber's live query and its own RPCs get `TOO_MANY_REQUESTS`; and a subscribed Turnstile-gated query fails on its first refresh because the single-use token is replayed.

**Owner decision (2026-11-21): refuse such subscriptions, the way paid functions are refused.**

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

| Purpose                       | Command                                                       | Expected on success |
| ----------------------------- | ------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                              | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/do..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/do" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/do" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/do" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/do" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

Mirror the paid refusal exactly. Find how `isPaidFunction` gets its answer from the generated shard and how the `"paid"` refusal reaches the client (error code, frame shape, the client's handling, docs) — `rg -n "isPaidFunction|\"paid\"" packages/do/src packages/codegen/src packages/client/src | head -40`. Add the same for per-dispatch: a predicate the generated shard answers from `registered.perDispatch`, a refusal in `subscribe()` next to the paid one with its own reason, and the same treatment on any other path that re-executes a query for a live consumer (streams/shapes: check `executeStream` and what it already refuses). The error must tell the developer what to do: "this query runs per-dispatch middleware (rate limit, Turnstile), so it cannot be subscribed to; call it as a one-off query, or move the check to a mutation". A one-off RPC of the same query keeps working. Use an error code that already exists in the `@lunora/errors` catalog if one fits the paid refusal's class; if the paid refusal has its own code, add a sibling the same way that one was added (catalog, docs table, tests that enforce the catalog).

All eight non-JS SDKs and the TS client receive the refusal as a subscription error; check how they surface the paid refusal (`rg -n -i "paid" sdks/*/README.md packages/client/src | head`) — if they special-case its code, the new code needs the same line in each; if they treat it generically, no SDK change is needed. Say which.

## Steps

1. Read the paid refusal end to end and list every place it is special-cased. 2. Tests first: in `packages/do/__tests__` (next to the paid-subscription test) a subscribe to a per-dispatch query is refused with the new reason and no handler run; a one-off RPC of it still runs; a normal query still subscribes. In `packages/codegen` the emitted predicate (golden fixtures regenerate with the package's own script — find it in `package.json`; do not hand-edit goldens). Red at baseline. 3. Implement. 4. Docs: the ratelimit docs (`packages/ratelimit/docs/index.mdx`), the Turnstile docs and the live-query docs each get one sentence. 5. `rg -n "rateLimit\(|ratelimitPlugin\(|verifyTurnstileMiddleware\(" examples templates registry apps --glob '!**/node_modules/**' -l` — if a first-party example subscribes to such a query, change the example to a one-off call and say so. 6. Build, test, types, eslint for `@lunora/do`, `@lunora/codegen` and any other touched package.

## Git workflow

- Branch: `fix/subscribe-refuses-per-dispatch-queries`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(do): refuse a subscription to a per-dispatch query`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- The generated `_generated/` output of examples changes: regenerate with the repo's codegen command for examples only if a documented single command does it (`rg -n "codegen" package.json | head`); otherwise STOP and list the files.
- The refusal would also block `ctx.runQuery` of such a query from inside a subscribed query (nested): report how nested per-dispatch queries behave today and do not change that.

## Maintenance notes

- Breaking for apps that subscribe to rate-limited or Turnstile-gated queries today; say so in the commit body with the `BREAKING CHANGE:` footer.
- Reviewer: run `pnpm run test:workerd`.
