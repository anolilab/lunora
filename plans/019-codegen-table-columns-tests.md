# Plan 019: Focused unit tests for codegen `buildTableColumns`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat dda03c28..HEAD -- packages/codegen/src/emit.ts packages/codegen/__tests__/run-codegen.test.ts`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `dda03c28`, 2026-06-14

## Why this matters

`buildTableColumns` in `@cirrus/codegen` is new code (shipped in `e2a2d49e`)
that powers the studio schema diagram: it derives the per-table column
descriptors (`name`, `type`, `optional`, `pk`, `ref`, `isStorage`) emitted as
`CIRRUS_TABLE_COLUMNS` and consumed by the `tableColumns()` shard override. Its
only current coverage is the broad golden fixture in
`__tests__/fixtures/simple/expected/_generated/shard.ts` — a snapshot that
asserts the whole emitted file matches, so a subtle regression in the
optional-unwrap, system-field-prepend, FK-ref, or storage-flag logic would be
hard to localize and easy to "fix" by blessing a wrong snapshot. Focused
behavioral tests pin each branch independently, so a future refactor of the
helper fails a small, named test instead of a 100-line snapshot diff.

## Current state

- `packages/codegen/src/emit.ts` — the emitter. `buildTableColumns` is a local
  (non-exported) function at lines 1143–1172; its output is embedded by
  `emitShard` (exported) as the `CIRRUS_TABLE_COLUMNS` constant at line 1721.
  Because the helper is not exported, **test it through the exported `emitShard`
  by asserting on the emitted string** — this is the established pattern in the
  repo (see the "emitShard — studio features" and "emitShard — storage rules"
  describe blocks).

    The helper as it exists today (emit.ts:1143–1172):

    ```ts
    const buildTableColumns = (schema: SchemaIR): Record<string, EmittedColumn[]> => {
        const byTable: Record<string, EmittedColumn[]> = {};

        for (const table of schema.tables) {
            const columns: EmittedColumn[] = [
                { name: "_id", optional: false, pk: true, type: "id" },
                { name: "_creationTime", optional: false, type: "number" },
            ];

            for (const [field, validator] of Object.entries(table.shape)) {
                const optional = validator.kind === "optional" || Boolean(validator.column?.hasDefault);
                const resolved = validator.kind === "optional" && validator.inner ? validator.inner : validator;
                const column: EmittedColumn = { name: field, optional, type: resolved.kind };

                if (resolved.kind === "id" && resolved.tableName !== undefined) {
                    column.ref = resolved.tableName;
                }

                if (resolved.kind === "storage") {
                    column.isStorage = true;
                }

                columns.push(column);
            }

            byTable[table.name] = columns;
        }

        return byTable;
    };
    ```

    Emitted (emit.ts:1721) as:

    ```ts
    const CIRRUS_TABLE_COLUMNS: Record<string, Array<{ isStorage?: boolean; name: string; optional: boolean; pk?: boolean; ref?: string; type: string }>> = ${JSON.stringify(tableColumns, undefined, 4)};
    ```

    So in the emitted output a `string` column named `text` appears (with 4-space
    indentation inside the object) literally as:

    ```
                {
                    "name": "text",
                    "optional": false,
                    "type": "string"
                }
    ```

- `packages/codegen/__tests__/run-codegen.test.ts` — the home for `emitShard`
  unit tests. It already imports `emitShard` (line 15) and the `SchemaIR` type,
  and contains `describe("emitShard — studio features", …)` (lines 807–832) and
  `describe("emitShard — storage rules", …)` (lines 784–805). **Add the new
  block next to these, following their exact style** (`expect.assertions(n)`
  first, build a `SchemaIR`, call `emitShard`, assert with `toContain`).

    The `SchemaIR` table shape used in these tests (verbatim from run-codegen.test.ts:838–852):

    ```ts
    const schema: SchemaIR = {
        tables: [
            {
                indexes: [],
                name: "docs",
                rankIndexes: [],
                relations: [],
                searchIndexes: [],
                shape: { body: { kind: "string" } },
                shardMode: "root",
                vectorIndexes: [{ field: "body", name: "by_body", table: "docs" }],
            },
        ],
        vectorIndexes: [{ field: "body", name: "by_body", table: "docs" }],
    };
    ```

    The validator shapes you'll need in `shape` (an IR validator object):
    - scalar: `{ kind: "string" }`, `{ kind: "number" }`, `{ kind: "boolean" }`
    - optional wrapper: `{ kind: "optional", inner: { kind: "string" } }`
    - has-default: `{ kind: "number", column: { hasDefault: true } }`
    - foreign key: `{ kind: "id", tableName: "users" }`
    - storage: `{ kind: "storage" }`

## Commands you will need

| Purpose   | Command                                                   | Expected on success |
| --------- | --------------------------------------------------------- | ------------------- |
| Build dep | `pnpm --filter "@cirrus/codegen..." run build`            | exit 0              |
| Test      | `pnpm --filter "@cirrus/codegen" run test -- run-codegen` | all pass, incl. new |
| Typecheck | `pnpm --filter "@cirrus/codegen" run lint:types`          | exit 0, no errors   |
| Lint      | `pnpm --filter "@cirrus/codegen" run lint:eslint`         | exit 0              |

(`@cirrus/codegen`'s test/lint resolve cross-package `@cirrus/*` types from
built `dist/`; build dependencies once before running them or you may hit
misleading "missing export" errors. This is repo convention — see
`plans/README.md` "Notes for executors".)

## Scope

**In scope** (the only file you should modify):

- `packages/codegen/__tests__/run-codegen.test.ts` (add one `describe` block)

**Out of scope** (do NOT touch):

- `packages/codegen/src/emit.ts` — this is a test-only plan. Do NOT export
  `buildTableColumns`, do NOT change the helper. If a test reveals a bug in the
  helper, that is a STOP condition (report it), not a fix to make here.
- The golden fixtures under `__tests__/fixtures/` — leave them as-is.

## Git workflow

- Branch: `advisor/019-codegen-table-columns-tests`
- One commit; message style is Angular conventional commits (see `git log`),
  e.g. `test(codegen): cover buildTableColumns column descriptors`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the `describe("emitShard — table columns")` block

In `packages/codegen/__tests__/run-codegen.test.ts`, immediately after the
closing `});` of the `describe("emitShard — studio features", …)` block (after
line 832), add a new sibling `describe` block with these test cases. Match the
surrounding style exactly (4-space indent, `expect.assertions(n)` as the first
statement, `SchemaIR` typed literal, `emitShard(schema)`, `toContain`
assertions). Use a single representative schema for the rich case and assert the
emitted JSON fragments.

Cover these cases (one `it` each):

1. **Prepends the system fields to every table.** Schema with one table `posts`
   whose `shape` is `{ title: { kind: "string" } }`. Assert the emitted output
   `toContain` a `"name": "_id"` entry with `"pk": true` and `"type": "id"`, and
   a `"name": "_creationTime"` entry with `"type": "number"`. (Because
   `JSON.stringify` emits keys alphabetically per the object literal order in
   the helper — `name`, `optional`, `pk`, `type` — assert on individual lines
   like `'"name": "_id"'`, `'"pk": true'`, not a multi-key exact block, to stay
   robust to indentation.)

2. **Emits a scalar column with its IR kind as `type`.** Same `posts` table;
   assert output contains `'"name": "title"'` and `'"type": "string"'`.

3. **Unwraps `v.optional(...)` to the inner kind and marks `optional: true`.**
   Table with `shape: { bio: { kind: "optional", inner: { kind: "string" } } }`.
   Assert output contains `'"name": "bio"'`, `'"optional": true'`, and
   `'"type": "string"'` (the inner kind, NOT `"optional"`).

4. **Marks a defaulted column optional.** Table with
   `shape: { views: { kind: "number", column: { hasDefault: true } } }`.
   Assert the emitted `views` column carries `'"optional": true'` and
   `'"type": "number"'`.

5. **Records the FK target table for `v.id("ref")`.** Table with
   `shape: { author: { kind: "id", tableName: "users" } }`. Assert output
   contains `'"ref": "users"'` and `'"type": "id"'`.

6. **Flags a `v.storage()` column.** Table with
   `shape: { avatar: { kind: "storage" } }`. Assert output contains
   `'"isStorage": true'`.

7. **Empty schema still emits the constant.** `emitShard({ tables: [], vectorIndexes: [] })`;
   assert output contains `'const CIRRUS_TABLE_COLUMNS'` and that the emitted
   map is empty (`toContain('CIRRUS_TABLE_COLUMNS: Record<string, Array<{ isStorage?: boolean; name: string; optional: boolean; pk?: boolean; ref?: string; type: string }>> = {}')`
   — note `JSON.stringify({}, undefined, 4)` produces exactly `{}`).

For each table you build, fill the required `SchemaIR` table fields exactly as
in the "Current state" excerpt: `indexes: []`, `rankIndexes: []`,
`relations: []`, `searchIndexes: []`, `shardMode: "root"`, `vectorIndexes: []`,
plus `name` and `shape`. The top-level `SchemaIR` needs `vectorIndexes: []` too.

**Verify**: `pnpm --filter "@cirrus/codegen..." run build` → exit 0, then
`pnpm --filter "@cirrus/codegen" run test -- run-codegen` → all pass, including
your 7 new tests under "emitShard — table columns".

### Step 2: Typecheck and lint

**Verify**:

- `pnpm --filter "@cirrus/codegen" run lint:types` → exit 0
- `pnpm --filter "@cirrus/codegen" run lint:eslint` → exit 0

## Test plan

- New tests: 7 `it` cases in a `describe("emitShard — table columns")` block in
  `packages/codegen/__tests__/run-codegen.test.ts`, covering system-field
  prepend, scalar type, optional unwrap, defaulted-optional, FK ref, storage
  flag, and the empty-schema constant.
- Structural pattern to follow: the existing `describe("emitShard — studio
features", …)` and `describe("emitShard — storage rules", …)` blocks in the
  same file.
- Verification: `pnpm --filter "@cirrus/codegen" run test -- run-codegen` → all
  pass, with 7 new tests reported.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@cirrus/codegen..." run build` exits 0
- [ ] `pnpm --filter "@cirrus/codegen" run test -- run-codegen` exits 0; the
      block `emitShard — table columns` with 7 tests appears and passes
- [ ] `pnpm --filter "@cirrus/codegen" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/codegen" run lint:eslint` exits 0
- [ ] `git status` shows only `packages/codegen/__tests__/run-codegen.test.ts`
      modified (no other files)
- [ ] `plans/README.md` status row for 019 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `emit.ts:1143–1172` doesn't match the "Current state" excerpt
  (the helper has drifted since this plan was written).
- Any new test FAILS in a way that indicates the helper is wrong (e.g. an
  optional column is NOT marked `optional: true`). That's a real bug to report,
  not a test to weaken — do not change `emit.ts` to make it pass.
- Making a test pass appears to require exporting `buildTableColumns` or editing
  any out-of-scope file.

## Maintenance notes

- If `EmittedColumn` gains a field (e.g. a `nullable` flag distinct from
  `optional`), add a case here and update the `CIRRUS_TABLE_COLUMNS` type
  assertion in case 7.
- These tests assert on `JSON.stringify`-formatted fragments; if the emitter
  ever switches off 4-space pretty-printing the per-line `toContain` assertions
  still hold (they match single `"key": value` substrings), but the empty-map
  assertion in case 7 (`= {}`) is format-sensitive — revisit it if the
  stringify options change.
- A reviewer should confirm the tests assert the _unwrapped_ type for optionals
  (case 3), since that's the subtlest branch.
