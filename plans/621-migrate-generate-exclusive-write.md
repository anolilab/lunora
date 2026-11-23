# Plan 621: `lunora migrate generate` never overwrites a migration file and commits file and snapshot together

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/cli/src/commands/migrate/handler.ts packages/cli/__tests__/commands/migrate.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** TODO

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`lunora migrate generate` diffs the schema against a snapshot and writes `lunora/migrations/<UTC yyyymmddhhmmss>_<slug>.sql`, then advances the snapshot. The file name has one-second resolution and the write has no exclusivity: two runs in the same second with the same `--name` (a script, a watch loop) make the second overwrite the first file, and because the snapshot already moved, the first diff's SQL is gone for good. Separately, the snapshot is written non-atomically _after_ the migration file; a crash or full disk between the two writes makes the next run emit the same diff again into a second file.

## Current state

`packages/cli/src/commands/migrate/handler.ts`, in `runMigrateGenerateCommand` (~lines 170-184):

```ts
const nowFunction = options.now ?? (() => new Date());
const now = nowFunction();
const slug = slugify(options.name ?? "auto");
const timestamp = formatTimestamp(now);
const filename = `${timestamp}_${slug}.sql`;
const migrationFile = join(migrationsDirectory, filename);

mkdirSync(migrationsDirectory, { recursive: true });

const body = renderMigrationFile(slug, diff, now.toISOString());

writeFileSync(migrationFile, body, "utf8");
writeFileSync(snapshotPath, `${JSON.stringify(nextSnapshot, undefined, 4)}\n`, "utf8");

options.logger.success(`wrote ${migrationFile}`);
```

The function returns `{ code, empty, error?, migrationFile }`; failures elsewhere in it log with `options.logger.error(message)` and return `{ code: EXIT_CODE.USAGE, empty: true, error: message, migrationFile: "" }`. `options.now` is an injectable clock (tests pass `now: fixedNow`).

Tests: `packages/cli/__tests__/commands/migrate.test.ts`, `describe("lunora migrate generate")` (line ~182). Pattern: write a schema into a temp `workdir`, call `runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow })`, edit the schema, call again with a later `now`. The repo already has an atomic-write helper used by the CLI — find it before writing one: `rg -n "renameSync|writeFileAtomic|atomicWrite" packages/cli/src packages/config/src | head`.

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

| Purpose                       | Command                                                                          | Expected on success |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                 | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/cli..." run build`                                       | exit 0              |
| One test file                 | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/migrate.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/cli" run test`                                           | all pass            |
| Types                         | `pnpm --filter "@lunora/cli" run lint:types`                                     | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/cli" run lint:eslint`                                    | exit 0, 0 warnings  |

## Design (decided)

1. Write the migration file with the exclusive flag: `writeFileSync(migrationFile, body, { encoding: "utf8", flag: "wx" })`. On `EEXIST`: log an error "`<filename>` already exists — a migration with this name was generated in the same second; re-run, or pass a different --name" and return `{ code: EXIT_CODE.USAGE, empty: true, error, migrationFile: "" }` **without touching the snapshot**. Any other error propagates as today.
2. Write the snapshot atomically: write to `${snapshotPath}.tmp` then `renameSync` onto `snapshotPath` (or use the existing helper if one exists in `packages/cli/src`). If the snapshot write throws, remove the just-created migration file (`rmSync(migrationFile, { force: true })`) before rethrowing, so a retry starts clean instead of duplicating the diff.

## Scope

**In scope**: `packages/cli/src/commands/migrate/handler.ts` (only `runMigrateGenerateCommand`); `packages/cli/__tests__/commands/migrate.test.ts`.

**Out of scope**: `migrate create`, `migrate apply`, the file-name format (changing it would reorder existing projects' migrations), `formatTimestamp`, `slugify`.

## Git workflow

- Branch: `fix/546-migrate-generate-exclusive` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `fix(cli): never overwrite a generated migration file`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

1. **Tests first**, in `describe("lunora migrate generate")`:
    - "refuses to overwrite a migration generated in the same second": run with `name: "init", now: fixedNow`; change the schema (add a column, as the "adding a column" test does); run again with the **same** `now` and `name`. Expect a non-zero `code`, `error` mentioning the file name, the first file's content unchanged (read it before and after), and the snapshot unchanged by the second run (read before/after).
    - "a later run after the refusal emits the pending diff": then run with a later `now` → code 0 and the new file contains the `ALTER TABLE`.
      **Verify**: the first new test fails now (red: the file is overwritten).
2. Implement Design 1 and 2. **Verify**: `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/migrate.test.ts` → all pass.
3. `pnpm --filter "@lunora/cli" run lint:types` and `run lint:eslint` → exit 0.

## Done criteria

- [ ] `rg -n 'flag: "wx"' packages/cli/src/commands/migrate/handler.ts` → 1 match
- [ ] migrate test file passes with 2 new tests; first was red before the fix
- [ ] No `.tmp` file remains in the test workdir after a successful run (assert it in a test)
- [ ] `git status --short` lists only the two in-scope files

## STOP conditions

- Excerpt mismatch.
- An existing test generates twice with the same `now` and `name` on purpose and expects success.

## Maintenance notes

- If sub-second uniqueness is ever wanted, add a numeric suffix rather than changing the timestamp format (ordering of existing files depends on it).
