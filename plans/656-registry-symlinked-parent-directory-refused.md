# Plan 656: A registry item cannot be read through a symlinked parent directory

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/cli/src/commands/registry/reconcile.ts`
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

`lunora registry add` / `registry view` copy or print files a registry item declares. Registry sources are untrusted, and `readItemFile` refuses a symlink so a hostile item cannot make the CLI read a host file:

```ts
 * Refuses to read through a symlink: a hostile registry source could ship a
 * symlink at a manifest-declared `file.from` path and have the CLI read
 * through it — printing (`view`) or writing into the project (`add`) whatever
 * host file the link targets, e.g. `~/.ssh/id_rsa`. Registry manifests declare
 * each file explicitly, so refusing (rather than `init`'s silent skip) is
 * correct here: skipping would silently produce a broken install.
 *
 * Exported so `registry view` reads item files through the same guard — a
 * pasted copy of it drifted from this one once already.
 */
const readItemFile = (itemDirectory: string, file: RegistryFile, useUmbrella: boolean, itemKey: string): string => {
    const sourcePath = join(itemDirectory, file.from);

    if (lstatSync(sourcePath).isSymbolicLink()) {
        throw new LunoraError("INTERNAL", `registry item "${itemKey}": refusing to read "${file.from}" — it is a symlink, not a regular file`);
    }

    const source = readFileSync(sourcePath, "utf8");

    return useUmbrella && CODE_FILE_RE.test(file.to) ? rewriteUmbrellaImports(source) : source;
};
```

`lstatSync` looks only at the **last** path segment. If `file.from` is `dir/name` and `dir` is a symlink, the file is read through the link — `view` prints it (no confirmation at all) and `add` writes it into the project. The manifest check (`manifest.ts` ~90) only rejects `..` and a leading `/`. The SDK vendoring code already walks every parent for exactly this case:

```ts
// An entry such as Ruby's `lib/lunora.rb` reaches through `lib`: a linked
// `lib` would let the walk below read outside the transport.
const parents = entry.from.split("/").slice(0, -1);

for (let depth = 1; depth <= parents.length; depth += 1) {
    const parent = join(sourceRoot, ...parents.slice(0, depth));

    if (lstatSync(parent).isSymbolicLink()) {
        throw new LunoraError("INTERNAL", `refusing to vendor "${relative(sourceRoot, parent)}" — it is a symlink, not a directory`);
    }
}

assertNoSymlinks(sourceRoot, source);
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

| Purpose                       | Command                                                                                         | Expected on success |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                                | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/cli..." run build`                                                      | exit 0              |
| One test file                 | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/registry-symlink-guard.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/cli" run test`                                                          | all pass            |
| Types                         | `pnpm --filter "@lunora/cli" run lint:types`                                                    | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/cli" run lint:eslint`                                                   | exit 0, 0 warnings  |

Note: the full `@lunora/cli` suite is slow and has shown 1–2 unrelated flaky failures under load. Run the touched test files directly.

## Design (decided)

Make `readItemFile` refuse when **any** segment of `file.from` below `itemDirectory` is a symlink (walk the parents as `vendor.ts` does, then the file itself), with the same error wording naming the offending segment. If `vendor.ts` exposes a reusable helper (`assertNoSymlinks`), read it and reuse it only if its semantics match (same root-relative walk); otherwise a local loop is fine — do not create a shared abstraction for two call sites that differ. Also check `itemDirectory` resolution itself: if an item directory inside the source can be a symlink (`rg -n "itemDirectory" packages/cli/src/commands/registry | head -20`), refuse that too, relative to the registry source root.

## Steps

1. Tests first in `packages/cli/__tests__/commands/registry-symlink-guard.test.ts` (it links the final file today): link a **parent directory** to a directory outside the item and declare `from: "dir/secret.txt"` → `view` and `add` both refuse and nothing is printed or written; a normal nested file still works. Red at baseline. 2. Implement. 3. Build `@lunora/cli...`, run that test file and the other registry test files, types, eslint.

## Git workflow

- Branch: `fix/cli-hardening-audit-round-5`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(cli): refuse a registry file behind a linked directory`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- First-party registry items (`registry/*`) contain a symlinked directory that the guard would now refuse: STOP and list them.
