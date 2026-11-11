# Plan 558 — Keep a Convex directory import inside the snapshot for table files

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and
> confirm the expected result before moving on. Touch only the files listed under "In scope".
> If any STOP condition occurs, stop and report; do not improvise. Do not update
> `plans/README.md` (your reviewer maintains it).
>
> **Drift check (run first):**
> `git diff --stat 36c32cc1b..HEAD -- packages/cli/src/commands/convex-snapshot.ts packages/cli/__tests__/commands/convex-snapshot.test.ts packages/cli/src/util/path-containment.ts`
> Expected: no output. If either file changed, compare the excerpts in §1 with the live code;
> any mismatch is a STOP condition.

**Baseline:** `36c32cc1b` (2026-11-11)
**Status:** TODO
**Priority / Effort / Risk:** P2 / S / LOW. **Category:** security. **Depends on:** none.
**Finding:** audit 2026-11-11, row 28.

## 0. Headline finding

`lunora import` of an exploded Convex export directory follows a symlinked
`<table>/documents.jsonl` to any file on the machine and streams it in as rows. The same
module already refuses that for `_storage` blobs, with `realpath` and a containment check,
because export contents are operator-downloaded data and not authored by the operator. Table
files get no such check.

## 1. Current state (audit)

`packages/cli/src/commands/convex-snapshot.ts` (218 lines). Relevant code:

- `:90-110`, `listDirectoryTables`:

    ```ts
    const listDirectoryTables = async (root: string): Promise<ConvexSnapshotTable[]> => {
        const found: ConvexSnapshotTable[] = [];

        for (const entry of await readdir(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }

            const file = join(root, entry.name, "documents.jsonl");

            // eslint-disable-next-line no-await-in-loop -- one cheap stat per table directory; the set is small
            const documents = await stat(file).catch(() => undefined);

            if (documents?.isFile()) {
                found.push({ file, table: entry.name });
            }
        }

        return found;
    };
    ```

    `stat` follows symlinks, so a `documents.jsonl` that is a link to `/etc/...` or `~/.ssh/...`
    reports `isFile() === true` and is listed. (`entry.isDirectory()` on a `Dirent` is `false`
    for a symlinked directory, so a symlinked table _directory_ is already skipped. Only the file
    inside a real directory is the gap.)

- `:144-151`, `readSnapshotLines` (directory branch) opens `tableEntry.file` with
  `createReadStream`. Every row of the linked file becomes an import row sent to the target
  deployment.

- `:185-206`, `readSnapshotStorageBlob`, is the guard to copy:

    ```ts
    if (snapshot.kind === "directory") {
        const storageRoot = await realpath(join(snapshot.root, "_storage"));
        const blobPath = await realpath(resolve(storageRoot, blobId)).catch(() => undefined);

        if (blobPath === undefined || !isInsideDirectory(storageRoot, blobPath)) {
            throw new Error(`blob ${blobId} resolves outside the snapshot's _storage directory`);
        }

        return readFile(blobPath);
    }
    ```

- `packages/cli/src/util/path-containment.ts` exports `isInsideDirectory(root, candidate)` as
  the file's default export. Its docblock says: **both arguments must be canonical
  (`realpath`) where symlinks matter**. Canonicalising only the candidate rejects a legitimate
  snapshot whose root sits behind a link. On macOS `os.tmpdir()` is itself under a link
  (`/var` → `/private/var`), so tests catch this mistake.

- Callers of `listConvexSnapshotTables`: `packages/cli/src/commands/data-transfer/import-source.ts:291`.
  `readSnapshotLines` is also called from `storage-blobs.ts:135` and `storage-mapping.ts:117`
  with the entries this listing returns, so fixing the listing covers all three readers.

- ZIP snapshots (`listZipTables`, `:113-130`) read entry bytes from the archive and never touch
  the filesystem by entry name. Not affected.

Siblings already checked and found safe (do **not** change them): the Supabase and Firebase
directory readers go through `sources/dump-directory.ts:65`, which keeps only
`entry.isFile()` dirents (false for a symlink), and `sources/storage-transfer.ts:196-199`
walks with `Dirent.isDirectory()` / `isFile()`.

## 2. Existing seams (do not reinvent)

- `isInsideDirectory` from `../util/path-containment` (already imported in this file).
- `realpath` from `node:fs/promises` (already imported in this file).
- The test file `packages/cli/__tests__/commands/convex-snapshot.test.ts` already has
  `buildDirectory`, a per-test `workDir` and `symlink` imported. Its blob test
  "refuses a blob that is a symlink pointing out of _storage" (around line 299) is the
  pattern for the new test.

## 3. The behavioural contract to preserve

- Every existing test in `convex-snapshot.test.ts` keeps passing unchanged.
- A normal export (real files, no links) lists the same tables in the same sorted order.
- A snapshot whose **root path** is reached through a symlink still lists its tables.
- No public export changes (`convex-snapshot.ts` is internal to `@lunora/cli`), so there is
  no `api-snapshots/` change and `api:check` is not needed.

## 4. Design decisions

- **Throw, do not skip.** A `documents.jsonl` that resolves outside the snapshot root makes
  `listDirectoryTables` throw
  `` `table ${entry.name}: documents.jsonl resolves outside the snapshot directory` ``. That
  matches the blob guard, which throws. Skipping silently would import a partial snapshot
  and report success. Rejected alternative: skip with a warning.
- **Containment is against the canonical snapshot root**, not the table directory. That is the
  same scope as the blob guard (`_storage`) and is enough for the threat model: the reader
  must not leave the export. A link to another file _inside_ the export stays allowed.
- **Store the canonical path** in `ConvexSnapshotTable.file`, so `readSnapshotLines` opens the
  path that was checked, not the link.
- Rejected alternative: refusing any symlink with `lstat`. That is stricter than the blob
  guard and would refuse links inside the export, for no gain under this threat model.

## 5. Workstreams

Single workstream (S). Steps below.

## 6. Platform parity

Not applicable: CLI-only change, no `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work              | Gate                                                                     |
| ----- | ----------------- | ------------------------------------------------------------------------ |
| 0     | Install, build    | `pnpm install` exit 0; `pnpm --filter "@lunora/cli..." run build` exit 0 |
| 1     | Tests first (red) | new symlink test FAILS on unchanged code                                 |
| 2     | Fix               | `convex-snapshot.test.ts` all green                                      |
| 3     | Gates             | `lint:types`, `lint:eslint`, full `@lunora/cli` tests green              |

## Commands you will need

Run every command from the worktree root you were given (prefix each shell call with
`cd <worktree> &&`).

| Purpose                        | Command                                                                                                                | Expected on success               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Install                        | `pnpm install`                                                                                                         | exit 0 (can take several minutes) |
| Build the package and its deps | `pnpm --filter "@lunora/cli..." run build`                                                                             | exit 0                            |
| One test file                  | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/convex-snapshot.test.ts`                               | all pass                          |
| Package tests                  | `pnpm --filter "@lunora/cli" run test`                                                                                 | all pass                          |
| Types                          | `pnpm --filter "@lunora/cli" run lint:types`                                                                           | exit 0                            |
| Format                         | `pnpm exec oxfmt packages/cli/src/commands/convex-snapshot.ts packages/cli/__tests__/commands/convex-snapshot.test.ts` | exit 0                            |
| Lint (after format)            | `pnpm --filter "@lunora/cli" run lint:eslint`                                                                          | exit 0, 0 warnings                |

**Forbidden** (they crash the machine when several worktrees run them at once): `pnpm run build`,
`pnpm run build:packages`, `pnpm run test` at the repo root, `pnpm run test:workerd`,
any `pnpm -r …`. The workerd suite is not needed here: no SQL, storage or Durable Object
code changes.

## Scope

**In scope** (the only files you may modify):

- `packages/cli/src/commands/convex-snapshot.ts`
- `packages/cli/__tests__/commands/convex-snapshot.test.ts`

**Out of scope** (do not touch even though they look related):

- `packages/cli/src/util/path-containment.ts`: correct as is.
- `packages/cli/src/commands/data-transfer/**` (including `sources/*`): checked, already safe.
- `listZipTables` and the ZIP branch of `readSnapshotLines`: not affected.
- `plans/**`, `api-snapshots/**`, any `CHANGELOG.md`.

## Git workflow

- You are on branch `security/improve-558-convex-table-containment` in a dedicated worktree.
  Do not create or switch branches.
- One commit at the end, staging explicit paths only (`git add <path> <path>`; never
  `git add -A`, `git commit -a` or `git stash`).
- Message (conventional commit, header ≤ 100 chars, body lines ≤ 100 chars):

    ```
    security(cli): keep convex table reads inside the snapshot directory

    A directory import now resolves each <table>/documents.jsonl with realpath and refuses
    one that lands outside the export, as blob reads already do.
    ```

    Add any attribution trailer your own environment requires, after a blank line.

- The pre-commit hook formats and lints staged files and builds their deps. If the hook fails,
  read its output, fix the reported problem in an in-scope file, and commit again. Never use
  `--no-verify`. If the hook fails twice for a reason outside the in-scope files, STOP.
- Do not push. Do not open a PR.

## Steps

### Step 1: Install and build

Run `pnpm install`, then `pnpm --filter "@lunora/cli..." run build`.

**Verify:** both exit 0.

### Step 2: Write the failing tests first

In `packages/cli/__tests__/commands/convex-snapshot.test.ts`, inside
`describe("listConvexSnapshotTables", …)`, add two tests. Follow the file's style:
`expect.assertions(n)` first, `buildDirectory(...)` for fixtures, `workDir` for outside files.

1. `it("refuses a documents.jsonl that is a symlink pointing outside the snapshot", …)`:
    - `const root = await buildDirectory({ users: "{}\n" });`
    - write `join(workDir, "outside.jsonl")` with content `"{\"leaked\":true}\n"`;
    - `await mkdir(join(root, "evil"), { recursive: true });`
    - `await symlink(join(workDir, "outside.jsonl"), join(root, "evil", "documents.jsonl"));`
    - `await expect(listConvexSnapshotTables({ kind: "directory", root })).rejects.toThrow(/resolves outside the snapshot directory/);`
2. `it("lists a snapshot whose root is reached through a symlink, with canonical file paths", …)`:
    - `const root = await buildDirectory({ users: "{}\n" });`
    - `const linked = join(workDir, "linked-export"); await symlink(root, linked);`
    - `const found = await listConvexSnapshotTables({ kind: "directory", root: linked });`
    - assert `found?.map((entry) => entry.table)` equals `["users"]`;
    - assert `found?.[0]?.file` equals `await realpath(join(root, "users", "documents.jsonl"))`
      (import `realpath` from `node:fs/promises` alongside the existing imports).

Add `realpath` to the existing `node:fs/promises` import. Do not add a second import line for
the same module.

**Verify (must be RED):**
`pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/convex-snapshot.test.ts`
→ test 1 FAILS (the promise resolves instead of rejecting); test 2 FAILS on the `file`
assertion (the unfixed code stores the non-canonical path). Every other test passes. Record the
failure output in your report. If test 1 passes here, STOP: the premise is wrong.

### Step 3: Implement the guard

In `listDirectoryTables` (`convex-snapshot.ts`):

- Before the loop: `const canonicalRoot = await realpath(root);`
- Keep the `readdir`, the `isDirectory()` filter and the `stat(...).catch(() => undefined)`
  existence check as they are.
- When `documents?.isFile()` is true, resolve `const canonicalFile = await realpath(file);`
  (inside the loop; reuse a line-scoped `no-await-in-loop` disable with a reason, like the one
  above it). If `!isInsideDirectory(canonicalRoot, canonicalFile)`, throw
  `new Error(\`table ${entry.name}: documents.jsonl resolves outside the snapshot directory\`)`.
Otherwise push `{ file: canonicalFile, table: entry.name }`.
- Update the function's one-line doc comment to say why: the export is operator-downloaded data,
  so a table file is held to the same containment rule as a blob (name `readSnapshotStorageBlob`).
  Keep it to two or three lines. No `.js` import extensions, no new exports.

**Verify:** `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/convex-snapshot.test.ts`
→ all tests pass, including both new ones.

### Step 4: Gates

Run, in order: Format (oxfmt on both files), `lint:types`, `lint:eslint`, package tests.

**Verify:** each exits 0; `pnpm --filter "@lunora/cli" run test` reports no failures.

### Step 5: Commit

Stage exactly the two in-scope files and commit with the message above.

**Verify:** `git status --porcelain` is empty and
`git diff --stat 36c32cc1b..HEAD` lists only the two in-scope files.

## Test plan

- New: the two tests in Step 2, in `packages/cli/__tests__/commands/convex-snapshot.test.ts`,
  modelled on "refuses a blob that is a symlink pointing out of _storage" in the same file.
- Red-without-fix: Step 2's verification is the required "test must fail without the fix" check.
- Regression: the whole `@lunora/cli` suite (`data-transfer` import tests read through
  `listConvexSnapshotTables`).

## Done criteria (all must hold)

- [ ] `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/convex-snapshot.test.ts` passes, with the 2 new tests
- [ ] `pnpm --filter "@lunora/cli" run test` exits 0
- [ ] `pnpm --filter "@lunora/cli" run lint:types` exits 0
- [ ] `pnpm --filter "@lunora/cli" run lint:eslint` exits 0
- [ ] `grep -nE "realpath\(root\)|isInsideDirectory\(canonicalRoot" packages/cli/src/commands/convex-snapshot.ts` shows both
- [ ] `git diff --stat 36c32cc1b..HEAD` lists only the two in-scope files

## 8. Risks & STOP conditions

- **STOP** if the Step 2 symlink test passes before the fix (the reader is already guarded
  some other way; report what you see).
- **STOP** if an existing test in `packages/cli` fails after the fix because it relied on a
  non-canonical `file` path. Report the test name; do not edit other test files.
- **STOP** if a fix appears to need a change in `data-transfer/**` or `path-containment.ts`.
- **STOP** if a step's verification fails twice after a reasonable fix attempt.
- **Risk:** time-of-check/time-of-use between listing and reading. Accepted: the reader opens
  the canonical path, so a swap needs write access to the export _during_ the import, which is
  outside this threat model.

## 9. Open questions

1. None for execution. Maintenance note: any new reader of an exploded export directory must
   apply the same `realpath` + `isInsideDirectory` pair to both sides, or filter on
   `Dirent.isFile()` as `dump-directory.ts` does.
