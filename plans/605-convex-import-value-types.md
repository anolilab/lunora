# Plan 605 — `lunora import` refuses Convex values it would silently change

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. Do not update `plans/README.md`; your reviewer
> maintains the index.
>
> **Drift check (run first)**:
> `git diff --stat 4121b67cc..HEAD -- packages/cli/src/commands/data-transfer/import-source.ts apps/docs/src/content/docs/migrating/from-convex.mdx`
> If either file changed, compare the "Current state" excerpts below with the
> live code. If they do not match, treat it as a STOP condition.

**Baseline:** `4121b67cc` (2026-11-12)
**Status:** DONE (PR https://github.com/anolilab/lunora/pull/1585, commit 36d056f17; revision 1 exempted `{ $storage: id }` storage references)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW. The change only adds refusals, and a refusal names the field.
- **Depends on**: none
- **Category**: bug (data correctness)
- **Planned at**: commit `4121b67cc`, 2026-11-12

## 0. Headline finding

The audit lead claimed that a Convex snapshot encodes some types as JSON and
relies on a `generated_schema.jsonl` type map, which Lunora ignores. That
premise is out of date, but there is a real silent loss.

Since March 2026, Convex writes snapshots in a **uniform, lossless** format, and
`generated_schema.jsonl` contains just the string `"uniform"`. In that format:

- an **Int64** is a bare JSON integer (`123`);
- a finite **Float64** always has a dot or an exponent (`123.0`, `1e20`);
- **Bytes** are `{"$bytes":"<base64>"}`;
- a **NaN or ±Infinity float** is `{"$float":"<base64>"}`.

Lunora's Convex reader (`wrapJsonlLines` in `import-source.ts`) runs a plain
`JSON.parse` over each line and forwards the result verbatim, which causes three
silent losses:

1. **An Int64 above 2^53 is rounded.** `JSON.parse("9007199254740993")` gives
   `9007199254740992`. That number passes `v.number()` and `v.any()` validation
   on the target, so a wrong id or counter lands with no error.
2. **`{"$bytes":…}` and `{"$float":…}` are stored as plain objects** in any
   `v.any()` or loosely typed column.
3. **Older snapshots are also affected.** A snapshot exported before March 2026
   writes Int64 as a decimal string, Bytes as a base64 string and NaN/Infinity as
   `"NaN"` / `"Infinity"`. Only its `generated_schema.jsonl` shape says which is
   which. Lunora never reads that file, so those values arrive as strings in any
   `v.string()` or `v.any()` column.

Typed columns are not affected: `v.bigint()`, `v.bytes()` and `v.number()` already
reject these values with a VALIDATION_ERROR. The loss is the untyped case and
the rounding.

**Converting is not possible today.** The worker's import endpoint parses each
NDJSON line with a bare `JSON.parse` (`packages/runtime/src/import-stream.ts:44`)
and never wire-decodes `doc`. So a `bigint` or an `ArrayBuffer` cannot travel to
a `v.bigint()` / `v.bytes()` column through `lunora import` from any source. The
fix therefore follows the repo's stated rule for lossy imports (header of
`packages/cli/src/commands/data-transfer/sources/reshape.ts`): **refuse, and name
the field.**

## 1. Evidence

- Convex docs, Data Types (<https://docs.convex.dev/database/types>): Int64 and
  Bytes are not plain JSON types, and Inf/NaN are serialised specially.
- Convex docs, Import (<https://docs.convex.dev/database/import-export/import>):
  "ZIP imports can additionally import other Convex values: Int64, Bytes, etc.
  Types are preserved in the ZIP file through the `generated_schema.jsonl` file."
- Convex backend source (`get-convex/convex-backend`):
    - `crates/exports/src/zip_uploader.rs`: documents are written with
      `ValueFormat::ConvexExportJSON`, and `write_legacy_generated_schema` writes
      `"uniform"`.
    - `crates/value/src/export.rs` `export_clean_lossless`: Int64 is a JSON number,
      a finite float is a number with a dot, a non-finite float uses the internal
      `$float` encoding, and Bytes is `{"$bytes":…}`.
    - Commit "Change the zip export format to be uniform and not shape-dependent
      (#48031)", 2026-03-11, says the format "encodes both finite floating point
      numbers and int64s as JSON numbers, distinguishing the two by the presence of
      a decimal point (i.e. `1.0` vs `1`)".
    - The old format: `export_clean` (Int64 as a string, Bytes as base64, NaN as
      `"NaN"`). `crates/application/src/snapshot_import/parse.rs`
      `parse_generated_schema`: the first line is either `"uniform"` or a shape
      string such as `{_creationTime: normalfloat64, _id: id<t>, n: int64}`.
    - `crates/shape_inference/src/pretty.rs`: the shape tokens are `int64`,
      `float64`, `-inf`, `inf`, `NaN`, `normalfloat64`, `bytes`, `string`,
      `unknown`, ….
- Convex forbids object field names that start with `$`. So any object key in
  `documents.jsonl` that starts with `$` is an encoded value, never user data.

## 2. Current state

`packages/cli/src/commands/data-transfer/import-source.ts`:

- Lines 1-17 hold the imports. `stat` from `node:fs/promises`, `LunoraError`
  from `@lunora/errors`, and `readSnapshotLines` / `ConvexSnapshot` /
  `ConvexSnapshotTable` from `../convex-snapshot` are already imported.
- Lines 30-60, `wrapJsonlLines`. The part this plan changes:

```ts
let document: unknown;

try {
    document = JSON.parse(line);
} catch (error: unknown) {
    throw new LunoraError(
        "INTERNAL",
        `${tableEntry.table}/documents.jsonl line ${String(lineNumber)}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
    );
}

sourceRows.set(tableEntry.table, (sourceRows.get(tableEntry.table) ?? 0) + 1);

yield`${JSON.stringify({ doc: document, table: tableEntry.table })}\n`;
```

- Lines 76-110, `readConvexExport(snapshot, tables, logger, storageMigrated,
sourceRows)`. It is an exported async generator. It skips `_`-prefixed system
  tables, seeds `sourceRows`, then does `yield* wrapJsonlLines(snapshot,
tableEntry, sourceRows);`.

`ConvexSnapshot` (from `packages/cli/src/commands/convex-snapshot.ts`, read-only
for this plan) has two shapes: `{ kind: "directory"; root }` and `{ kind: "zip";
zip: AdmZip; zipPath; storagePrefix }`. A `ConvexSnapshotTable` is `{ file,
table }`:

- in a directory, `file` is the absolute path to `<table>/documents.jsonl`;
- in a zip, `file` is the archive entry name, for example
  `snapshot_123/users/documents.jsonl`.

`readSnapshotLines(snapshot, entry)` streams any such file's lines, and works for
both shapes as long as `entry.file` points at an existing file or entry.

What happens on a refusal: an error thrown from this generator surfaces as a
`streamFailure`. The import's first pass is a dry-run check (`?dryRun=true`), so
a refusal stops the command before the write pass and exits non-zero. Plan steps
do not need to change `import.ts`.

Repo conventions:

- No `.js` in relative imports.
- A file with more than one export uses named exports only.
- Each `eslint-disable` is line-scoped with a `-- reason`.
- Comments say _why_.
- Errors use `new LunoraError("INTERNAL", message)` in the existing
  `<table>/documents.jsonl line N: …` style.

## 3. Behavioural contract to preserve

- Rows with ordinary values still import byte-for-byte as today. That covers
  strings, booleans, null, arrays, plain objects, finite floats (`1.5`,
  `1700000000000.0`, `1e20`) and integers whose magnitude is at most
  `Number.MAX_SAFE_INTEGER`.
- A string that merely looks numeric (`"9007199254740993"`) is a string and is
  never refused.
- The existing error text for invalid JSON is unchanged.
- `convex-snapshot.ts` is NOT modified. Open PR #1543 edits it, so leaving it
  alone avoids a conflict.

## 4. Design decisions

- **Refuse rather than convert.** The import endpoint cannot carry bigint or
  bytes (see §0). The alternative, writing Int64 as a decimal string the way
  Supabase's `int8-string` reshape does, would need an opt-in mapping file per
  column. That is more surface than this bug warrants. Record it as a follow-up.
- **Refuse only unsafe integers, not every Int64.** An Int64 with |n| ≤ 2^53−1
  is represented exactly by a JS number, so nothing is lost. Refusing every
  Int64 would block migrations that lose nothing.
- **Detect unsafe integers from the JSON source text**, using the reviver's third
  `context` argument (`context.source`, the JSON.parse-with-source feature,
  available in Node ≥ 22 / V8 ≥ 11.4; the CLI's `engines` is
  `^22.15.0 || >=24.11.0`). A literal without `.`, `e` or `E` is an Int64. One
  with them is a float, and large floats are legitimate.
    - Fail closed: if `context?.source` is `undefined` for an unsafe integer, treat
      it as an Int64 and refuse.
- **Detect old-format snapshots from the sidecar.** If
  `<table>/generated_schema.jsonl` exists and its first non-empty line parses to
  a string other than `"uniform"`, it is a shape. If that shape mentions any of
  `int64`, `bytes`, `float64`, `NaN`, `inf`, `-inf` or `unknown` as a token,
  refuse the whole table before streaming any of its rows.
    - The field path is not known in this case, because no shape parser is being
      written. The message quotes the shape (truncated to 300 chars) and tells the
      operator to re-export from Convex.
    - Field names or string literals that equal one of those tokens give a false
      refusal. That is acceptable, because it fails closed.
    - `normalfloat64` must NOT match. It is finite floats only and imports
      losslessly.

## 5. Platform parity

Not applicable. This is a CLI-only data-import change, with no `ctx.*` surface
and no binding.

## Commands you will need

Run all of these from the worktree root that your dispatcher gave you.

| Purpose                              | Command                                                                                                                                                                                                               | Expected                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Install                              | `pnpm install`                                                                                                                                                                                                        | exit 0                                                                                                               |
| Build the CLI and its workspace deps | `pnpm --filter "@lunora/cli..." run build`                                                                                                                                                                            | exit 0                                                                                                               |
| New tests                            | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/convex-import-values.test.ts`                                                                                                                         | all pass                                                                                                             |
| Neighbouring suites                  | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/data-transfer.test.ts __tests__/commands/import-storage.test.ts __tests__/commands/convex-snapshot.test.ts __tests__/commands/import-sources.test.ts` | all pass                                                                                                             |
| Full CLI suite                       | `pnpm --filter "@lunora/cli" run test`                                                                                                                                                                                | all pass, except `mcp-serve` and `codegen-watch`, which may time out in the full run; re-run them alone if they fail |
| Format TS                            | `pnpm exec oxfmt packages/cli/src/commands/data-transfer/import-source.ts packages/cli/__tests__/commands/convex-import-values.test.ts`                                                                               | exit 0                                                                                                               |
| Format MDX                           | `pnpm exec prettier --write apps/docs/src/content/docs/migrating/from-convex.mdx`                                                                                                                                     | exit 0                                                                                                               |
| ESLint                               | `pnpm --filter "@lunora/cli" exec eslint src/commands/data-transfer/import-source.ts __tests__/commands/convex-import-values.test.ts --max-warnings=0`                                                                | exit 0                                                                                                               |
| Types                                | `pnpm --filter "@lunora/cli" run lint:types`                                                                                                                                                                          | exit 0                                                                                                               |

Do NOT run `pnpm run build`, `pnpm run build:packages`, `pnpm run test` (whole
repo), `pnpm run test:workerd`, or any `pnpm -r …`.

## Scope

**In scope:**

- `packages/cli/src/commands/data-transfer/import-source.ts`
- `packages/cli/__tests__/commands/convex-import-values.test.ts` (create)
- `apps/docs/src/content/docs/migrating/from-convex.mdx` (one short paragraph)

**Out of scope:**

- `packages/cli/src/commands/convex-snapshot.ts` and its test. Open PR #1543
  edits them.
- `packages/cli/__tests__/commands/import-sources.test.ts`. Open PR #1560 edits
  it; put the new tests in the new file instead.
- `packages/cli/src/commands/data-transfer/sources/*` (the Supabase/Firestore
  readers).
- `packages/runtime/**`, `packages/shard-engine/**`. The endpoint stays as it is.
- `plans/README.md`.

## Git workflow

- Work on the branch already checked out in your worktree. Do not push.
- Make one commit containing the source change, the test file and the docs
  paragraph:

```
fix(cli): refuse convex values the import would change

A Convex snapshot writes Int64 as a bare JSON integer, bytes as {"$bytes"}
and NaN/Infinity as {"$float"}; snapshots from before March 2026 write them as
strings typed only by generated_schema.jsonl. The reader JSON.parsed each line
and passed it on, rounding Int64s above 2^53 and storing the encodings as
objects or strings. It now refuses those values, naming the field.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

- Keep the header ≤ 100 chars and every body line ≤ 100 chars.
- No `--no-verify`. No `git add -A`. Stage the three paths explicitly. Never use
  bare `git stash`.

## Steps

### Step 1: Parse a Convex line with source-aware integers

In `import-source.ts`, above `wrapJsonlLines`, add:

- A class `UnsafeInt64` with a single readonly `source: string` field. It is a
  marker the reviver leaves where an Int64 a JS number cannot hold was.
- `const parseConvexLine = (line: string): unknown => JSON.parse(line, reviver)`,
  where the reviver is
  `(_key: string, value: unknown, context?: { source?: string }) => …`.
    - Declare the third parameter optional. TypeScript's `JSON.parse` reviver type
      has two parameters, and an optional third keeps it assignable.
    - When `typeof value === "number"`, `Number.isInteger(value)` and
      `!Number.isSafeInteger(value)`:
        - if `context?.source` is a string that contains `.`, `e` or `E`, return
          `value`, because it is a float;
        - otherwise return `new UnsafeInt64(context?.source ?? String(value))`.
    - In all other cases return `value`.
    - Add a one-line comment on why the source text is consulted: Convex's lossless
      format tells Int64 from Float64 only by the decimal point.

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 2: Find the first value the import would change

Add `const findLossyValue = (value: unknown, path: string): { path: string; reason: string } | undefined`.
It walks recursively:

- `value instanceof UnsafeInt64`: reason is
  `holds the Int64 ${value.source}, which a JavaScript number cannot represent exactly`.
- An array: recurse into each element with path `${path}[${index}]`.
- A non-null plain object (not an array):
    - if any own key starts with `$`, the reason is
      `holds a Convex-encoded value (${key}: bytes or a NaN/Infinity float), which lunora import cannot carry`;
    - otherwise recurse into each entry with path `path === "" ? key : `${path}.${key}``.
- Anything else: `undefined`.

Return the first hit.

Then, in `wrapJsonlLines`:

- replace `document = JSON.parse(line);` with `document = parseConvexLine(line);`
  (keep the try/catch and its message);
- right after the try/catch and BEFORE `sourceRows.set(…)`, call
  `findLossyValue(document, "")`. If it returns a hit, throw:

```ts
throw new LunoraError(
    "INTERNAL",
    `${tableEntry.table}/documents.jsonl line ${String(lineNumber)}: field \`${hit.path}\` ${hit.reason}; refusing rather than changing it. Store the value as a string in Convex before exporting, or drop the field.`,
);
```

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 3: Refuse old-format tables whose shape carries string-encoded types

Add `const LEGACY_LOSSY_SHAPE_RE = /(?<![\w-])(?:int64|bytes|float64|NaN|-?inf|unknown)(?!\w)/;`.
Put a comment above it saying why these tokens are refused (in the pre-2026
format their values are written as strings that only the shape can decode) and
that `normalfloat64` deliberately does not match.

Add `const refuseLegacyLossyTable = async (snapshot: ConvexSnapshot, tableEntry: ConvexSnapshotTable): Promise<void>`:

1. Build the sidecar entry:
   `const sidecar: ConvexSnapshotTable = { file: tableEntry.file.replace(/documents\.jsonl$/, "generated_schema.jsonl"), table: tableEntry.table };`
   Hoist the regex literal into a module-level constant if the lint rules
   require it.
2. Check that it exists:
    - `snapshot.kind === "directory"` → `(await stat(sidecar.file).catch(() => undefined))?.isFile() === true`;
    - otherwise → `snapshot.zip.getEntry(sidecar.file) !== null`.
    - If it does not exist, return.
3. Read lines with `for await (const raw of readSnapshotLines(snapshot, sidecar))`.
   Take the first line whose `trim()` is non-empty, then `break`.
4. `JSON.parse` that line inside a try/catch. On a parse error, throw a
   `LunoraError("INTERNAL", `${table}/generated_schema.jsonl line 1: invalid JSON — …`)`.
5. If the parsed value is a string, is not `"uniform"`, and
   `LEGACY_LOSSY_SHAPE_RE.test(parsed)`, throw:

```ts
throw new LunoraError(
    "INTERNAL",
    `${tableEntry.table}/generated_schema.jsonl: this table was exported in Convex's pre-2026 format, which writes Int64, bytes and NaN/Infinity values as plain strings that only this shape can decode (${shape}). lunora import would store them as strings; re-export from Convex (current exports are lossless) and import that.`,
);
```

Here `shape` is the parsed string, cut to 300 characters with `…` appended
when longer. Any other parsed value (no file, `"uniform"`, a harmless shape,
or a non-string) returns without error.

In `readConvexExport`, call `await refuseLegacyLossyTable(snapshot, tableEntry);`
immediately before `yield* wrapJsonlLines(…)`. It must stay after the
system-table `continue`.

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 4: Tests

Create `packages/cli/__tests__/commands/convex-import-values.test.ts`. Model its
temp-dir handling on `packages/cli/__tests__/commands/data-transfer.test.ts`
(`mkdtempSync(join(tmpdir(), "lunora-cli-…"))` in `beforeEach`, and `rmSync(…,
{ force: true, recursive: true })` in `afterEach`). Model its zip creation on
`packages/cli/__tests__/commands/import-storage.test.ts` (`AdmZip`, `addFile`,
`writeZip`).

Drive the reader directly:

```ts
import { listConvexSnapshotTables, resolveConvexSnapshot } from "../../src/commands/convex-snapshot";
import { readConvexExport } from "../../src/commands/data-transfer/import-source";
```

Write a helper that:

1. resolves the snapshot and lists its tables;
2. iterates `readConvexExport(snapshot, tables, silentLogger, false, new Map())`;
3. collects each yielded line `JSON.parse`d as `{ doc, table }`.

Write fixture lines as **raw strings**, never with `JSON.stringify` on a number.
Stringifying a number would already round `9007199254740993` and make the test
pass for the wrong reason.

The cases, each its own `it`:

1. **Unsafe Int64 is refused.** `users/documents.jsonl` is
   `{"_id":"u1","_creationTime":1700000000000.5,"big":9007199254740993}\n`.
   Expect the iteration to reject with a message matching
   `/users\/documents\.jsonl line 1: field `big`/` and containing
   `9007199254740993`.
2. **Nested `$bytes` is refused with its path.**
   `{"_id":"u1","list":[{"blob":{"$bytes":"AAE="}}]}`. Expect a message matching
   ``/field `list\[0\]\.blob`/`` and containing `$bytes`.
3. **`$float` is refused.** `{"_id":"u1","score":{"$float":"AAAAAAAA+H8="}}`.
   Expect ``/field `score`/``.
4. **Ordinary values import unchanged.**
   `{"_id":"u1","_creationTime":1700000000000.0,"n":1.5,"count":42,"edge":-9007199254740991,"huge":1e20,"s":"9007199254740993","nested":{"a":[1,2.5]}}`.
   Expect exactly one row whose `doc` `toStrictEqual`s
   `{ _creationTime: 1700000000000, _id: "u1", count: 42, edge: -9007199254740991, huge: 1e20, n: 1.5, nested: { a: [1, 2.5] }, s: "9007199254740993" }`.
5. **An old-format lossy shape is refused before any row.** Write
   `users/generated_schema.jsonl` as
   `"{_creationTime: normalfloat64, _id: id<users>, n: int64}"\n` (a JSON string
   on one line) and `users/documents.jsonl` as `{"_id":"u1","n":"5"}`.
    - Expect a rejection matching `/users\/generated_schema\.jsonl/`.
    - Also assert that zero rows were yielded before the rejection. Collect rows
      in an array outside the `expect(...).rejects` and check `length === 0`.
6. **An old-format harmless shape imports.** The sidecar is
   `"{_creationTime: normalfloat64, _id: id<users>, name: string}"` and the
   document is `{"_id":"u1","name":"a"}`. Expect one row.
7. **A `"uniform"` sidecar imports.** The sidecar is `"uniform"` and the document
   is `{"_id":"u1","count":3}`. Expect one row with `count: 3`.
8. **The zip variant of case 5 is refused.** Build `snapshot.zip` with entries
   `snapshot_1/users/documents.jsonl` and `snapshot_1/users/generated_schema.jsonl`
   carrying the case 5 contents. Expect a rejection matching
   `/generated_schema\.jsonl/`.

Use `expect.assertions(n)` where the file's neighbours do. Never add `.skip`.

**Verify**: the "New tests" command → 8 tests pass. Then the "Neighbouring
suites" command → all pass.

### Step 5: Docs

In `apps/docs/src/content/docs/migrating/from-convex.mdx`, add one paragraph
right after the paragraph that starts `**Your Convex `_id`s carry across
verbatim.**`. Keep the existing 4-space indentation, because it sits inside a
numbered list item.

Content, in the file's voice:

- `lunora import` refuses, naming the table, line and field, any value it could
  not store unchanged:
    - an Int64 outside ±(2^53−1), because a JavaScript number would round it;
    - bytes and NaN/Infinity floats, which the export encodes as `{"$bytes": …}` /
      `{"$float": …}`;
    - any table of a pre-2026 export whose `generated_schema.jsonl` declares
      Int64, bytes or non-finite floats.
- The fix is to store such values as strings in Convex before exporting, or to
  re-export with a current Convex.

**Verify**: `pnpm exec prettier --check apps/docs/src/content/docs/migrating/from-convex.mdx` → exit 0.

### Step 6: Format, lint, full suite, red-without-fix, commit

1. Run the "Format TS" command, then ESLint, then Types → all exit 0.
2. Run the "Full CLI suite" command → it passes, apart from the known
   `mcp-serve` / `codegen-watch` timeouts, which must pass when run alone.
3. Commit (see Git workflow).
4. Red check:
    - `git checkout HEAD~1 -- packages/cli/src/commands/data-transfer/import-source.ts`
    - run the "New tests" command. Cases 1, 2, 3, 5 and 8 MUST fail.
    - `git checkout HEAD -- packages/cli/src/commands/data-transfer/import-source.ts`
    - run the "New tests" command again → all pass.
    - `git status --short` must be clean.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/convex-import-values.test.ts` → 8 passed
- [ ] The neighbouring suites pass. The full CLI suite passes, apart from the
      known timeouts.
- [ ] ESLint (the two files) and `lint:types` exit 0. `prettier --check` on the
      mdx exits 0.
- [ ] The red check shows cases 1, 2, 3, 5 and 8 failing with HEAD~1's
      `import-source.ts`.
- [ ] `git diff --name-only HEAD~1` lists exactly the three in-scope files.
- [ ] `git status --short` is empty.

## STOP conditions

- The `wrapJsonlLines` / `readConvexExport` excerpts do not match the live file.
- `context.source` is `undefined` in the reviver on the Node in use. Check with
  `node -e 'JSON.parse("[9007199254740993]",(k,v,c)=>{if(k==="0")console.log(c&&c.source);return v})'`;
  it must print `9007199254740993`.
- An existing test in the neighbouring suites fails because one of its fixtures
  contains an unsafe integer or a `$`-keyed object. Report which one; do not
  loosen the check.
- The fix seems to need a change to `convex-snapshot.ts`, `import.ts`, or the
  runtime.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If the admin import endpoint ever wire-decodes `doc` (so a `bigint` or an
  `ArrayBuffer` can reach `v.bigint()` / `v.bytes()`), revisit this plan.
  Converting Int64, `$bytes` and `$float` then becomes possible, and is better
  than refusing.
- A deferred option: an opt-in per-column mapping (like the Supabase
  `int8-string` reshape) that writes Int64 as a decimal string.
- If Convex changes its export format again, the place to look is
  `crates/value/src/export.rs` in `get-convex/convex-backend`.
- Expected conflicts: none textual with #1543 (`convex-snapshot.ts`) or #1560
  (`sources/firebase.ts`, `import-sources.test.ts`), because this plan touches
  neither file.
