# Plan 567 — Bare Firestore documents carrying `__name__` import instead of crashing

**Baseline:** `79b0c5a6a` (2026-11-11), applied on top of plan 566's commit
**Status:** DONE (APPROVED; PR #1560, branch fix/improve-566-firestore-reader)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**: this plan runs on branch `fix/improve-566-firestore-reader` AFTER
> plan 566 is committed. `git log --oneline -2` must show plan 566's commit on top of
> `origin/alpha`.

Finding row 25 of the 2026-11-11 audit (issue #1527). Depends on plan 566 (same file).

## 0. Headline finding

A bare (non-wrapped) Firestore document is decoded whole, including its `__name__` resource-path
string. `decodeValue` then evaluates `"nullValue" in "<string>"`, which throws a raw
`TypeError: Cannot use 'in' operator…`. For `.ndjson` and array-shaped files there is no
`fallbackId`, so `__name__` is the only way to carry the document id and that path always crashes.

## 1. Current state (audit)

- `packages/cli/src/commands/data-transfer/sources/firebase.ts`:
    - `decodeValue(value, path)` starts (line 121-125) with
      `if ("nullValue" in value) { … }`, which throws a `TypeError` for any primitive `value`.
    - `toDocument` lines 233-252 (after plan 566 the line numbers shift slightly):

        ```ts
        const wrapped = isWrappedDocument(raw);
        const decoded = wrapped
            ? decodeFields((raw["fields"] ?? {}) as Record<string, FirestoreValue>, path)
            : decodeFields(raw as unknown as Record<string, FirestoreValue>, path);

        const name = raw["name"] ?? raw["__name__"];
        const id = typeof name === "string" ? documentIdFromName(name) : fallbackId;
        ```

        The comment above it (lines 228-232) says this crash was removed — it was, only for the wrapped
        form.

    - `decodeFields` (line 222-223) maps every entry through `decodeValue`.
    - Readers: `readCollectionDocuments` (array, `{documents:[…]}` and keyed-object shapes) and
      `streamNdjsonDocuments`; only the keyed-object shape supplies `fallbackId`.
- Tests: `packages/cli/__tests__/commands/import-sources.test.ts`; no test references `__name__`.
  Use `writeDump`, `runImport` and `expectAbort` as the neighbouring Firestore tests do (line ~480
  reads ids from a keyed file; line 493 is the "no document id" abort).

## 2. Existing seams (do not reinvent)

`documentIdFromName`, `LunoraError("INTERNAL", \`${path}: …\`)`.

## 3. The behavioural contract to preserve

Wrapped documents and keyed bare documents decode exactly as today. `__name__` still supplies the id.

## 4. Design decisions

- In `toDocument`'s bare branch, decode `raw` without its `__name__` key (destructure it out into
  `_name` or filter the entries) but keep reading `raw["__name__"]` for the id as today.
- Make `decodeValue` refuse non-object input before the `in` check: when `value` is not a non-null,
  non-array object, throw
  `LunoraError("INTERNAL", \`${path}: expected a Firestore typed value ({ stringValue: … } and so on), got ${JSON.stringify(value)?.slice(0, 80)}\`)`.
This turns any other stray primitive into a path-named error instead of a `TypeError`.

## 5. Workstreams

One workstream, size S. Second commit on the plan-566 branch, type `fix`, scope `cli`.

### Commands you will need

Same as plan 566 (install and build already done).

### Scope

**In scope:** `packages/cli/src/commands/data-transfer/sources/firebase.ts`,
`packages/cli/__tests__/commands/import-sources.test.ts`.

**Out of scope:** everything else, `plans/README.md`.

### Git workflow

- Same branch, second commit: `fix(cli): import bare Firestore documents that carry __name__`;
  body ≤ 3 lines; last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

Same as plan 566.

### Step 1: Write the failing tests

In `import-sources.test.ts`:

1. A `.ndjson` collection file with two bare documents, each
   `{"__name__":"projects/p/databases/(default)/documents/t/x1","title":{"stringValue":"a"}}` →
   imports two rows with `_id` `x1`/`x2` and `title` `a`/`b`, and no `__name__` field.
2. The same as an array-shaped `.json` file.
3. A bare document with a raw primitive field (`{"__name__":"…/t/x1","oops":5}`) → `expectAbort`
   with `/expected a Firestore typed value/`.

**Verify:** test-file command → all three FAIL (the first two with a `TypeError`).

### Step 2: Implement

Per section 4.

**Verify:** test-file command passes.

### Step 3: Gates, then commit

**Verify:** format, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 4: Prove the tests need the fix (after the commit; no stash)

```bash
git show HEAD~1:packages/cli/src/commands/data-transfer/sources/firebase.ts > packages/cli/src/commands/data-transfer/sources/firebase.ts
pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/import-sources.test.ts   # the three new cases FAIL
git checkout HEAD -- packages/cli/src/commands/data-transfer/sources/firebase.ts
git status --short   # empty
```

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work                      | Gate                                                      |
| ----- | ------------------------- | --------------------------------------------------------- |
| 1     | Steps 1-4, after plan 566 | new cases red on the plan-566 commit, green with this one |

## 8. Risks & STOP conditions

- **STOP** if plan 566's commit is not the branch tip's parent.
- **STOP** if a test of the wrapped form changes outcome.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] New cases fail against the plan-566 version of `firebase.ts`.
- [ ] `git diff --stat HEAD~1..HEAD` lists only the two in-scope files.

## Maintenance notes

Any other wrapper key a bare document can carry must be stripped before `decodeFields` the same way.
