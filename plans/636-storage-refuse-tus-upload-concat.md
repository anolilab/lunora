# Plan 636: The upload route refuses TUS `Upload-Concat`, so one caller cannot assemble a file from another caller's upload

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/storage/src/tus-route-policy.ts packages/storage/src/upload-handler.ts`
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
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`createUploadHandler` (`@lunora/storage`) leaves upload ownership to the app's `authorize` gate. A TUS `POST` carrying `Upload-Concat: final;<url> <url>` names **other** uploads in a header, not in the request URL, so a gate that checks ownership by URL admits it, and caller B can build a finished file out of caller A's partial upload (verified in commit `c6d2dea00` on branch `security/storage-upload-id-owner`: the route answered 201). The docs now tell apps to refuse it in their gate; this plan makes the route refuse it for every app. The storage providers `createR2UploadStorage` and the memory provider advertise the `concatenation` extension; `createR2BindingUploadStorage` already filters it out. `@visulima/storage-client` never sends `Upload-Concat`.

## Current state

Read `packages/storage/src/tus-route-policy.ts` and how `upload-handler.ts` uses it (`checkBeforeGate`, `routePolicy`, `policy.finish`). The policy already refuses `Upload-Checksum` — find that code (`rg -n -i "checksum" packages/storage/src/tus-route-policy.ts packages/storage/src/upload-handler.ts`) and mirror it exactly: same refusal status/shape, same place in the flow (before the gate). Also find where the advertised `Tus-Extension` header is produced or passed through (`rg -n -i "Tus-Extension|extension" packages/storage/src`).

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
| Build package + its deps      | `pnpm --filter "@lunora/storage..." run build`                                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/storage" exec vitest run __tests__/upload-handler.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/storage" run test`                                         | all pass            |
| Types                         | `pnpm --filter "@lunora/storage" run lint:types`                                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/storage" run lint:eslint`                                  | exit 0, 0 warnings  |

## Design (decided)

1. Refuse any TUS request that carries an `Upload-Concat` header (both `partial` and `final`), before `authorize` runs, the way `Upload-Checksum` is refused.
2. Remove `concatenation` (and `concatenation-unfinished` if present) from the `Tus-Extension` list the route advertises on `OPTIONS`/responses, so clients do not attempt it.
3. Update the docs added in `c6d2dea00` (`packages/storage/docs/index.mdx`, `apps/docs/src/content/docs/concepts/file-storage.mdx`): the route refuses concatenation, so the gate example no longer needs its own `Upload-Concat` check — remove that check from the examples and say the route refuses it. Adjust the test added in that commit that seeds a partial upload through a second, ungated handler: it must now assert the route's refusal instead.

## Steps

1. Test first in `packages/storage/__tests__/upload-handler.test.ts`: with **no** `authorize` ownership logic at all (a gate that admits everyone), a TUS `POST` with `Upload-Concat: partial` and one with `Upload-Concat: final;<url>` are refused, and `authorize` was not called; `OPTIONS` (or wherever extensions are advertised) no longer lists concatenation. **Verify**: red at baseline.
2. Implement Design 1–2. 3. Docs and existing test (Design 3). 4. Build, test, types, eslint for `@lunora/storage`; `pnpm exec prettier --check` on edited mdx.

## Scope

**In scope**: `tus-route-policy.ts`, `upload-handler.ts` only as far as wiring needs, tests, the two docs files. **Out of scope**: `@visulima/storage`; chunked-REST; multipart.

## Git workflow

- Branch: `security/storage-upload-id-owner (EXISTING branch, already pushed with one docs commit — check it out, do not create it; add one new commit on top)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(storage): refuse tus upload concatenation`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- `Upload-Checksum` is not refused by a route policy on this base (nothing to mirror): STOP and report what you found.
- A first-party caller (registry, templates, examples, another package) sends `Upload-Concat`: STOP and report it.
