# Plan 633: A resumable upload can only be continued by the caller that created it (investigate, then fix)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/storage/src/upload-handler.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** BY DESIGN for ownership (the app's `authorize` gate owns it; docs and tests added). The `Upload-Concat` hole found on the way is fixed by plan 636. PR #1645

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`createUploadHandler` (`packages/storage/src/upload-handler.ts`) mounts TUS / chunked-REST resumable uploads behind an app-supplied `authorize` gate that runs on every request (create, chunk `PATCH`, resume `HEAD`, `DELETE`). The suspicion: nothing ties an upload id to the caller that created it, so any caller `authorize` admits can append to, probe or terminate another caller's in-flight upload if it knows or picks the id (for chunked-REST the client chooses the name). **Unconfirmed**: this rests on a subagent's reading; the plan author only confirmed that `authorize` receives `{ method, protocol, request, url }` and may return a grant carrying a `Context`, and that the handler itself stores no owner.

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

| Purpose                       | Command                                                            | Expected on success |
| ----------------------------- | ------------------------------------------------------------------ | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                   | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/storage..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/storage" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/storage" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/storage" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/storage" run lint:eslint`                  | exit 0, 0 warnings  |

## Steps

1. Read `upload-handler.ts` fully (grant / `UploadContext` / `activeGrant`, `runGate`, `admitted`, `putCreateId`) and the package docs for the upload handler. Write down, with file:line, whether the docs tell the app to bind ids to users inside `authorize`, and whether the handler gives `authorize` enough to do so (the upload id of the request).
2. Test first, with the memory storage provider the existing tests use: caller A creates an upload; caller B (a different identity that `authorize` also admits) sends `PATCH`, `HEAD` and `DELETE` for A's id. Assert B is refused (404 or 403 — pick the one that does not reveal the id exists; say which).
3. If the test already passes: keep it as a pin, commit as `test(storage): pin upload ids to their creator`, report NOT REPRODUCED.
4. If it fails, fix inside the existing contract, with no new required option: let the grant carry an optional owner key (a string the app's `authorize` returns, e.g. the user id); when a create request is admitted with an owner key, record it with the upload (use the storage provider's upload metadata if it has one); on every later request for that id, refuse when the admitted grant's owner key differs or is missing. Uploads created without an owner key behave as today. Document it in the package docs next to `authorize`, with the recommendation to always return one.
5. Build, test, types, eslint for `@lunora/storage`.

## Scope

**In scope**: `packages/storage/src/upload-handler.ts`, its tests, its docs, `api-snapshots/storage.api.md` if an exported type gains an optional field (update that one snapshot by hand and say so). **Out of scope**: `@visulima/storage` itself; signed URLs; `ctx.storage`.

## Git workflow

- Branch: `security/storage-upload-id-owner`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(storage): bind a resumable upload to its creator`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- The provider offers no per-upload metadata and binding would need a new store or a new host contract: STOP and report the options; commit only the failing test marked with `it.todo` — no: commit nothing, and include the test in your report instead.
- The docs already state that id ownership is the app's job and `authorize` can enforce it today (it can see the id): then make no runtime change; improve the docs with a worked `authorize` example and report BY DESIGN.
