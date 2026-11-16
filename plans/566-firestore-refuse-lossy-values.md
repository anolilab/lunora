# Plan 566 — The Firestore reader refuses non-finite doubles and a field named `_id`

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** DONE (APPROVED; PR #1560, branch fix/improve-566-firestore-reader)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/cli/src/commands/data-transfer/sources/firebase.ts packages/cli/__tests__/commands/import-sources.test.ts`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 24 of the 2026-11-11 audit (issue #1527). Plan 567 (row 25) is a second commit on the
same branch.

## 0. Headline finding

The Firestore reader silently changes data it should refuse. A `doubleValue` of `"NaN"`,
`"Infinity"` or `"-Infinity"` (how the Firestore REST encoding spells non-finite doubles) becomes
`NaN`/`Infinity` and is then written as `null` by `JSON.stringify`. A document with its own field
named `_id` has that field overwritten by the document id. Both contradict the reader's stated rule
that a lossy reshape must error, and the Supabase reader already refuses the `_id` collision.

## 1. Current state (audit)

- `packages/cli/src/commands/data-transfer/sources/firebase.ts`:
    - Lines 121-173, `decodeValue(value, path)`. Lines 142-144:

        ```ts
        if (value.doubleValue !== undefined) {
            return Number(value.doubleValue);
        }
        ```

    - Lines 226-271, `toDocument(raw, fallbackId, tableMapping, path)`; it ends with
      `return { ...decoded, _id: id };` (line 270), which overwrites a decoded field named `_id`.
    - Errors in this file are `new LunoraError("INTERNAL", \`${path}: …\`)` (see line 172 and line 249);
      copy that form, naming the field path.
- `packages/cli/src/commands/data-transfer/sources/supabase.ts` lines 131-139 refuse a source column
  `_id` with a message telling the operator how to fix it. Match its tone.
- `packages/cli/src/commands/data-transfer/sources/reshape.ts` lines 4-8: "a reshape that would lose
  information errors, naming the column."
- Tests: `packages/cli/__tests__/commands/import-sources.test.ts` — `writeDump({...})`, `runImport`
  and `expectAbort(root, "firebase", /regex/)` (e.g. line 493 "rejects a document with no id rather
  than inventing one", line 501 "rejects an unrecognised value shape"). Line 426 covers only a finite
  double.

## 2. Existing seams (do not reinvent)

`LunoraError("INTERNAL", …)` with the path, and `expectAbort` in tests.

## 3. The behavioural contract to preserve

Finite doubles (including `0`, negatives, and numeric strings like `"1.5"`) decode exactly as today.
Every existing test passes.

## 4. Design decisions

- **Non-finite double:** compute `Number(value.doubleValue)`; if `!Number.isFinite(result)`, throw
  `LunoraError("INTERNAL", \`${path}: doubleValue ${JSON.stringify(value.doubleValue)} is not a finite number — JSON cannot carry it, and writing it would store null\`)`.
- **`_id` collision:** in `toDocument`, after decoding (and after the reshape loop), if `"_id" in decoded`, throw
  `LunoraError("INTERNAL", \`${path}._id: the document has its own \\\`_id\\\` field, which collides with the reserved id field — rename it in the source\`)`.
- **Rejected:** keeping non-finite values as strings. The target column type is unknown here, and
  a silent type change is the loss the reshape rule forbids.

## 5. Workstreams

One workstream, size S. Commit type `fix`, scope `cli`.

### Commands you will need

| Purpose         | Command (worktree root)                                                                                                              | Expected |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                                                                     | exit 0   |
| Build deps once | `pnpm --filter "@lunora/cli..." run build`                                                                                           | exit 0   |
| Test file       | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/import-sources.test.ts`                                              | all pass |
| Package tests   | `pnpm --filter "@lunora/cli" run test`                                                                                               | all pass |
| Format          | `pnpm exec oxfmt packages/cli/src/commands/data-transfer/sources/firebase.ts packages/cli/__tests__/commands/import-sources.test.ts` | exit 0   |
| ESLint          | `pnpm --filter "@lunora/cli" run lint:eslint`                                                                                        | exit 0   |
| Types           | `pnpm --filter "@lunora/cli" run lint:types`                                                                                         | exit 0   |

### Scope

**In scope:** `packages/cli/src/commands/data-transfer/sources/firebase.ts`,
`packages/cli/__tests__/commands/import-sources.test.ts`.

**Out of scope:** `supabase.ts`, `reshape.ts`, `dump-directory.ts`, `plans/README.md`.

### Git workflow

- Branch `fix/improve-566-firestore-reader`, from `origin/alpha`. Do not push.
- Commit: `fix(cli): refuse non-finite doubles and _id fields in Firestore imports`; body ≤ 3
  lines; last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern.
- oxfmt before ESLint. No `.js` import extensions. Named exports only. Comments say why.
- No `.skip`, `@ts-expect-error`, `as any`, or new `eslint-disable` without rule + `-- reason`.

### Step 1: Install and build

**Verify:** exit 0.

### Step 2: Write the failing tests

In `import-sources.test.ts`, beside line 501, three `expectAbort` cases for `"firebase"`:

1. `doubleValue: "NaN"` → `/not a finite number/`.
2. `doubleValue: "Infinity"` → same.
3. A wrapped document whose `fields` contain `_id: { stringValue: "mine" }` →
   `/collides with the reserved id field/`.

**Verify:** test-file command → the three new cases FAIL.

### Step 3: Implement

Per section 4.

**Verify:** test-file command passes.

### Step 4: Gates, then commit

**Verify:** format, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 5: Prove the tests need the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/cli/src/commands/data-transfer/sources/firebase.ts > packages/cli/src/commands/data-transfer/sources/firebase.ts
pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/import-sources.test.ts   # the three cases FAIL
git checkout HEAD -- packages/cli/src/commands/data-transfer/sources/firebase.ts
git status --short   # empty
```

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work                        | Gate                                                   |
| ----- | --------------------------- | ------------------------------------------------------ |
| 0     | Steps 1-5                   | new cases red on base, green with fix; cli gates green |
| 1     | Plan 567 on the same branch | see plan 567                                           |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if an existing test imports a Firestore document with an `_id` field and expects it to be
  overwritten.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] The three new cases fail against `79b0c5a6a`'s `firebase.ts`.
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only the two in-scope files.

## Maintenance notes

A new Firestore value type must decide its lossy cases the same way: refuse with the path.
