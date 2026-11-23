# Plan 657: `init --here` exits non-zero when it cannot scaffold `lunora/`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/cli/src/commands/init/handler.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`lunora init --here` (in-place init) writes `lunora/schema.ts` and a sample function. When a write fails it logs and carries on:

```ts
const written: string[] = [];

try {
    mkdirSync(lunoraDirectory, { recursive: true });
    writeFileSync(schemaPath, SAMPLE_SCHEMA, "utf8");
    written.push(schemaPath);

    const functionPath = join(lunoraDirectory, "messages.ts");

    // The function file is only written when missing so a hand-edited one is
    // never clobbered on a re-run.
    if (!existsSync(functionPath)) {
        writeFileSync(functionPath, SAMPLE_FUNCTION, "utf8");
        written.push(functionPath);
    }

    logger.success(`scaffolded lunora/ (${String(written.length)} file(s))`);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`init --here: could not scaffold lunora/: ${message}`);
}

return written;
```

and `runInPlaceInit` (~1276-1282) returns `{ code: 0, … }` regardless. Scripts and CI see success with no schema; later steps (`--add`, the CI pipeline step) run on that result. The step right next to it — the vite-config edit — does fail the command through `inPlaceIoFailure` (~1064-1082). A partial write is also stuck: if `schema.ts` was written and the function file failed, a re-run sees `schema.ts` (~1131) and skips the directory, so the function file is never created.

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

| Purpose                       | Command                                                                            | Expected on success |
| ----------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                   | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/cli..." run build`                                         | exit 0              |
| One test file                 | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/init-here.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/cli" run test`                                             | all pass            |
| Types                         | `pnpm --filter "@lunora/cli" run lint:types`                                       | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/cli" run lint:eslint`                                      | exit 0, 0 warnings  |

Note: the full `@lunora/cli` suite is slow and has shown 1–2 unrelated flaky failures under load. Run the touched test files directly.

## Design (decided)

Treat a scaffold write failure like the vite-config failure: return a non-zero result through the same `inPlaceIoFailure` path (read it and reuse its shape and message style), and do not run the later steps. Fix the re-run trap: the skip decision must be per file, not "schema.ts exists ⇒ skip everything" — each of the two files is written only when missing, so a re-run after a partial failure completes the directory and never overwrites a file the user has edited.

## Steps

1. Tests first in `init-here.test.ts`: make the function-file write fail (follow how that file stubs the filesystem or use a read-only directory the way existing failure tests do) → exit code non-zero, an error line, no `--add`/CI step run; then a re-run with the failure removed creates the missing file and leaves the existing `schema.ts` byte-identical. Red at baseline. 2. Implement. 3. Build, the init test files, types, eslint.

## Git workflow

- Branch: `fix/cli-hardening-audit-round-5 (same branch, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(cli): fail init --here when scaffolding lunora fails`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- A test or comment says the scaffold is deliberately best-effort: STOP and report it.
