# Plan 569 — SDK regeneration stamps what it produced and removes what it no longer produces

**Baseline:** `8e435c6bc` (tip of `fix/improve-568-sdk-source-ref`, PR #1561; stacked on it because
both change `vendor.ts`). `packages/cli/src/commands/sdk` is otherwise unchanged on alpha `4121b67cc`.
**Status:** TODO (owner decision recorded 2026-11-12, see section 4)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**: `git log --oneline -1` must show `8e435c6bc`.

Finding row 27 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

`lunora sdk generate` never deletes anything in its output directory, so a transport file removed
upstream, or a generated file the emitter no longer writes, survives every regeneration (Go compiles
every `.go` file in the package). The stamp `lunora-transport.json` lists whatever is on disk under
each vendored destination, so on the second Dart run it records the generated `lib/lunora_api.dart`
and `lib/models.dart` as transport files. And for targets with two vendor entries (Rust, Ruby), a
symlink refused in the second entry leaves the first already copied.

## 1. Current state (audit)

- `packages/cli/src/commands/sdk/vendor.ts`:
    - `walk(directory)` (lines ~50-58): every file, relative, sorted.
    - `assertNoSymlinks(sourceRoot, current)` (lines ~86-104): refuses a symlink, skips test files.
    - `copyEntry(sourceRoot, outputDirectory, from, to)` (lines ~108-130): `assertNoSymlinks` for
      THIS entry, `cpSync(..., { filter: !isTestFile, force: true, recursive: true })`, then returns
      `walk(destination)` mapped to `${to}/…` — the destination, not the source.
    - `vendorAtRef` / `vendorFromLocal` call `target.vendor.flatMap((entry) => copyEntry(...))`, so
      scan and copy interleave per entry.
    - `VendorResult { files; ref; source; versionMatched }`; `writeStamp(outputDirectory, language, result)`
      (lines ~296-312) writes `{ cliVersion, files, language, note, ref, source, versionMatched }`.
    - Exports: `STAMP_FILE`, `vendorTransport`, `writeStamp`.
- `packages/cli/src/commands/sdk/handler.ts` lines ~92-114: `generateSdk(document, target)` returns
  `{ files, undeclared, unrepresentable }` (`files` is `relativePath → contents`); then
  `mkdirSync(outputDirectory)`, `vendorTransport(...)`, `writeStamp(...)`, and every generated file
  written with `writeFileSync`. Nothing is ever deleted.
- Generated file lists are dynamic: the keys of `generateSdk`'s `files` for each of the 8 targets in
  `packages/codegen/src/sdk/targets/*.ts`. Dart (`dart.ts` lines ~485-507) returns
  `lib/lunora_api.dart`, `lib/models.dart`, `pubspec.yaml` and vendors `{ from: "lib", to: "lib" }`;
  Rust (`rust.ts` ~319-322) and Ruby (`ruby.ts` ~289-292) have two vendor entries.
- Stamp readers (all of them, from `git grep "lunora-transport"`): `vendor.ts`, `handler.ts`,
  `packages/cli/__tests__/commands/sdk.test.ts` (line ~114 parses the stamp and asserts
  `stamp.files`), `apps/docs/src/content/docs/concepts/non-js-sdks.mdx` (lines 39-54, a JSON
  example), `sdks/README.md` (lines 101-109). `sdks/generated-check.sh` does not read the stamp.
- Tests: `sdk.test.ts` (end to end with `--from <transportRoot>`, `runSdk` helper ~line 42,
  fixture ~lines 19-26 and 76), `sdk-vendor-symlink-guard.test.ts`, `sdk-vendor-source.test.ts`
  (from plan 568).

## 2. Existing seams

`walk`, `isTestFile`, `assertNoSymlinks`, `LunoraError`, the `runSdk` test helper.

## 3. The behavioural contract to preserve

- A first run into an empty directory writes the same files as today.
- A file the stamp never listed is never touched.
- `--from`, `--ref`, `--source` and the fallback messages are unchanged.

## 4. Design decisions

**Owner decision (2026-11-12):** delete stale files AND track generated files in the stamp, with the
strict guard; include workstream A; a missing or older-format stamp deletes nothing and is replaced
by the new format.

- **Stamp format (new):** add `"format": 2`, replace `files` with two sorted arrays,
  `transportFiles` (vendored) and `generatedFiles` (the keys of `generateSdk`'s `files`). Keep
  `cliVersion`, `language`, `note`, `ref`, `source`, `versionMatched`. `VendorResult.files` is
  renamed `transportFiles`; update every reader (handler's log line counts it).
- **Workstream A:**
    - `transportFiles` come from a walk of each SOURCE entry (`isTestFile` filtered), mapped to
      `${to}/…` (or `to` for a file entry) — never from the destination.
    - Run `assertNoSymlinks` over EVERY vendor entry (and check every `from` exists) before the first
      `cpSync`, so a refusal in a later entry writes nothing.
- **Order in `handler.ts`:** read the previous stamp first; generate; vendor; write generated files;
  prune; write the new stamp last (so a failed run keeps the old stamp and the next run can still
  prune).
- **Reading the previous stamp** (new module `packages/cli/src/commands/sdk/stamp.ts`, named
  exports): returns `{ transportFiles, generatedFiles }` only when the file parses, `format === 2`
  and both are string arrays; otherwise `undefined` (missing, older format, or garbage → delete
  nothing). Move `STAMP_FILE`/`writeStamp` there if it keeps `vendor.ts` simpler; update imports.
- **Pruning** (same module): candidates = previous (`transportFiles` ∪ `generatedFiles`) minus new
  (`transportFiles` ∪ `generatedFiles`), never `STAMP_FILE`. For each candidate, delete only if ALL
  hold, else refuse and collect it with a reason:
    1. a string, not absolute (`isAbsolute`), and `normalize(p)` has no `..` segment;
    2. `resolve(outputDirectory, p)` is inside `outputDirectory` (prefix + `sep`);
    3. `realpathSync(dirname(abs))` is inside `realpathSync(outputDirectory)` (a symlinked parent
       directory cannot redirect the delete);
    4. `lstatSync(abs)` exists and `isFile()` (not a symlink, not a directory).
       A path that no longer exists is skipped silently. Use `rmSync(abs)` / `unlinkSync` for files only;
       never remove directories (empty directories may remain). Return `{ deleted, refused }`.
- **Reporting:** `logger.info` the deleted count (and paths); `logger.warn` each refused path with
  its reason. Refusals do not fail the run.
- **Docs:** update the JSON example in `non-js-sdks.mdx` and the sentence in `sdks/README.md` to the
  new keys, and say regeneration removes files the previous run produced and this one does not,
  never files it did not write.
- **Rejected:** deleting by directory diff (would delete user files); keeping `files` as an alias
  (pre-release branch: no compatibility shims; note the stamp format change in the commit body).

## 5. Workstreams

Size M. Two commits on one branch, both type `fix`, scope `cli`:
A — `fix(cli): stamp sdk transport files from the source and scan before copying`;
B — `fix(cli): remove sdk files a regeneration no longer produces` (stamp format change noted in
the body).

### Commands you will need

| Purpose         | Command (worktree root)                                                                                                                                                                                            | Expected                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Install         | `pnpm install --frozen-lockfile`                                                                                                                                                                                   | exit 0                                                                              |
| Build deps once | `pnpm --filter "@lunora/cli..." run build`                                                                                                                                                                         | exit 0                                                                              |
| SDK tests       | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/sdk.test.ts __tests__/commands/sdk-vendor-symlink-guard.test.ts __tests__/commands/sdk-vendor-source.test.ts __tests__/commands/sdk-stamp.test.ts` | all pass                                                                            |
| Package tests   | `pnpm --filter "@lunora/cli" run test`                                                                                                                                                                             | all pass (known flakes: `mcp-serve.test.ts`, `codegen-watch.test.ts`; re-run alone) |
| Format code     | `pnpm exec oxfmt <file>` per changed .ts file                                                                                                                                                                      | exit 0                                                                              |
| Format docs     | `pnpm exec prettier --write <changed .md/.mdx>`                                                                                                                                                                    | exit 0                                                                              |
| AI knowledge    | `node scripts/build-ai-knowledge.js && git status --short shared/`                                                                                                                                                 | commit `shared/ai-knowledge-data.ts` if it changed                                  |
| ESLint          | `pnpm --filter "@lunora/cli" run lint:eslint`                                                                                                                                                                      | exit 0                                                                              |
| Types           | `pnpm --filter "@lunora/cli" run lint:types`                                                                                                                                                                       | exit 0                                                                              |

### Scope

**In scope:** `packages/cli/src/commands/sdk/vendor.ts`, `packages/cli/src/commands/sdk/handler.ts`,
`packages/cli/src/commands/sdk/stamp.ts` (create), `packages/cli/__tests__/commands/sdk.test.ts`,
`packages/cli/__tests__/commands/sdk-vendor-symlink-guard.test.ts`,
`packages/cli/__tests__/commands/sdk-vendor-source.test.ts` (only if `VendorResult` renames break it),
`packages/cli/__tests__/commands/sdk-stamp.test.ts` (create),
`apps/docs/src/content/docs/concepts/non-js-sdks.mdx`, `sdks/README.md`,
`shared/ai-knowledge-data.ts` (only as the generator rewrites it).

**Out of scope:** `packages/codegen/**` (targets unchanged), `util/source-ref.ts`,
`commands/registry/**`, `sdks/*` other than the README, `plans/README.md`.

### Git workflow

- Branch `fix/improve-569-sdk-stale-files`, cut from `8e435c6bc`. Do not push.
- Two commits as in section 5; bodies ≤ 4 lines (≤ 100 chars); last line
  `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

Work only inside the worktree; never `test:workerd`, `build:packages`, `build`, repo-root `test`,
`pnpm -r`; no writes outside the worktree except test temp dirs via `os.tmpdir()` as the existing
SDK tests do. oxfmt before ESLint; Prettier for Markdown. No `.js` import extensions. Named exports
only. Comments say why. No `.skip`, `@ts-expect-error`, `as any`, unexplained disables. Complexity
limit 15: extract helpers.

### Step 1: Install and build — **Verify:** exit 0.

### Step 2 (commit A): failing tests for workstream A

1. In `sdk.test.ts`: generate Dart twice into the same output with `--from` a fixture
   `transportRoot/dart/lib/{lunora.dart,src/client.dart}` (build it like the python fixture). After
   the second run the stamp's transport list (today `files`) does NOT contain `lib/lunora_api.dart`
   or `lib/models.dart`. If Dart generation needs a tool that is unavailable in the test
   environment, STOP and report.
2. In `sdk-vendor-symlink-guard.test.ts`: a two-entry target (build an `SdkTarget` with two
   `vendor` entries, as that file builds its target) where the SECOND entry contains a symlink →
   rejects, and NOTHING from the first entry exists in the output directory.

**Verify:** both FAIL.

### Step 3: Implement workstream A — **Verify:** SDK tests pass. Gates (format, ESLint, types). Commit A.

### Step 4 (commit B): failing tests for pruning

Create `sdk-stamp.test.ts` for the stamp/prune module, plus end-to-end cases in `sdk.test.ts`:

1. A transport file removed from the fixture between two runs is deleted from the output on the
   second run.
2. A generated file the second run no longer produces (simulate by writing a format-2 stamp that
   lists an extra generated path and creating that file) is deleted.
3. A user file in the output directory that no stamp listed survives.
4. A previous stamp listing `../outside.txt`, an absolute path, and a path whose file is a symlink
   (and one whose parent directory is a symlink to a temp dir outside the output): none is deleted,
   the outside file and the symlink target still exist, and each refusal is reported via
   `logger.warn`.
5. A missing stamp, and an old-format stamp (`{ "files": [...] }` with no `format`), delete
   nothing, and the run writes a `format: 2` stamp.
6. The new stamp has `format: 2`, `transportFiles` and `generatedFiles`, each sorted, and Dart's
   generated files appear only in `generatedFiles`.

**Verify:** the new tests FAIL.

### Step 5: Implement pruning and the new stamp format; update the existing stamp assertion in `sdk.test.ts` (~line 114) to the new keys — **Verify:** SDK tests pass.

### Step 6: Docs — update `non-js-sdks.mdx` and `sdks/README.md`; run the AI-knowledge generator — **Verify:** `pnpm exec prettier --check` on both exits 0.

### Step 7: Gates, then commit B — **Verify:** formatters, ESLint, types, package tests. Commit B. `git status --short` empty.

### Step 8: Prove the tests need the fix (after the commits; no stash)

```bash
for f in vendor.ts handler.ts; do git show 8e435c6bc:packages/cli/src/commands/sdk/$f > packages/cli/src/commands/sdk/$f; done
pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/sdk.test.ts __tests__/commands/sdk-vendor-symlink-guard.test.ts   # new cases FAIL
git checkout HEAD -- packages/cli/src/commands/sdk/vendor.ts packages/cli/src/commands/sdk/handler.ts
git status --short   # empty
```

(`sdk-stamp.test.ts` imports the new module, so it cannot run against the base; its red state is
shown in step 4.)

## 6. Platform parity

Not applicable: CLI file handling only.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                                 |
| ----- | --------- | -------------------------------------------------------------------- |
| A     | Steps 1-3 | two new tests red then green                                         |
| B     | Steps 4-8 | prune tests red then green; guard refusals reported; cli gates green |

## 8. Risks & STOP conditions

- **STOP** if any delete path can be reached without all four guard checks.
- **STOP** if `generateSdk` for a target writes files outside its returned `files` map (then the
  generated list would be incomplete).
- **STOP** if Dart generation cannot run in the test environment.
- **Risk:** a user who edited a generated or vendored file and then the generator stops producing it
  loses the edit. Same as today for overwritten files; the PR says so.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test` (modulo the two known flakes, green alone), `lint:eslint`, `lint:types` exit 0.
- [ ] New tests in `sdk.test.ts` and `sdk-vendor-symlink-guard.test.ts` fail against `8e435c6bc`'s `vendor.ts`/`handler.ts`.
- [ ] `git grep -n '"files"' packages/cli/src/commands/sdk` shows no stamp key named `files`.
- [ ] `git diff --stat 8e435c6bc..HEAD` lists only in-scope files.
