# Plan 538 — Refuse a `.softDelete()` join table behind a many-to-many relation

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):** `git diff --stat 4a7c48bfd..HEAD -- packages/server/src/schema-through.ts packages/server/__tests__/relation-through.test.ts apps/docs/src/content/docs/concepts/relations.mdx`
> must print nothing. Then confirm the excerpts in §1 match. Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO
**Priority / effort / risk:** P2 / S / LOW. **Category:** bug. **Depends on:** none.

## 0. Headline finding

A many-to-many relation (`r.many(target, { through })`) whose join table is declared `.softDelete()`
breaks permanently after one `disconnect`: the disconnect soft-deletes the join row, the next
`connect` of the same pair does not see it (list reads hide soft-deleted rows), tries to insert, hits
the unique pair index (which has no soft-delete predicate), and the conflict is swallowed. The link
is never restored, and the caller is told it succeeded.

## 1. Current state (audit)

- `packages/server/src/relation-writes.ts:442` — release: `await writer.delete(joinTable, String(link["_id"]));`
  (a soft delete on a `.softDelete()` table).
- `packages/server/src/relation-writes.ts:376-391` — `linksOf` reads with `writer.findMany(table, { limit, where })`,
  which hides soft-deleted rows.
- `packages/server/src/relation-writes.ts:445-459` — the re-insert; a unique conflict is swallowed when
  `info.pairIsOnlyUnique`.
- `packages/server/src/schema-through.ts` (68 lines) — the load-time rules, run by `defineSchema`
  (`packages/server/src/schema.ts:1640`) and by `mergeSchemaExtension` (`packages/server/src/plugin.ts:523`).
  It checks: join table declared, target declared, `from !== to`, both are required `v.id` columns, and
  a unique index over the pair (lines 49-54):

    ```ts
    if (!hasUniquePairIndex(join.indexes, from, to)) {
        throw new LunoraError("INTERNAL", `${label} needs a unique index over ("${from}", "${to}") on "${joinName}": ...`);
    }
    ```

    It has no soft-delete rule. A `.softDelete()` table carries `softDeleteMode?: { field: string }`
    on its `TableDefinition` (`packages/server/src/types.ts:477`).

- No example, template or registry schema uses a soft-delete join table (checked with grep).
- Docs: `apps/docs/src/content/docs/concepts/relations.mdx:155-158`, bullet "**The schema is checked
  when it loads.**" lists the rules.
- Test file `packages/server/__tests__/relation-through.test.ts`; pattern to copy: the test
  "requires a unique index over exactly the two keys" (lines 168-183), which builds a schema with a
  `join` table and asserts `toThrow(/.../u)`.

## 2. Existing seams (do not reinvent)

- `validateThroughRelation` in `schema-through.ts` — add one more check there, after the unique-index
  check, throwing `LunoraError("INTERNAL", …)` with the same `label` prefix as its siblings.

## 3. The behavioural contract to preserve

- Every existing through-relation schema keeps loading (none uses `.softDelete()` on its join table).
- Error code stays `INTERNAL` and the message starts with the same `label` as the other rules.

## 4. Design decisions

- Refuse at schema load rather than make the release a hard delete. Chosen because a soft-deleted
  link that can never be re-linked is a data-model contradiction (the unique pair index has no
  soft-delete predicate), and refusing is one check with a clear message. Rejected alternatives:
  (a) `writer.delete(joinTable, id, { hard: true })` on release — silently discards the soft-delete
  history the table was declared to keep; (b) "undelete on connect" — a new write path.
- This is the `alpha` branch: no compatibility path. A schema that declared this now fails to load
  with a message naming the fix (drop `.softDelete()` from the join table).
- The advisor-lint mirror (`packages/advisor/src/lints/static/through-relation-missing-unique-index.ts`
  reports the unique-index rule at codegen time) is out of scope for this plan; see §9.

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                                                    | Expected |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| Install             | `pnpm install`                                                                                             | exit 0   |
| Build deps          | `pnpm --filter "@lunora/server..." run build`                                                              | exit 0   |
| One test file       | `pnpm --filter "@lunora/server" exec vitest run __tests__/relation-through.test.ts`                        | all pass |
| Package tests       | `pnpm --filter "@lunora/server" run test`                                                                  | all pass |
| Types               | `pnpm --filter "@lunora/server" run lint:types`                                                            | exit 0   |
| Format code         | `pnpm exec oxfmt packages/server/src/schema-through.ts packages/server/__tests__/relation-through.test.ts` | exit 0   |
| Format docs         | `pnpm exec prettier --write apps/docs/src/content/docs/concepts/relations.mdx`                             | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/server" run lint:eslint`                                                           | exit 0   |

**Scope.** In scope: `packages/server/src/schema-through.ts`,
`packages/server/__tests__/relation-through.test.ts`,
`apps/docs/src/content/docs/concepts/relations.mdx` (one sentence in the bullet at lines 155-158).
Out of scope: `relation-writes.ts` (both copies, in `server` and `shard-engine`), the advisor package,
codegen.

**Step 1 — install and build.** Verify: both exit 0.

**Step 2 — pre-check.** Run
`grep -rln "softDelete()" packages/*/__tests__ packages/codegen/__tests__/fixtures examples templates registry --include='*.ts' | xargs grep -ln "through:" 2>/dev/null`
and read each hit (if any). If any hit declares a through relation whose JOIN table is `.softDelete()`,
STOP and report the file. (Hits where `softDelete()` and `through:` are unrelated are fine; say so.)
Verify: you can state "no soft-delete join table exists" with the grep output as evidence.

**Step 3 — failing test.** In `relation-through.test.ts`, next to "requires a unique index over exactly
the two keys", add "refuses a soft-delete join table": same `build` helper shape, with
`defineTable(joinShape).index("byPair", ["postId", "tagId"], { unique: true }).softDelete()` as `join`.
Assert it throws `/soft-delete/u` (match the message you write in Step 4) and that the same table
without `.softDelete()` does not throw. Add a second assertion that `mergeSchemaExtension` refuses it
too ONLY if the file already has a helper for building an extension; otherwise skip that and say so.
Verify: one-test-file command → the new test FAILS (no throw); others pass.

**Step 4 — the rule.** In `validateThroughRelation`, after the unique-index check, add:

```ts
if (join.softDeleteMode !== undefined) {
    throw new LunoraError(
        "INTERNAL",
        `${label}: the join table is .softDelete(), so a disconnected pair could never be linked again (the unique index still holds the soft-deleted row). Remove .softDelete() from "${joinName}".`,
    );
}
```

Also add one clause to the module docblock (lines 1-8) naming the rule. Adjust the wording if the
linter objects, but keep the reason in the message.
Verify: one-test-file command → all pass.

**Step 5 — docs.** In `relations.mdx` lines 155-158, add to the bullet: the join table must not be
`.softDelete()` (a soft-deleted link would still hold the unique pair, so it could never be linked
again). One sentence. Run the docs format command.
Verify: `grep -n "softDelete" apps/docs/src/content/docs/concepts/relations.mdx` shows your sentence.

**Step 6 — red without the fix (mandatory).** Commit (Step 8), then
`git diff 4a7c48bfd..HEAD -- packages/server/src/schema-through.ts | git apply -R`, run the
one-test-file command, confirm the new test fails, restore with
`git checkout -- packages/server/src/schema-through.ts`, confirm `git status --short` is clean.

**Step 7 — gates.** Format, lint, types, package tests. Verify: all exit 0.

**Step 8 — commit.** Stage the three files by path. Message:

```
fix(server): refuse a soft-delete join table on a through relation

A disconnect soft-deleted the join row, the unique pair index kept it, and a
later connect of the same pair was swallowed as a conflict: the link could
never be restored. defineSchema now refuses the schema at load.

Breaks on alpha: a schema whose many-to-many join table is .softDelete() no
longer loads; drop .softDelete() from the join table.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

Not applicable: a schema-load rule; no `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                          |
| ----- | --------- | ------------------------------------------------------------- |
| 0     | Steps 1-8 | new test red without the fix; server tests, types, lint green |

## 8. Risks & STOP conditions

- **STOP** on drift or excerpt mismatch.
- **STOP** if Step 2 finds a real soft-delete join table anywhere.
- **STOP** if any pre-existing `packages/server` test fails after Step 4.
- **STOP** if `join.softDeleteMode` does not exist on `TableDefinition` at the tip (check
  `packages/server/src/types.ts` near line 477).
- **STOP** after two failed attempts at any one verification.

## 9. Open questions / maintenance

1. (Follow-up, not this plan) Mirror the rule as an advisor lint so codegen reports it before the app
   runs, like `through_relation_missing_unique_index`.
2. If soft-deletable links are ever wanted, the design is an undelete-on-connect path plus a partial
   unique index; that is a feature, not this fix.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only the three in-scope files.
- [ ] `grep -n "softDeleteMode" packages/server/src/schema-through.ts` prints the new check.
- [ ] New test passes and failed with the fix reverted (Step 6).
- [ ] `pnpm --filter "@lunora/server" run test`, `run lint:types`, `run lint:eslint` exit 0.
- [ ] One commit; the body notes the break in prose (no `BREAKING CHANGE:` footer, which would
      force a major version bump on the release branch).
