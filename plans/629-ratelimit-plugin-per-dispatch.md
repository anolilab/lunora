# Plan 629: `ratelimitPlugin` middleware is tagged per-dispatch so a cached query cannot skip the limit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/ratelimit/src/plugin.ts packages/ratelimit/src/middleware.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/ratelimit-plugin-dispatch-and-capacity` (workerd: ratelimit); PR #1641

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`@lunora/ratelimit` offers two ways in: the enforcing `rateLimit(...)` middleware, and `ratelimitPlugin(limiter)`, whose middleware puts the limiter on `ctx.api.ratelimit` for the handler to call. The first is tagged per-dispatch, which keeps a query using it out of the reactive result cache — its own comment explains: without the tag "a hit answers without running this chain at all, and one dispatch's charge covered every request the memo served". The plugin middleware carries no such tag, so a query that charges the limit inside its handler through `ctx.api.ratelimit.limit(...)` is cached, and every cache hit is served without being charged.

## Current state

`packages/ratelimit/src/middleware.ts` (~line 96-102):

```ts
const rateLimit = <Context>(limiter: LimiterResolver<Context>, name: string, options: RateLimitMiddlewareOptions<Context> = {}): Middleware<Context, Context> =>
    // Tagged PER-DISPATCH: consuming budget is an effect of the request, not of
    // the response, so a memoized answer cannot stand in for it. The builder
    // hoists the mark onto the registered function and the generated
    // `isCacheableQuery` keeps such a query out of the reactive cache — without
    // it a hit answers without running this chain at all, and one dispatch's
    // charge covered every request the memo served.
    tagPerDispatchMiddleware(async ({ ctx, next }) => {
```

with `import { tagPerDispatchMiddleware } from "@lunora/server";` at line 3.

`packages/ratelimit/src/plugin.ts` (whole function):

```ts
export const ratelimitPlugin = <Context = unknown>(
    limiter: LimiterResolver<Context>,
): Plugin<Record<never, never>, Context, Context & RatelimitApiContext<Context>> => {
    return {
        key: "ratelimit",
        middleware: async ({ ctx, next }) => {
            const resolved = typeof limiter === "function" ? await limiter(ctx) : limiter;
            const existingApi = (ctx as { api?: Record<string, unknown> }).api ?? {};

            return next({ ctx: { api: { ...existingApi, ratelimit: resolved } } }) as Promise<Context & RatelimitApiContext<Context>>;
        },
    };
};
```

Its doc comment ends: "this keeps `@lunora/server` a type-only dependency of `@lunora/ratelimit`" — already untrue, since `middleware.ts` imports a runtime value from it.

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

Wrap the plugin's middleware in `tagPerDispatchMiddleware(...)` exactly as `rateLimit` does, with a why-comment (the handler may consume budget through `ctx.api.ratelimit`, an effect of the request). Correct the doc comment's last paragraph: drop the "type-only dependency" claim. Keep the `Plugin` literal and its type parameters; if the wrapper's return type does not fit the `middleware` property type, fix the typing without a cast that hides a mismatch — if that is impossible, STOP.

## Steps

1. Find how the existing test proves the tag on `rateLimit` (`rg -n "tagPerDispatch|isPerDispatch|perDispatch" packages/ratelimit/__tests__ packages/server/src packages/server/__tests__ | head -20`).
2. Test first: the same assertion for `ratelimitPlugin(limiter).middleware`; and that the middleware still exposes the limiter on `ctx.api.ratelimit` and preserves an existing `ctx.api`. **Verify**: the tag test fails at baseline.
3. Implement; red check.
4. `rg -n "ratelimitPlugin" registry templates packages/*/docs apps/docs | head` — `pnpm run lint:registry:sync` covers vendored ratelimit copies; run it. If it reports drift, run the sync script it names and include the result.
5. Build, test, types, eslint for `@lunora/ratelimit`.

## Scope

**In scope**: `packages/ratelimit/src/plugin.ts`, a test in `packages/ratelimit/__tests__/`, vendored copies only via the sync script. **Out of scope**: `rateLimit` middleware, the limiter, `@lunora/server`.

## Git workflow

- Branch: `fix/ratelimit-plugin-dispatch-and-capacity`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(ratelimit): tag the plugin middleware per dispatch`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## Done criteria

- [ ] New test passes and was seen red
- [ ] `pnpm --filter "@lunora/ratelimit" run test`, `lint:types`, `lint:eslint` exit 0; `pnpm run lint:registry:sync` exits 0

## STOP conditions

- `tagPerDispatchMiddleware` is not exported from `@lunora/server` on this base, or the tag is not what keeps a query out of the cache (read the generated `isCacheableQuery` logic the comment names): STOP and report.

## Maintenance notes

- Behaviour change: queries using the plugin are no longer served from the reactive cache. Say so in the commit body.
