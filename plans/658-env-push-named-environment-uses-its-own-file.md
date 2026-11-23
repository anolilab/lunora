# Plan 658: `env push --env <name>` does not upload local dev secrets to a named environment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/cli/src/commands/env/handler.ts packages/cli/src/commands/deploy/secrets.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/cli-hardening-audit-round-5`, PR #1662

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`lunora env push` uploads the keys in `.dev.vars` as Worker secrets. With `--env <name>` (or `--prod`, which maps to `production`) it still reads the bare `.dev.vars`:

```ts
const runEnvCommand = async (options: EnvCommandOptions): Promise<EnvCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const context: EnvContext = {
        cwd,
        devVariablesPath: join(cwd, DEV_VARS_FILE),
        // In json mode every human line moves to stderr so stdout carries only
        // the result document.
        logger: options.logger,
        options,
```

and pushes every key to that environment. The deploy command was designed around the opposite rule — it refuses to promote a weak local dev value into a production credential, and records secrets it generates for a named environment in a sibling file precisely so they are not shared with local dev:

```ts
 * (Cloudflare secrets are write-only) is worse than not writing at all. A
 * no-op (returning `undefined`) when nothing was minted.
 *
 * Which file depends on `options.env`:
 * - No explicit `--env`: the deploy targets the account's one default environment — the same one `.dev.vars`/`lunora dev`/a plain `lunora env push` already treat as authoritative — so the minted value goes into `.dev.vars` itself, same as `env set`/`env generate --set` would.
 * - An explicit `--env <name>`: a DIFFERENT, named environment. Writing that secret into the bare, environment-agnostic `.dev.vars` would silently share it with local dev and with a later no-`--env` `env push` — the exact cross-environment leak an `--env`-scoped deploy is supposed to avoid. So it goes into a sibling `.dev.vars.<name>` instead, after {@link ensureDevVariablesIgnored} has made that filename un-committable. No other command reads `.dev.vars.<name>` today — it exists purely as this deploy's own recoverable record of a value `wrangler secret put` can never return; open it by hand to retrieve the value.
 *
 * Returns the (relative) filename written, or `undefined` when nothing was
 * recorded — the caller threads this through the deploy result so the
```

Yet deploy's own hint tells the operator to run `lunora env push --yes --env …` (`secrets.ts` ~454). Following it overwrites the production secrets deploy just generated — `LUNORA_ADMIN_TOKEN`, `AUTH_SECRET` — with the developer's local values: every session is invalidated and the production admin token becomes the local one. The docs describe today's behaviour ("push .dev.vars to one environment", `apps/docs/src/content/docs/concepts/environments.mdx` ~35, `production-checklist.mdx` ~51), so this is a behaviour change, decided here.

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

| Purpose                       | Command                                                                 | Expected on success |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                        | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/cli..." run build`                              | exit 0              |
| One test file                 | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/cli" run test`                                  | all pass            |
| Types                         | `pnpm --filter "@lunora/cli" run lint:types`                            | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/cli" run lint:eslint`                           | exit 0, 0 warnings  |

Note: the full `@lunora/cli` suite is slow and has shown 1–2 unrelated flaky failures under load. Run the touched test files directly.

## Design (decided)

1. With an explicit environment (`--env <name>` / `--prod`), `env push` reads `.dev.vars.<name>` — the file deploy already writes for that environment. If it does not exist, the command fails with a message that names the file, says why the bare `.dev.vars` is not used for a named environment, and how to proceed (create the file, or pass the new flag below).
2. An explicit opt-in keeps the old behaviour for people who want it: `--from-dev-vars` (name it to match the CLI's existing flag style — check the other `env` flags) pushes the bare `.dev.vars` to the named environment, and still refuses the keys deploy treats as must-not-be-weak in production (reuse the check in `deploy/secrets.ts` ~129-138 rather than re-implementing it).
3. No `--env`: unchanged (bare `.dev.vars`).
4. Other `env` subcommands that take `--env` and read or write the file (`env set`, `env pull`, `env diff`, `env generate --set` — read `runEnvCommand`) must agree with push about which file a named environment uses; change them in the same commit or state per subcommand why it differs.
5. Fix deploy's hint (~454) so the command it prints does the right thing, and update `environments.mdx`, `production-checklist.mdx` and the CLI docs. Make sure `.dev.vars.<name>` is git-ignored wherever `env` may create it (`ensureDevVariablesIgnored`).

## Steps

1. Read `runEnvCommand` and every subcommand's file handling; list which read/write which file today. 2. Tests first in the env command tests (`rg -ln "runEnvPush|env push" packages/cli/__tests__`): `--env production` with only a bare `.dev.vars` → non-zero, nothing pushed, message names the file; with `.dev.vars.production` → its keys pushed and none from the bare file; `--from-dev-vars` pushes the bare file but refuses a weak must-be-strong key; no `--env` unchanged. Red at baseline. 3. Implement. 4. Docs and hint. 5. Build, the env and deploy test files, types, eslint.

## Git workflow

- Branch: `fix/cli-hardening-audit-round-5 (same branch, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(cli): keep env push off dev secrets for a named env`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- A first-party template, example or CI workflow runs `env push --env …` expecting the bare file (`rg -n "env push" templates examples .github apps/docs packages/*/docs | head -20`): update docs/templates in the same commit; if a workflow in `.github` depends on it, STOP and report.

## Maintenance notes

- Breaking for scripts that push `.dev.vars` to a named environment; commit body carries `BREAKING CHANGE:` with the opt-in flag.
