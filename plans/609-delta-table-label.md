# Plan 609 — A row delta names its table only when the query read exactly one

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report — do
> not improvise. A reviewer dispatched you and maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: branch `fix/improve-609-delta-table-label` starts at `origin/alpha`
> `26351bfca`. `git log --oneline -1` → `26351bfca`. Then
> `git diff --stat 26351bfca..HEAD -- packages/do/src/shard-do.ts packages/shard-engine/src/subscription-delivery.ts`
> must print nothing.

**Baseline:** `26351bfca` (`origin/alpha`, 2026-11-13)
**Status:** DONE — APPROVED after one review round (test renamed; API snapshot recorded by a
fresh executor because the first declined a mid-task message). PR
https://github.com/anolilab/lunora/pull/1595 (commits `0cd8b7741`, `d2810720b`, `ba5ac565d`).
Owner decision 2026-11-13: options C + A. Reviewer re-ran: `@lunora/do` unit + workerd,
`@lunora/shard-engine` unit + workerd, client conformance, python/rust/java SDK suites and
generated-check, `api:check`, eslint/types, red-without-fix. Swift (no XCTest here), Go, Ruby,
Kotlin and Dart not run.
**Source:** lead from the review of PR #1593 (team-chat membership): a member's socket received a
new message for `messages:list` as a `delta` frame with `"table": "members"`.

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW (a wire value changes for multi-table live
  queries; no in-repo consumer reads it) · **Depends on**: none · **Category**: bug (mislabel) + docs

## 0. Headline finding

A re-execution row delta (`{type:"delta", id, delta:{key, op, row?, table}}`) carries the **first
table the query read**, not the table the changed row came from.
`examples/team-chat`'s `messages:list` reads `members` (membership check) before `messages`, so
every row delta it sends says `"table": "members"`. It happens every time; the reviewer saw it only
once because the server sends a `delta` only when a baseline exists and the deltas are smaller than
a `data` snapshot. The value has no functional effect: the reference client and all eight SDK
ports check only that `table` is a string and merge by `key`/`_id`. But the wire claims something
false, the spec never defines the field, and `@lunora/client` exports the `MutationDelta` type, so
an outside consumer could key a per-table cache by it.

The server cannot stamp the true per-row table: the diff runs over the query's _result_, ids are
random UUIDs (`packages/shard-engine/src/ctx-db.ts:2724`), and results can be projected or built
rows.

## 1. Current state (audit)

`packages/do/src/shard-do.ts:17701-17719` (inside the subscription push path):

```ts
const frames = subscriptionFrames({
    // … cursorSuffix, diffKey, lastMutationId, nextResult, pageDeltas, previousJson, snapshotJson,
    subId,
    // First REAL dependency, never the unvouchable sentinel. `tables` is
    // insertion-ordered, so a query that read `ctx.kv` before touching a
    // table would otherwise put `UNVOUCHABLE_DEP` on the wire as this
    // frame's `table` — an internal name leaking to every client and all
    // eight SDK ports. The field is a structural guard rather than a
    // routing key, so a wrong value is inert, but an internal marker is
    // not something to publish and then rely on nobody reading.
    table: [...outcome.tables].find((dep) => dep !== UNVOUCHABLE_DEP) ?? "",
});
```

`outcome.tables` is a `Set<string>` (`shard-do.ts:986`), the read set in read order.

`packages/shard-engine/src/subscription-delivery.ts:21-27`:

```ts
/**
 * Fallback table name stamped on a delta when the subscription's read-table
 * set is empty. The client only uses `table` for its structural guard
 * ({@link MutationDelta} recognition) — `key`/`row`/`op` drive the actual
 * merge — so any non-empty string is safe.
 */
const DELTA_FALLBACK_TABLE = "__lunora__";
```

and `subscription-delivery.ts:304`: `const deltaTable = table === "" ? DELTA_FALLBACK_TABLE : table;`.
The module's exports are on line 583:
`export { awaitWsDrain, subscriptionFrames, subscriptionListDeltas, trySendFrame };`
and re-exported by `packages/shard-engine/src/index.ts:471`.

`UNVOUCHABLE_DEP` (`"!unvouchable"`) is defined in `packages/shard-engine/src/read-footprint.ts:118`
and exported there; `shard-do.ts:267` imports it from `@lunora/shard-engine`.

**Placeholder choice: `"__lunora__"` (the existing `DELTA_FALLBACK_TABLE`).** Every name with a
leading `__` is reserved for framework tables (`shared/internal-table-name.ts:10`,
`RESERVED_TABLE_PREFIX = /^(?:sqlite_|_cf_|__)/u`), and codegen refuses to declare one
(`packages/codegen/src/discover/schema/internal/table-builder.ts:122-126`, `isInternalTableName`).
No framework table is named exactly `__lunora__`. So it can never be a real user table, it is a
legal string for every port's guard, and zero-table read sets already get it today.
**Rejected: the subscription's function path** (e.g. `messages:list`). It is what clients send as
`subscribe.query.table` for the legacy `broadcastDelta` fan-out (§5.1), so reusing it in a
re-execution delta blurs two different meanings of `table`, and it changes per query, so a consumer
could mistake it for a routing key. `"!unvouchable"` and `"*"` (the admin wildcard,
`packages/do/src/admin-readers.ts:41`) were also rejected: both are internal dependency markers.

**Zero-table read sets** (a query that read only `ctx.kv`, or nothing) already get `"__lunora__"`
via the `""` fallback. That is consistent with the new rule ("no single table to name") and is not
a bug. It stays.

**Studio admin reads** return `tables: new Set(["*"])` (`shard-do.ts:13342` etc.). A single-entry
set means they keep stamping `"*"` as today. That is out of scope (Studio uses the JS client, which
ignores the value) and the plan does not change it.

**Other producers, meaning unchanged and out of scope:**

- `subscriptionListDeltas(previousJson, nextResult, table)` (`subscription-delivery.ts:371`), a
  public helper whose caller passes `table`.
- `ShardDO.broadcastDelta` / `matchesSubscription` (`shard-do.ts:6703-6735`), the legacy fan-out of
  _write-side_ `MutationDelta`s whose `table` is the real written table.
- Shape pokes' `RowOp.table` (`packages/shard-engine/src/shape-diff.ts:109`), the shape's resolved
  table.
- The write-side `MutationDelta` in `packages/shard-engine/src/schema-types.ts:762`, which is a real
  table. Do not touch its doc.

**Consumers (all accept any string; no table-name validation):** `packages/client/src/delta-merge.ts:65-77`,
`sdks/python/lunora/delta.py:23`, `sdks/go/lunora/delta.go:39-42`, `sdks/rust/src/delta.rs:44`,
`sdks/kotlin/src/RowDelta.kt:34`, `sdks/swift/Sources/Lunora/Delta.swift:33`,
`sdks/dart/lib/src/delta_merge.dart:27`, `sdks/java/src/dev/lunora/DeltaMerge.java:62`,
`sdks/ruby/lib/lunora/delta.rb:23`.

**Protocol versioning.** There is no protocol version field. §5.1.1's rule is that a `caps` token
names "wire behaviours the client can handle that older clients cannot". Every client already
accepts any string here, so no token and no version note are needed.

## 2. Existing seams (do not reinvent)

- `subscriptionFrames({ table, … })` is the only place the delta envelope is written. Do not
  rebuild it.
- `DELTA_FALLBACK_TABLE` is the placeholder. Rename it and export it; do not introduce a second
  literal.
- The test harness in `packages/do/__tests__/shard-do.test.ts`, `describe("shardDO subscription
delta push")`: the `ReexecShard` class with `shard.outcomes.set(path, { result, tables })`,
  `subscribeMessages`, `filler(16)`, `idRow(id, extra?)`, `shard.changedTableOnRpc`,
  `shard.writeRpc()`. Model the new tests on the existing test **"first push is a data snapshot; an
  additive change pushes a delta frame"**.
- `pageDeltaFrames` in `protocol/fixtures/ws-frames.json`: each case is
  `{ name, $comment, baseWire, frame, expect }`, and every suite loops over the array.

## 3. The behavioural contract to preserve

- A single-table query's deltas keep naming that table byte-for-byte (`"messages"`). All existing
  `@lunora/do` and `@lunora/shard-engine` tests must pass unchanged.
- Merging by `key`/`_id` and insert placement do not change.
- `table` stays present and a string on every row delta. Omitting it would make all nine clients
  stop recognising row deltas.

## 4. Design decisions

- **Rule:** read set minus `UNVOUCHABLE_DEP` has exactly one entry → that entry; otherwise (zero,
  or two or more) → `"__lunora__"`. _Over:_ "first table read" (today's behaviour, which mislabels)
  and per-row provenance (L effort; impossible for projected rows).
- **Location:** one exported helper `deltaTableFor` in `subscription-delivery.ts`, beside the
  constant it returns; `shard-do.ts` calls it. _Over:_ inlining the rule in `shard-do.ts`, which
  would need the constant exported anyway and would split the rule from the placeholder.
- **Name:** rename `DELTA_FALLBACK_TABLE` → `DELTA_PLACEHOLDER_TABLE` and export it, because it is
  now part of the documented wire contract and tests import it. This is a pre-release branch, so
  there is no alias.

## 5. Steps

All commands run from the worktree root.

### Step 1 — the rule (shard-engine)

In `packages/shard-engine/src/subscription-delivery.ts`:

1. Rename `DELTA_FALLBACK_TABLE` to `DELTA_PLACEHOLDER_TABLE` everywhere in the file. Replace its
   doc comment with one that says why: it is the `table` stamped on a row delta when the
   subscription's read set does not name exactly one table (multi-table or no-table reads). A
   result row carries no provenance, so the server cannot say which table it came from. The leading
   `__` is reserved by `isInternalTableName`, so it never collides with a user table. Clients merge
   by `key` and must not route by it (protocol README §5.1.1).
2. Add `import { UNVOUCHABLE_DEP } from "./read-footprint";` (check `read-footprint.ts` does not
   import `subscription-delivery.ts`. If it does, a cycle exists: STOP).
3. Add, after the constant:

```ts
/**
 * The `table` a subscription's row deltas carry: the one table it read, or
 * {@link DELTA_PLACEHOLDER_TABLE} when it read several or none. Naming the
 * first of several would claim every changed row came from that table.
 * @returns the single read table, or the placeholder
 */
const deltaTableFor = (tables: Iterable<string>): string => {
    let only: string | undefined;

    for (const table of tables) {
        if (table === UNVOUCHABLE_DEP) {
            continue;
        }

        if (only !== undefined) {
            return DELTA_PLACEHOLDER_TABLE;
        }

        only = table;
    }

    return only ?? DELTA_PLACEHOLDER_TABLE;
};
```

4. Line 583 export becomes
   `export { awaitWsDrain, DELTA_PLACEHOLDER_TABLE, deltaTableFor, subscriptionFrames, subscriptionListDeltas, trySendFrame };`
   and `packages/shard-engine/src/index.ts:471` re-exports the same list. Keep the `table === ""`
   fallback at line 304 (it still serves `subscriptionListDeltas` callers); just rename the constant.
   Also update the `table` field doc on `SubscriptionFrameInput` (`/** The table stamped on each
delta; "" falls back to … */`) to the new constant name.

Verify: `pnpm --filter "@lunora/shard-engine..." run build` exits 0.

### Step 2 — unit test for the helper (shard-engine)

In `packages/shard-engine/__tests__/subscription-frames.test.ts`, add a `describe("deltaTableFor")`
following that file's existing style (read it first: imports, `expect.assertions`, naming). Cases:

- `["messages"]` → `"messages"`
- `["members", "messages"]` → `DELTA_PLACEHOLDER_TABLE`
- `[UNVOUCHABLE_DEP, "messages"]` → `"messages"`
- `[]` and `[UNVOUCHABLE_DEP]` → `DELTA_PLACEHOLDER_TABLE`
- `DELTA_PLACEHOLDER_TABLE` equals `"__lunora__"` (pins the wire value)

Verify: `pnpm --filter "@lunora/shard-engine" run test` → all pass.

### Step 3 — use it (do)

In `packages/do/src/shard-do.ts`, import `deltaTableFor` in the existing `@lunora/shard-engine`
import block (next to `subscriptionFrames`, keep it alphabetised), and replace the comment and the
`table:` line shown in section 1 with:

```ts
            // One table read → its name; several or none → a placeholder.
            // A result row has no provenance, so naming the first of several
            // tables would mislabel rows from the others (protocol §5.1.1).
            table: deltaTableFor(outcome.tables),
```

If `UNVOUCHABLE_DEP` is still used elsewhere in `shard-do.ts` (it is, at line 12046), keep its
import.

Verify: `pnpm --filter "@lunora/do..." run build` exits 0.

### Step 4 — tests that must fail without the fix (do)

In `packages/do/__tests__/shard-do.test.ts`, inside `describe("shardDO subscription delta push")`,
directly after the test "first push is a data snapshot; an additive change pushes a delta frame",
add two tests modelled on it:

1. `"a query that read two tables stamps the placeholder, not the first table, on a row delta"`:
   `tables: new Set(["members", "messages"])` on BOTH `outcomes.set` calls; first result
   `[...filler(16), idRow("a")]`, second `[...filler(16), idRow("a"), idRow("b", { text: "hi" })]`;
   `changedTableOnRpc = "messages"`; assert the last frame `toMatchObject({ id: "sub-1", type: "delta" })`
   and its `delta` `toStrictEqual({ key: "b", op: "insert", row: idRow("b", { text: "hi" }), table: DELTA_PLACEHOLDER_TABLE })`.
   Import `DELTA_PLACEHOLDER_TABLE` from `@lunora/shard-engine`; check the file's existing
   imports first and add `@lunora/shard-engine` to `packages/do/package.json` dependencies only if it
   is not already there. It should already be a dependency; if it is not, STOP.
2. `"a single-table query still names its table, even after an unvouchable read"`: same shape with
   `tables: new Set([UNVOUCHABLE_DEP, "messages"])`, asserting `table: "messages"`.

Red-without-fix: temporarily restore the old `table:` line in `shard-do.ts`, rebuild `@lunora/do`
(`pnpm --filter "@lunora/do" run build`), run
`pnpm --filter "@lunora/do" exec vitest run __tests__/shard-do.test.ts -t "placeholder"`. Test 1
must FAIL with `"members"` received. Restore the fix, rebuild, and it must pass. Report both
outputs. Do not commit the reverted state.

Verify: `pnpm --filter "@lunora/do" run test` → all pass.

### Step 5 — protocol spec

In `protocol/README.md` §5.1.1, directly after the paragraph that begins
"A conforming `pageDelta` client applies a delta to a paginated value by merging" (ends "…as a full
`data` snapshot instead."), add a paragraph (wrap like the surrounding text):

> **`delta.table`.** A row delta's `table` names the table the query read when it read exactly one;
> a query that read several tables, or none, gets the placeholder `"__lunora__"` instead (a leading
> `__` is reserved for framework tables, so no user table has that name). The server diffs the
> query's result, whose rows carry no record of their source table, so it cannot name the table
> of each row. A client MUST NOT route, key or filter by this field: the merge is by `key` / `_id`
> alone, and `table` only marks the payload as a row delta (it must be a string). Before this rule,
> a multi-table query's deltas carried the first table it read.

Leave the "Before this rule…" sentence out if the surrounding §5.1.1 text never records history;
check and decide (repo rule: comments and docs say why, they do not record history). Prefer leaving
it out.

### Step 6 — golden fixture

In `protocol/fixtures/ws-frames.json`, append a NINTH case to `pageDeltaFrames`, after
`delta-unrecognised-payload-replaces` only if that is the last element; otherwise after
`delta-bare-array-update`. Shape it on `delta-bare-array-update` exactly (same `baseWire`, same
`expect`) but with:

- `"name": "delta-multi-table-placeholder"`
- `"$comment": "A query that read more than one table (here a membership check, then messages) stamps the placeholder \"__lunora__\" on its row deltas (protocol README 5.1.1). The merge is by key; the table field only has to be a string."`
- `"delta": { "key": "m1", "op": "update", "row": { "_creationTime": 1001, "_id": "m1", "text": "ONE" }, "table": "__lunora__" }`

Keep the file's formatting (4-space indentation, one-line `delta` object as in the neighbour).
Verify: `node -e 'const d=require("./protocol/fixtures/ws-frames.json");console.log(d.pageDeltaFrames.length, d.pageDeltaFrames.at(-1).name)'`
(or the index you inserted at) prints `9`.

### Step 7 — suites that pin the case count

Each of these asserts exactly 8 `pageDeltaFrames` cases; change 8 → 9 and the word "eight" →
"nine" in the message, nothing else:

- `sdks/go/lunora/conformance_test.go` (~line 1035)
- `sdks/dart/test/frame_cases.dart` (~line 116)
- `sdks/rust/tests/conformance.rs` (~line 636)
- `sdks/java/test/dev/lunora/ConformanceTest.java` (~line 950)
- `sdks/swift/Tests/LunoraTests/ConformanceTests.swift` (~line 645)
- `sdks/kotlin/test/ConformanceTest.kt` (~line 905)

Then grep for any other count: `grep -rn "pageDeltaFrames" sdks packages/client/__tests__` and
look within 5 lines of each hit for `8`/`eight`. Python, Ruby and the TS client loop without a
count; leave them.

Verify (runnable here):

- `pnpm --filter "@lunora/client..." run build` then
  `pnpm --filter "@lunora/client" exec vitest run __tests__/protocol-conformance.test.ts` → pass,
  and the output lists `delta-multi-table-placeholder`.
- `bash sdks/run-all.sh python rust java swift` → `PASS` for each. If a toolchain is missing,
  report it rather than installing anything.

### Step 8 — client-facing docs

- `packages/client/src/delta-merge.ts`, the local `interface MutationDelta`: add a doc comment on
  `table` saying it is the single table the query read, or `"__lunora__"` when it read several or
  none, and that the merge never uses it (protocol README §5.1.1). Do not change code.
- `sdks/README.md` footnote 7 (the line starting with the superscript seven and
  "**A row-change `delta` frame is merged"): directly after the sentence ending
  "with the normative insert placement (protocol README §5.1.1)." insert this exact text:

```text
`table` is the query's one read table, or `"__lunora__"` for a query that read several or none; no port routes or keys by it.
```

### Step 9 — gates

- `pnpm --filter "@lunora/shard-engine" run lint:eslint` and `pnpm --filter "@lunora/do" run lint:eslint`
  (or the package's `lint` script if `lint:eslint` does not exist; check `package.json`) → 0 errors
  on the touched files.
- `pnpm --filter "@lunora/shard-engine" run lint:types`, `pnpm --filter "@lunora/do" run lint:types`
  (if the script exists) → exit 0.
- `pnpm exec oxfmt --check <each touched .ts/.md/.json file>` (or `pnpm exec prettier --check` if
  oxfmt is not how the repo formats; read root `package.json` `lint:oxfmt`) → clean.
- API snapshot: do NOT run `api:check` / `api:update` yourself (they need every package built,
  which you must not do). The reviewer builds all packages and runs `api:check`. If the
  shard-engine snapshot drifts, the reviewer will ask you to run `pnpm run api:update` in a
  follow-up message.

### Step 10 — commit

Stage explicit paths only. Commit message:

```
fix(do): name a delta's table only for a single-table query

A re-execution row delta carried the first table its query read, so a query that checked
membership before listing messages labelled new messages "members". A read set naming one table
keeps that table; several or none now send the "__lunora__" placeholder. Wire-visible for
multi-table live queries; every in-repo client only checks the field is a string.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

(Header ≤ 100, body lines ≤ 100. Allowed types only. No `--no-verify`.)

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding changes.

## 7. In scope / out of scope

**In scope (only these files):** `packages/shard-engine/src/subscription-delivery.ts`,
`packages/shard-engine/src/index.ts`, `packages/shard-engine/__tests__/subscription-frames.test.ts`,
`packages/do/src/shard-do.ts`, `packages/do/__tests__/shard-do.test.ts`, `protocol/README.md`,
`protocol/fixtures/ws-frames.json`, `packages/client/src/delta-merge.ts`, `sdks/README.md`, the six
SDK test files in Step 7, `api-snapshots/shard-engine.api.md`.

**Out of scope:** `broadcastDelta` / `matchesSubscription`, `shape-diff.ts`, `schema-types.ts`'s
`MutationDelta`, every SDK _source_ file (no port needs a code change), `examples/*`,
`plans/*`, `admin-readers.ts`.

## 8. Risks & STOP conditions

- **STOP** if any existing `@lunora/do` or `@lunora/shard-engine` test fails after Step 3 for a
  reason other than an assertion that a multi-table query stamps its first table. Report the test.
- **STOP** if any SDK source (not test) appears to need a change for the new fixture case to pass:
  that would mean a port validates the table name, which the audit says none does.
- **STOP** if `api:check` reports a diff in any snapshot other than shard-engine.
- **Risk:** a longer placeholder can change which of delta vs snapshot is smaller. The tests use 16
  filler rows, which keeps deltas cheaper; if the new do test receives a `data` frame instead,
  raise the filler count rather than weakening the assertion, and say so in NOTES.

## 9. Open questions

1. (Reviewer) Should the Studio admin wildcard `"*"` also map to the placeholder? Deferred: not a
   user-facing query, and outside the owner's rule.
