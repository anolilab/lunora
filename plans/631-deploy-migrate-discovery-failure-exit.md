# Plan 631: `deploy --migrate` fails when migration discovery throws

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/cli/src/commands/deploy/post-deploy.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/cli-deploy-migrate-discovery-exit`; PR #1642

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`lunora deploy --migrate` runs data migrations against the freshly deployed worker. If discovering the migrations in `lunora/` throws (a syntax error, an unreadable file), the command logs a warning, skips every migration and **exits 0**. A CI pipeline then reports a successful deploy-and-migrate while the new code runs against unmigrated data. A flag that asks for migrations must not succeed without running them.

## Current state

`packages/cli/src/commands/deploy/post-deploy.ts`, in `runPostDeployMigrations` (~lines 63-90):

```ts
const runPostDeployMigrations = async (options: DeployCommandOptions, cwd: string): Promise<number> => {
    const sqlCode = await runPostDeploySqlMigrations(options, cwd);

    if (sqlCode !== 0) {
        return sqlCode;
    }

    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const lunoraDirectory = join(cwd, "lunora");
    let migrations: ReadonlyArray<{ id: string; table: string }>;

    try {
        migrations = discoverMigrations(project, lunoraDirectory);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.warn(`--migrate: could not discover migrations (${message}); skipping`);

        return 0;
    }

    if (migrations.length === 0) {
        options.logger.info("--migrate: no data migrations declared in lunora/");

        return 0;
    }
```

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

Note: the full `@lunora/cli` suite is slow and has shown 1–2 unrelated flaky failures under load. Run the deploy-related test files directly; if you run the full suite and unrelated tests fail, re-run those files alone and report both results.

## Design (decided)

In the `catch`: log with `options.logger.error` — `--migrate: could not discover migrations (<message>); no migration was run` — and return `1`. Keep "no migrations declared" as exit 0. Before changing it, read `discoverMigrations` (find it with `rg -n "discoverMigrations" packages/cli/src`) and write down what makes it throw. If a **missing `lunora/` directory** throws rather than returning an empty list, that case must stay exit 0 with an info line (nothing to migrate): detect it explicitly (directory absent) before calling discovery, not by matching the error message.

## Steps

1. Read `discoverMigrations` and the caller of `runPostDeployMigrations` (how its return code becomes the process exit code; whether the deploy itself has already happened — it has, so the message must not suggest the deploy failed).
2. Tests first in the existing post-deploy test file (`rg -ln "runPostDeployMigrations|--migrate" packages/cli/__tests__`): discovery throws → returns 1 and logs an error containing "no migration was run"; no `lunora/` directory → 0; empty list → 0. Follow that file's way of stubbing discovery. **Verify**: the first is red at baseline.
3. Implement; red check.
4. Docs: `rg -n "\-\-migrate" packages/cli/docs packages/cli/README.md apps/docs/src --glob '*.md*' | head` — if any text says discovery problems are skipped, correct it.
5. Build, the touched test files, types, eslint for `@lunora/cli`.

## Scope

**In scope**: `post-deploy.ts`, its test file, docs lines about `--migrate`. **Out of scope**: SQL migrations (`runPostDeploySqlMigrations`), `migrate` commands, the deploy handler.

## Git workflow

- Branch: `fix/cli-deploy-migrate-discovery-exit`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(cli): fail deploy --migrate when discovery throws`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## Done criteria

- [ ] New tests pass; the throw case was seen red
- [ ] Touched test files pass; `lint:types`, `lint:eslint` for `@lunora/cli` exit 0

## STOP conditions

- An existing test asserts exit 0 on a discovery throw **with a comment explaining why** (not just pinning current behaviour): STOP and report the reason given.

## Maintenance notes

- Behaviour change for CI users: a broken `lunora/` now fails the command after the deploy step. Say so in the commit body.
