# Plan 582 — Identity-write, user-table and insert-path feeders see the `ctx.db.<table>.<write>(…)` facade

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/codegen/src/discover/table-writes.ts packages/codegen/src/discover/owner-field-writes/index.ts packages/codegen/src/discover/procedure-middleware.ts packages/codegen/src/discover/mutator-writes.ts packages/advisor/src/lints/static/table-without-insert.ts`
> Expect no output. Otherwise compare the excerpts below with the live code; on a mismatch, STOP.

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** TODO
**Source:** row 44 of the 2026-11-11 audit (advisor lints).

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED (widens an ERROR rule) · **Depends on**: none · **Category**: bug (security-lint false negative)

## 0. Headline finding

`ctx.db.posts.insert({ userId: args.userId })` is the write form the docs call
"the form real app code writes" (`packages/codegen/src/discover/database-calls.ts:41`),
but four write feeders only recognise the by-name form `ctx.db.insert("posts", …)`.
So `owner_field_from_args_not_auth` (ERROR), `user_creating_mutation_without_captcha`,
`signup_mutation_without_disposable_gating` and `mutator_full_row_replace` never see a
facade write, and `table_without_insert` (INFO) reports "no insert path" for tables
written only through the facade, `insertMany` or `upsert`.

## 1. Current state (audit)

- Facade signatures (`packages/server/src/facade.ts`, interface around lines 120-171):
  `insert(document, options?)`, `insertMany(documents, options?)`, `patch(id, patch)`,
  `replace(id, document)`, `upsert(args: UpsertArgs)` where `UpsertArgs` has `create` and
  `update` objects, `upsertMany(args)`. `insertManyUnsafe` exists ONLY on the flat
  `ctx.db.insertManyUnsafe(table, rows)` form.
- `packages/codegen/src/discover/table-writes.ts` already resolves the facade, for the
  `tableWrites` evidence:
    - `FACADE_WRITES` (line ~25): `delete, deleteMany, hardDelete, insert, insertMany, patch, patchMany, replace, restore, upsert, upsertMany`.
    - `facadeAliasTable(receiver)` (~line 153): resolves `const posts = ctx.db.posts` aliases (const only).
    - `writeOf(call)` (~line 176): `if (FACADE_WRITES.has(method) && Node.isPropertyAccessExpression(receiver) && isDatabaseAccessor(receiver.getExpression())) return …{ tables: [receiver.getName()] }`.
- `packages/codegen/src/discover/owner-field-writes/index.ts`:
    - `IDENTITY_WRITE_METHODS = new Set(["insert", "insertManyUnsafe", "patch", "replace"])` (line 44).
    - `contextDatabaseWriteMethod(node)` (line ~53) requires `denotesContextDatabase(node.getExpression())`, i.e. the receiver IS `ctx.db`.
    - `documentObjectLiterals(documentArgument, method)` (~line 67) treats an array only for `insertManyUnsafe`.
    - `ownerFieldWritesInCall` (~line 218): `const documentIndex = method === "patch" || method === "replace" ? 2 : 1;`
- `packages/codegen/src/discover/procedure-middleware.ts:228-257` — `USER_TABLE_INSERT_METHODS = ["insert", "insertMany", "insertManyUnsafe", "replace"]`; `isUserTableInsert(call)` requires `isDatabaseAccessor(receiver)` and a literal first argument, then `isUserTableName(...)`.
- `packages/codegen/src/discover/mutator-writes.ts:13-29` — `isDatabaseReplaceCall` matches only `<db>.replace(...)`.
- `packages/advisor/src/lints/static/table-without-insert.ts` `run`: builds `insertedTables` from `context.inserts` only (by-name `ctx.db.insert`). `context.tableWrites` (`AdvisorTableWrite`, `packages/advisor/src/types.ts:738`) already carries facade `insert`/`insertMany`/`upsert`/`upsertMany` and by-name `insertMany`/`insertManyUnsafe` rows with `{ file, line, method, scope, table }`. `cross-module-table-write.ts:43` already unions `inserts` and `tableWrites`, so do NOT add facade inserts to `discover/inserts.ts` (it would double-count there).

## 2. Existing seams (use them, do not reinvent)

- The facade resolution in `table-writes.ts` (`facadeAliasTable`, the facade branch of `writeOf`).
- `denotesContextDatabase` (`discover/context-root.ts`) — the symbol-based "this is `ctx.db`" test the owner-field feeder relies on; keep using it there.
- `isReachableSite` (already imported by `table-without-insert.ts`).
- Tests: `packages/codegen/__tests__/discover/owner-field-writes.test.ts` and its fixture helper
  `owner-field-writes-fixture.ts` (`discover(source)` returns rows); `procedure-middleware.test.ts`;
  `mutator-writes.test.ts`; `packages/advisor/__tests__/table-without-insert.test.ts`. Model new tests on their neighbours in the same file.

## 3. Behavioural contract to preserve

- Every existing test in the files above passes unchanged.
- `TableWriteIR` / `tableWrites` output is byte-identical (the move in Step 1 is a refactor).
- `discover/inserts.ts` and `context.inserts` are unchanged.

## 4. Design decisions

- **One shared facade resolver** in a new `packages/codegen/src/discover/write-target.ts`, moved
  out of `table-writes.ts`, used by all four feeders. Chosen over copying the facade check into each
  feeder: the by-name check was copied four times and that is how the facade got missed four times.
- **The resolver returns the node that denotes the database** so each feeder keeps its own trust
  policy: owner-field still demands `denotesContextDatabase`, the others keep `isDatabaseAccessor`.
- **`table_without_insert` reads `tableWrites` too**, rather than widening `discover/inserts.ts`,
  because `cross_module_table_write` already unions both lists.
- `upsert`: the identity columns of BOTH `create` and `update` object literals are inspected.

## 5. Steps

### Step 1: extract the facade resolver (pure refactor)

Create `packages/codegen/src/discover/write-target.ts` exporting (named exports only):

```ts
/** A `ctx.db.<table>.<method>(…)` facade write, or one through a `const t = ctx.db.<table>` alias. */
interface FacadeWrite {
    /** The expression that denotes the database (`ctx.db`), for the caller's own trust check. */
    database: TsNode;
    method: string;
    table: string;
}
const facadeWriteOf = (call: CallExpression, methods: ReadonlySet<string>): FacadeWrite | undefined
```

Move `facadeAliasTable` into this file (adapted to also hand back the alias initializer's
`.getExpression()` as `database`). `facadeWriteOf` returns a row when the callee is
`<receiver>.<method>` with `methods.has(method)` and either (a) the receiver is a const facade
alias, or (b) the receiver is a property access whose expression satisfies `isDatabaseAccessor`.
Export `FACADE_WRITES` from here too and make `table-writes.ts` import both and use
`facadeWriteOf(call, FACADE_WRITES)` for its two facade branches. Keep comments that explain why.

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0;
`pnpm --filter "@lunora/codegen" exec vitest run __tests__/discover/table-writes.test.ts` → all pass (unchanged).
Commit: `refactor(codegen): share the ctx.db facade write resolver`.

### Step 2: owner-field writes see the facade

In `owner-field-writes/index.ts`:

- Add `const FACADE_IDENTITY_WRITE_METHODS = new Set(["insert", "insertMany", "patch", "replace", "upsert"]);`
- Replace `contextDatabaseWriteMethod` with a function returning `{ method: string; documentArguments: TsNode[] } | undefined`:
    - by-name form (today's logic, receiver must `denotesContextDatabase`): document at index 2 for `patch`/`replace`, else 1.
    - facade form: `facadeWriteOf(call, FACADE_IDENTITY_WRITE_METHODS)` AND `denotesContextDatabase(write.database)`;
      document index 1 for `patch`/`replace`, 0 for `insert`/`insertMany`; for `upsert`, the
      initializers of the `create` and `update` properties of the object-literal argument 0
      (use `findObjectProperty` from `../ast`; skip one that is not a `PropertyAssignment`).
- `documentObjectLiterals`: treat an array argument for `insertMany` exactly as for `insertManyUnsafe`.
- `ownerFieldWritesInCall`: iterate all document arguments; `method` in the IR row is the method name (`insert`, `upsert`, …).

**Verify**: types exit 0; `pnpm --filter "@lunora/codegen" exec vitest run __tests__/discover/owner-field-writes` (all files matching) → all existing pass.

Tests — add to `owner-field-writes.test.ts` (use the file's `discover(...)` helper and an exported
`mutation`/handler shape already used in that file):

- reported: `await ctx.db.posts.insert({ userId: args.userId });`
- reported: `await ctx.db.posts.patch(args.id, { ownerId: args.ownerId });`
- reported: `await ctx.db.posts.upsert({ target: "slug", create: { userId: args.userId, slug: args.slug }, update: {} });`
- reported: `const posts = ctx.db.posts; await posts.insert({ userId: args.userId });`
- NOT reported (safe neighbour): `await ctx.db.posts.insert({ userId: ctx.auth.userId, title: args.title });`
- NOT reported: `await somethingElse.posts.insert({ userId: args.userId });` (receiver is not `ctx.db`)

Commit: `fix(codegen): report identity columns written through the ctx.db facade`.

### Step 3: user-table inserts and mutator replaces see the facade

- `procedure-middleware.ts` `isUserTableInsert`: after the existing by-name check fails, return
  `true` when `facadeWriteOf(call, new Set(["insert", "insertMany", "replace", "upsert"]))` gives a
  row whose `table` passes `isUserTableName`. Hoist that set to a module const.
- `mutator-writes.ts`: `isDatabaseReplaceCall` also accepts `facadeWriteOf(call, new Set(["replace"]))`.
  The IR row is unchanged.
- Tests: in `procedure-middleware.test.ts`, mirror an existing `writesUserTable` test with
  `ctx.db.users.insert({...})` → `writesUserTable: true`, and `ctx.db.posts.insert({...})` → `false`.
  In `mutator-writes.test.ts`, mirror the existing replace test with `ctx.db.todos.replace(id, {...})` → one row.

**Verify**: types exit 0; both test files pass.
Commit: `fix(codegen): count facade writes as user-table inserts and mutator replaces`.

### Step 4: `table_without_insert` counts every insert path

In `packages/advisor/src/lints/static/table-without-insert.ts`, add the tables of
`context.tableWrites` rows whose `method` is one of `insert`, `insertMany`, `insertManyUnsafe`,
`upsert`, `upsertMany`, whose `table !== ""` and whose scope `isReachableSite`, to `insertedTables`.
Keep the early return on `context.inserts === undefined`. Update `description`, `detail` and
`remediation` wording from "`ctx.db.insert(\"<table>\", …)`" to "an insert (`ctx.db.insert`, the
`ctx.db.<table>.insert`/`insertMany`/`upsert` facade, or `insertMany`)" — keep `name` and `level`.
Test in `table-without-insert.test.ts`: a table written only by a `tableWrites` row
`{ method: "upsert", table: "profiles", scope: <a reachable scope as other tests build it> }` is NOT
reported; a table with only a `tableWrites` `patch` row IS still reported.

**Verify**: `pnpm --filter "@lunora/advisor" run test` → all pass (includes `docs-lint-reference.test.ts`).
Commit: `fix(advisor): count facade and batch inserts as insert paths`.

### Step 5: red without the fix

With everything committed, put the baseline sources back for the five source files:
`for f in packages/codegen/src/discover/table-writes.ts packages/codegen/src/discover/owner-field-writes/index.ts packages/codegen/src/discover/procedure-middleware.ts packages/codegen/src/discover/mutator-writes.ts packages/advisor/src/lints/static/table-without-insert.ts; do git show 79b0c5a6a:$f > $f; done`
(leave `write-target.ts` in place; nothing imports it then). Rebuild advisor
(`pnpm --filter "@lunora/advisor" run build`), run the new tests in the four codegen test files and
`table-without-insert.test.ts`, and confirm every NEW "reported"/"is not reported because inserted"
test FAILS while the safe-neighbour tests pass. Then `git checkout -- packages/codegen/src packages/advisor/src`,
rebuild advisor again, and re-run → all pass. Report the failing test names.

### Step 6: rollout in in-repo apps

`pnpm --filter "lunorash..." run build`, then for every `examples/<name>` with a `codegen` script:
`cd examples/<name> && pnpm run codegen`; then `git status --short`. A changed `_generated` file
whose diff adds or removes an advisory is a rollout change: STOP and report every added/removed
advisory (rule name, file:line, the code shape). Do not commit regenerated output.

## Commands you will need

| Purpose    | Command (from the worktree root)                                          | Expected         |
| ---------- | ------------------------------------------------------------------------- | ---------------- |
| Install    | `pnpm install --frozen-lockfile`                                          | exit 0           |
| Build deps | `pnpm --filter "@lunora/codegen..." run build`                            | exit 0           |
| Codegen    | `pnpm --filter "@lunora/codegen" run test` / `lint:eslint` / `lint:types` | all pass, exit 0 |
| Advisor    | `pnpm --filter "@lunora/advisor" run test` / `lint:eslint` / `lint:types` | all pass, exit 0 |
| Format     | `pnpm exec oxfmt --check <changed .ts files>`                             | exit 0           |

## Scope

In scope: `packages/codegen/src/discover/write-target.ts` (new), `…/table-writes.ts`,
`…/owner-field-writes/index.ts`, `…/procedure-middleware.ts` (`isUserTableInsert` and its const only),
`…/mutator-writes.ts` (`isDatabaseReplaceCall` only), `packages/advisor/src/lints/static/table-without-insert.ts`,
and the test files named above.
Out of scope: `discover/inserts.ts`, `argument-taint.ts`, `cross-module-table-write.ts`, every
`examples/**` / `templates/**` / `apps/**` file (report, never commit).

## Done criteria

- [ ] codegen and advisor `lint:eslint`, `lint:types`, `test` exit 0
- [ ] new reported-shape tests fail against the baseline sources; safe-shape tests pass on both
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only in-scope files; 4 commits
- [ ] `grep -rn "facadeAliasTable" packages/codegen/src/discover/table-writes.ts` → no definition left there (moved)

## STOP conditions

- Excerpts do not match the live code.
- `table-writes.test.ts` changes behaviour after Step 1 (the move must be a pure refactor).
- `api:check`-relevant: `write-target.ts` is re-exported from `packages/codegen/src/index.ts` — do not do that; STOP if you think it is needed.
- An example's `_generated` output changes in Step 6.
- A verification fails twice after a reasonable fix.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding changes.

## 7. Phasing & ordering

Step 1 (refactor, green on existing tests) → Steps 2–4 (one rule family each, each red without its fix) → Step 6 rollout.

## Maintenance notes

- Rollout: `owner_field_from_args_not_auth` (ERROR) newly fires on identity columns written from
  `args` through `ctx.db.<table>.insert/insertMany/patch/replace/upsert`; the captcha and
  disposable-email rules newly see facade inserts into user-shaped tables; `mutator_full_row_replace`
  sees `ctx.db.<table>.replace`; `table_without_insert` stops firing for tables inserted only via
  the facade, `insertMany` or `upsert`.
- A future facade write method must be added to `FACADE_WRITES` and, if it carries a document, to the owner-field set.
