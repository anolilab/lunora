# Plan 265 — Make `v.bigint()` and `v.bytes()` round-trip on the Durable Object row store

**Baseline:** `071c6a29c` (2026-08-01)
**Status:** TODO
**Priority:** P1 · **Effort:** M · **Risk:** MED · **Category:** bug

> **Executor instructions**: follow this plan step by step, run every verification
> command, and confirm the expected result before moving on. If a STOP condition
> in §8 occurs, stop and report — do not improvise. When done, update this plan's
> row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 071c6a29c..HEAD -- packages/shard-engine/src/ctx-db.ts packages/shard-engine/src/do-sql.ts packages/shard-engine/src/ctx-db-cdc.ts packages/sql-store/src/value-codec.ts`
> If any of those changed, compare the §1 excerpts against live code before
> proceeding; on a mismatch treat it as a STOP condition.

## 0. Headline finding

The Durable Object row store serializes documents with a **raw `JSON.stringify`**
and reads them back with a **bare `JSON.parse`**. Two declared column types are
therefore unusable on the primary backend:

- A document with a `v.bigint()` column **throws** out of `ctx.db.insert` —
  `TypeError: Do not know how to serialize a BigInt` — a raw, unmapped 500, not a
  `LunoraError`. (Verified: `JSON.stringify({a:10n})` throws exactly that.)
- A document with a `v.bytes()` column **silently corrupts**: a `Uint8Array`
  stringifies to `{"0":1,"1":2,…}` and a bare `ArrayBuffer` to `{}`. The write
  SUCCEEDS and the payload is permanently lost — read back as an empty/garbage
  object. (Verified: `JSON.stringify({c:new ArrayBuffer(4)})` yields `{"c":{}}`.)

The `.global()` twin already has a per-column codec that handles both
(`packages/sql-store/src/value-codec.ts`), so these types work on D1/Hyperdrive
and fail on the default shard-local path — the exact inversion of what "default
topology" promises.

**First-party impact, on the money path**: `@lunora/payment`'s `paymentSessions`
table declares `amountMinor`, `capturedMinor`, `refundedMinor` as `v.bigint()`
(`packages/payment/src/schema.ts:50-57`) on a **shard-local** table — verified:
the `defineTable(...)` chain at `schema.ts:49-62` has only `.index(...)` calls,
no `.global()`. Any app using `@lunora/payment` without `.global()`-izing that
table hits the raw TypeError on its first payment session insert.

**Folded-in sibling** (MED confidence, see §9): `sqliteDecode` in the sql-store
codec has **no `bytes` branch**, so a decoded BLOB comes back as whatever the
driver returns (workerd D1 `ArrayBuffer`, node:sqlite `Uint8Array`, mysql2/pg
`Buffer`). `v.bytes()` validates `value instanceof ArrayBuffer`
(`packages/values/src/v.ts:733`), so a read-then-rewrite of a bytes column fails
re-validation on every backend whose driver does not return `ArrayBuffer` —
invisible on D1, breaks on the Hyperdrive Postgres/MySQL backends.

## 1. Current state (audit)

**The write side — five raw `JSON.stringify` sites in
`packages/shard-engine/src/ctx-db.ts`** (`grep -n "JSON.stringify" packages/shard-engine/src/ctx-db.ts`
finds exactly these document-blob sites plus the `:2336` CAS fallback and an
error-message use at `:173`):

- `insert`, `ctx-db.ts:3252`:

    ```ts
    runWrite(
        sql,
        tableName,
        dsql`INSERT INTO ${dsql.identifier(tableName)} (id, _creationTime, ${dsql.identifier(DOC_COLUMN)}) VALUES (${id}, ${creationTime}, ${JSON.stringify(documentWithMeta)})`,
    );
    ```

- `insertManyUnsafe`, `ctx-db.ts:3345`:

    ```ts
    const valuesSql = dsql.join(
        rows.map((row) => dsql`(${row.id}, ${row.creationTime}, ${JSON.stringify(row.document)})`),
        dsql`, `,
    );
    ```

- `patch`, `ctx-db.ts:3463`:

    ```ts
    dsql`UPDATE ${dsql.identifier(tableName)} SET ${dsql.identifier(DOC_COLUMN)} = ${JSON.stringify(merged)} WHERE id = ${id} AND ${dsql.identifier(DOC_COLUMN)} = ${existingJson}`,
    ```

- `replace`, `ctx-db.ts:3890` — same shape, plus `_creationTime`.
- soft `delete`, `ctx-db.ts:2624` — same `UPDATE … SET __doc__ = ${JSON.stringify(merged)}` shape.

Also: the CDC log stores the same blob — `packages/shard-engine/src/ctx-db-cdc.ts:63`
`const docValue = doc === undefined ? null : JSON.stringify(doc);` and reads it
back at `:106` with a bare `JSON.parse(row.doc)`.

**The read side — one choke point.** `packages/shard-engine/src/do-sql.ts:113-127`:

```ts
const rowToDocument = (row: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!row) {
        return undefined;
    }

    const raw = row[DOC_COLUMN];
    let parsed: Record<string, unknown>;

    if (typeof raw === "string") {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } else if (raw && typeof raw === "object") {
```

There is **no per-column codec anywhere on this path**.

**The `.global()` twin has one.** `packages/sql-store/src/value-codec.ts:25-38`:

```ts
if (typeof value === "bigint") {
    return value.toString();
}

// Bytes bind directly as a BLOB (SQLite) / BYTEA (Postgres). Must precede the
// JSON fallback — `JSON.stringify(uint8array)` would corrupt it into `{"0":…}`
// (silently tolerated by SQLite's loose affinity, rejected by Postgres BYTEA).
if (value instanceof Uint8Array) {
    return value;
}

if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
}
```

And the rank companion carries the same warning —
`packages/shard-engine/src/rank.ts:210-213`: "`serializeSqlValue` turns
bigint/Date/object into a string|number|null, where raw bigint would crash
JSON.stringify". The main row-storage path is the only one without protection.

**The validators genuinely produce these values.** `packages/values/src/v.ts:708-717`
(`v.bigint()` parses to a real `bigint`, rejecting anything with
`typeof value !== "bigint"`) and `:730-739` (`v.bytes()` requires
`value instanceof ArrayBuffer` at `:733`).

**The sibling decode gap.** `packages/sql-store/src/value-codec.ts:100-125`
`sqliteDecode`'s switch handles `any`/`union`, `array`/`object`/`record`,
`bigint`, `boolean` — and then:

```ts
default: {
    return raw;
}
```

No `case "bytes"`. `decodeRow` (`packages/sql-store/src/sql-exec.ts:180`) runs
every column through `sqliteDecode`, so a bytes column decodes to the raw driver
value.

**No existing test covers row storage of these types.** Verified: every `bigint`
hit in `packages/do/__tests__` is about the WIRE or log normalization, not row
storage — `shard-do.stream.test.ts:154` (wire-encoded stream args),
`shard-do.batch.test.ts:68-69` (wire-encoded batch args),
`wire-subscription.test.ts:9-50` (delta frames), `shard-do.admin.test.ts:2373`
(log-field normalization), `shard-do.test.ts:1044` (decodeWire DoS bound).
Nothing inserts a `v.bigint()`/`v.bytes()` column through `ctx.db` into a
shard-local table. The test plan must add exactly that.

## 2. Existing seams (do not reinvent)

- **`shared/wire-codec.ts`** — `encodeWire` / `decodeWire` (exported at `:423`),
  the repo's tagged JSON-safe value codec, built for exactly this problem: its
  header docblock lists `v.bigint()` ("JSON.stringify(1n) **throws**") and
  `v.bytes()` ("silently yields `{}` — silent data loss") as its reasons to
  exist. Key properties: a self-delimiting `$lunora.wire$` sentinel with an
  `"arr"` collision escape, a 64-level depth cap, and — load-bearing here — the
  documented fidelity guarantee: _"A value with no special leaves encodes to a
  structurally identical JSON tree (same bytes)"_. It is bundler-inlined
  (relative import, no dependency edge) and `packages/shard-engine/src` already
  consumes it in `relay-hub.ts`, `shape-global-diff.ts`, and
  `subscription-delivery.ts`.
- **`do-sql.ts` `rowToDocument`** (`:113`) and its tolerant twin (`:146-156`) —
  the read-side choke points. Consumers (verified by grep): `ctx-db.ts`,
  `ctx-db-backfill.ts`, `ctx-db-companions.ts`, `ctx-db-rank-page.ts`,
  `ctx-db-shapes.ts`, plus the barrel `index.ts`. Routing decode through here
  covers every reader at once.
- **`sql-store` `value-codec.ts`** — `sqliteEncode` / `sqliteDecode` /
  `effectiveColumnKind` (which already unwraps `v.optional(...)`), and its
  dedicated suite `packages/sql-store/__tests__/value-codec.test.ts`.
- **`locateRowById`** (`ctx-db.ts:2287`) captures the exact stored blob for the
  OCC CAS (`:2336-2338` — `docJson`), which is what makes a byte-identical
  encoding for unaffected docs a hard requirement (§3).

Reminder: the sync `SqlExec` (DO) vs async `SqlCtxExec` (global) divide is
deliberate and a merge was spike-rejected. This plan makes a **tandem edit**
(engine codec + sql-store `bytes` decode branch), it does not unify the stores.

## 3. The behavioural contract to preserve

- **Existing rows must keep parsing.** Rows already on disk are plain JSON; the
  new decode must accept them unchanged. No data migration, no rewrite pass.
- **Docs without bigint/bytes leaves must encode byte-identically** to today's
  `JSON.stringify` output. The OCC CAS (`ctx-db.ts:3463/:3890/:2624`) compares
  the stored blob string captured at read time, and the companion/CDC/where-SQL
  paths read the same blob — `json_extract(__doc__, '$.field')`
  (`do-sql.ts:42`) must see the same value for every non-bigint/bytes column.
  `encodeWire`'s fidelity guarantee provides this; assert it in a test.
- **Wire behavior is already correct and separate.** Subscriptions/deltas encode
  bigint/bytes via the wire codec at the transport layer
  (`packages/do/__tests__/wire-subscription.test.ts`). Do not double-encode:
  storage encode/decode happens strictly below the transport encode.
- **`v.bytes()` keeps returning `ArrayBuffer`** (`v.ts:733`) — do not widen the
  validator to accept views.
- **Public exports unchanged**: `DOC_COLUMN`, `rowToDocument`, `sqliteEncode`,
  `sqliteDecode`, `effectiveColumnKind` keep their names and signatures (a new
  export alongside them is fine).
- `shared/wire-codec.ts` itself must **not change** — it is inlined into the
  client SDK; a format change there is a wire-protocol change (STOP condition).

## 4. Design decisions

**D1 — Fix the storage codec (option i); do NOT reject bigint/bytes at
`defineSchema` (option ii).** Option (ii) — refusing `v.bigint()`/`v.bytes()`
columns on non-`.global()` tables until a codec lands — was considered as a
smaller first step: it converts silent corruption into a build error. Rejected
as the shipped answer because it would break `@lunora/payment` outright (a
first-party package already declaring `v.bigint()` on a shard-local table,
§0) and would permanently demote two documented column types to second-class on
the **default** backend while they work on the opt-in one. If phase 1 hits its
STOP condition (no backward-compatible encoding), option (ii) becomes the
fallback plan — re-scope, do not improvise it in.

**D2 — Reuse `shared/wire-codec.ts`'s `encodeWire`/`decodeWire` for the doc
blob, wrapped in a storage-named pair.** Add `encodeDocJson(doc): string` /
`decodeDocJson(raw): Record<string, unknown>` in `do-sql.ts` (implemented as
`JSON.stringify(encodeWire(doc))` / `decodeWire(JSON.parse(raw))`). Rejected
alternative: a bespoke storage replacer/reviver reusing `sqliteEncode`'s
untagged forms (`bigint → "10"`, bytes → base64 string). That encoding is
**ambiguous on read** without per-column kind lookups threaded into every
reader (`rowToDocument` has no schema access today), and it is lossy for
untagged strings that look like the encoded form. The wire codec is tagged,
self-delimiting, collision-escaped, already inlined into this package, and
byte-identical for unaffected docs — exactly the backward-compat property §3
requires. Trade-off accepted: `encodeWire` also tags `Date`/`Map`/`Set`/
`undefined`-in-arrays and **throws `TypeError` on non-plain objects**. Validated
documents cannot contain those (validators emit JSON scalars + `bigint` +
`ArrayBuffer`), and on the validator-skipping `insertManyUnsafe` path a tagged
`Date` round-tripping is strictly better than today's silent `{}`.

**D3 — Route ALL doc-blob writes and reads through the new pair**, including the
CDC log (`ctx-db-cdc.ts:63/:106`) — a CDC consumer replaying a bigint row must
not crash where the row store no longer does. Rejected alternative: fixing only
the five `ctx-db.ts` sites — leaves `recordCdc` throwing the same raw TypeError
one line after a successful insert.

**D4 — sql-store `bytes` decode branch normalizes to a plain `ArrayBuffer`,
slicing on `byteOffset`/`byteLength`.** A `Buffer` is a view over a shared pool;
`view.buffer` without slicing leaks unrelated pool bytes. Use
`raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)` for any
`ArrayBuffer.isView(raw)` value, pass a genuine `ArrayBuffer` through, leave
everything else verbatim. Rejected alternative: widening `v.bytes()` to accept
views — public validator contract change, touches every consumer typed to
`ArrayBuffer`.

## 5. Workstreams

### W1 (S) — `do-sql.ts`: the codec pair + decode choke point

In `packages/shard-engine/src/do-sql.ts`:

1. Import `decodeWire, encodeWire` from `../../../shared/wire-codec` (relative,
   **no `.js` extension**; check the tsconfig note about `shared/` consumers in
   `CLAUDE.md` — shard-engine already imports `shared/` files, so the
   `outDir`/`rootDir` accommodation should already be in place; verify).
2. Add named exports (named-only, no default):

    ```ts
    const encodeDocJson = (document: Record<string, unknown>): string => JSON.stringify(encodeWire(document));
    const decodeDocJson = (raw: string): Record<string, unknown> => decodeWire(JSON.parse(raw)) as Record<string, unknown>;
    ```

3. In `rowToDocument` (`:122`) replace `JSON.parse(raw)` with
   `decodeDocJson(raw)`. Check the tolerant twin at `:146-156` (it delegates to
   `rowToDocument`, so it should need no change — verify).

**Verify**: `pnpm --filter "@lunora/shard-engine" run lint:types` → exit 0.

### W2 (M) — `ctx-db.ts` + `ctx-db-cdc.ts`: the write sites

Replace `JSON.stringify(<doc>)` with `encodeDocJson(<doc>)` at exactly:
`ctx-db.ts:3252` (insert), `:3345` (insertManyUnsafe), `:3463` (patch), `:3890`
(replace), `:2624` (soft delete), and the CAS fallback at `:2336`
(`JSON.stringify(rawDocument ?? {})` → `encodeDocJson(...)` — this branch only
fires when the driver returns a non-string blob; keep the `?? {}`). In
`ctx-db-cdc.ts`: `:63` encode, `:106` decode. Then re-grep:
`grep -n "JSON.stringify" packages/shard-engine/src/ctx-db*.ts` — the only
remaining hits must be non-doc uses (the `:173` error message). Do NOT touch
`estimate-bytes.ts`, `rank.ts`, or the wire/transport call sites.

**Verify**: `pnpm --filter "@lunora/shard-engine" run test` → all pass;
`pnpm --filter "@lunora/do" run test` → all pass (the ~1100-test consumer suite;
this is the main compat gate — OCC, companions, CDC, subscriptions all exercise
the blob).

### W3 (S) — sql-store: `sqliteDecode` bytes branch

In `packages/sql-store/src/value-codec.ts`, add to the `sqliteDecode` switch
(before `default`):

```ts
case "bytes": {
    if (raw instanceof ArrayBuffer) {
        return raw;
    }

    if (ArrayBuffer.isView(raw)) {
        // Slice on the view's window — a Buffer is a view over a shared pool,
        // and `.buffer` without slicing would leak unrelated pool bytes.
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    }

    return raw;
}
```

**Verify**: `pnpm --filter "@lunora/sql-store" run test` → all pass.

### W4 (M) — Tests

See §"Test plan".

## 6. Platform parity

**Not applicable — no new `ctx.*` surface, binding, or capability.** This plan
makes two _existing, declared_ column types behave as documented on the existing
Cloudflare host (shard-local DO SQLite) and completes their decode on the
existing `.global()` backends (D1, node:sqlite reference host, Hyperdrive
Postgres/MySQL). No `PlatformCapabilities` row changes; the honest note is that
W3 is what makes `v.bytes()` actually conform on the non-D1 global backends.

## 7. Phasing & ordering

| Phase | Work    | Gate                                                                                                                        |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1     | W1 + W2 | New round-trip tests fail pre-fix, pass post-fix; `@lunora/shard-engine` + `@lunora/do` suites green (backward-compat gate) |
| 2     | W3      | New `value-codec` bytes tests fail pre-fix, pass post-fix; `@lunora/sql-store` suite green                                  |
| 3     | W4 rest | Byte-identical-encoding assertion + legacy-row fixture test green; benches within noise (see §8 perf watch)                 |

Phases 1 and 2 are independent (tandem edit, either order); phase 3 last.

## Commands you will need

| Purpose           | Command                                                                                                 | Expected         |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| Build deps        | `pnpm run build:packages`                                                                               | exit 0           |
| Typecheck         | `pnpm --filter "@lunora/shard-engine" run lint:types`                                                   | exit 0           |
| Typecheck         | `pnpm --filter "@lunora/sql-store" run lint:types`                                                      | exit 0           |
| Tests (engine)    | `pnpm --filter "@lunora/shard-engine" run test`                                                         | all pass         |
| Tests (do)        | `pnpm --filter "@lunora/do" run test`                                                                   | all pass         |
| Tests (sql-store) | `pnpm --filter "@lunora/sql-store" run test`                                                            | all pass         |
| Lint              | `pnpm --filter "@lunora/shard-engine" run lint:eslint`                                                  | exit 0           |
| Benches           | `pnpm --filter "@lunora/do" run test:bench` (check the script name in `packages/do/package.json` first) | numbers recorded |

Note: `pnpm --filter "<pkg>..." run build` does **not** walk the workspace graph
in this repo. Use `pnpm run build:packages` once. Some `@lunora/do` suites are
workerd-gated behind `LUNORA_WORKERD_TESTS=1` — run the gated suite once for
phase 1 if your environment supports it (the D1/workerd driver is where the
"blob comes back as `ArrayBuffer`" claim is checked).

## Scope

**In scope:**

- `packages/shard-engine/src/do-sql.ts`
- `packages/shard-engine/src/ctx-db.ts` (only the enumerated stringify sites)
- `packages/shard-engine/src/ctx-db-cdc.ts`
- `packages/sql-store/src/value-codec.ts`
- `packages/shard-engine/__tests__/` (extend `ctx-db.test.ts` or add
  `ctx-db.bigint-bytes.test.ts`; extend `ctx-db.cdc.test.ts`)
- `packages/sql-store/__tests__/value-codec.test.ts` (extend)

**Out of scope:**

- `shared/wire-codec.ts` — wire-protocol surface, inlined into the client; any
  change here is a STOP condition.
- `packages/values/src/v.ts` — the validators are correct.
- `packages/payment/**` — it becomes correct by virtue of the engine fix.
- `packages/server/src/schema.ts` / codegen — no schema-time rejection ships
  (see D1).
- `packages/shard-engine/src/rank.ts`, `estimate-bytes.ts` — the rank companion
  is already safe; the estimator's unserializable-value handling is **plan 270**
  (which cross-references this plan: today's unserializable values are exactly
  these bigint docs, and after this plan lands that overlap disappears).

## Git workflow

- Branch: `advisor/265-do-bigint-bytes-roundtrip`
- Conventional commits (no `dx` type), e.g.
  `fix(shard-engine): encode bigint/bytes doc columns so they round-trip on the DO row store`
  and `fix(sql-store): decode BLOB columns back to ArrayBuffer for v.bytes()`
- Do NOT push or open a PR unless the operator asked for it.

## Test plan

Every new test must be **demonstrated to fail against pre-fix code**: stash the
source change (`git stash push -- packages/shard-engine/src packages/sql-store/src`),
run the test, see it fail, restore. Expected pre-fix failures are named below.

1. **bigint round-trip** (`packages/shard-engine/__tests__/`): schema with a
   `v.bigint()` column; `ctx.db.insert` then `get`/`findMany` returns the same
   `bigint` (`expect(row.amount).toBe(10n)`); `patch` preserves it. Pre-fix:
   insert rejects with `TypeError: Do not know how to serialize a BigInt`.
2. **bytes round-trip**: `v.bytes()` column with a distinctive payload; read
   back an `ArrayBuffer` with identical bytes; cover insert, patch, replace, and
   soft-delete's re-stamped doc. Pre-fix: read back `{}` (assert the corruption
   to prove the failure mode).
3. **CDC round-trip** (extend `ctx-db.cdc.test.ts`): after inserting a bigint
   row, `readCdcChanges` yields a doc whose bigint survives. Pre-fix: throws.
4. **Backward compat / byte identity**:
    - Hand-INSERT a row with today's plain-JSON blob via raw SQL (model on any
      existing raw-SQL fixture in the suite), then read through `ctx.db.get` —
      identical result. (This passes pre- and post-fix by design — it is the
      no-regression guard, not the failing test.)
    - `expect(encodeDocJson(plainDoc)).toBe(JSON.stringify(plainDoc))` for a doc
      with no bigint/bytes/Date leaves — the CAS/json_extract guarantee.
5. **sql-store bytes decode** (extend `value-codec.test.ts`):
   `sqliteDecode(new Uint8Array(pool, 8, 4), "bytes")` returns an `ArrayBuffer`
   of exactly those 4 bytes (the Buffer-pool slice case);
   `sqliteDecode(arrayBuffer, "bytes")` passes through; `null` stays `null`;
   `effectiveColumnKind(v.optional(v.bytes()))` resolves `"bytes"`. Pre-fix:
   the view comes back unconverted and `value instanceof ArrayBuffer` fails.
6. **Consumer suite**: full `pnpm --filter "@lunora/do" run test` — the engine's
   largest consumer (~1100 tests) — green.

## Done criteria

ALL must hold:

- [ ] `grep -n "JSON.stringify" packages/shard-engine/src/ctx-db.ts` shows no doc-blob site (only the `:173`-style error-message use)
- [ ] `grep -n "encodeDocJson\|decodeDocJson" packages/shard-engine/src/do-sql.ts` shows both exports
- [ ] `grep -n "case \"bytes\"" packages/sql-store/src/value-codec.ts` hits
- [ ] `pnpm --filter "@lunora/shard-engine" run lint:types` and `lint:eslint` exit 0
- [ ] `pnpm --filter "@lunora/shard-engine" run test` exits 0
- [ ] `pnpm --filter "@lunora/do" run test` exits 0
- [ ] `pnpm --filter "@lunora/sql-store" run test` exits 0
- [ ] Each new test demonstrated to fail against pre-fix code
- [ ] `git status` shows no files modified outside the in-scope list
- [ ] `plans/README.md` status row updated

## 8. Risks & STOP conditions

- **STOP if a backward-compatible encoding cannot be delivered** — i.e. any
  existing `@lunora/do` or `@lunora/shard-engine` test fails because a stored
  blob changed for a doc with no bigint/bytes leaves (OCC CAS mismatches,
  companion/where-SQL/golden-fixture diffs). That falsifies D2's byte-identity
  assumption; fall back to design option (ii) as a re-scoped plan, do not patch
  around individual failures.
- **STOP if the fix appears to require editing `shared/wire-codec.ts`** — that
  is a wire-protocol change with client-side consumers; report instead.
- **STOP if you find a reader of `__doc__` that does not go through
  `rowToDocument`/`decodeDocJson`** (grep `DOC_COLUMN` consumers) and cannot be
  routed through it — a second decode path would silently show tagged arrays to
  callers.
- **Risk:** a `v.bigint()`/`v.bytes()` column used in a `.index()` or `where`
  is read in SQL via `json_extract` and would see the tagged array, not the
  value. Today those columns cannot be stored at all, so no working behavior
  regresses — but record the SQL-side semantics question in §9 rather than
  solving it here.
- **Perf watch:** `encodeWire` walks the doc tree on every write. Run
  `packages/do/__bench__/write-throughput-insert-bare.bench.ts`,
  `write-throughput-patch.bench.ts`, `write-throughput-replace.bench.ts` before
  and after; a regression beyond noise (>~5%) is a report-back, not a silent
  accept.

## 9. Open questions (answer during execution)

1. **SQL-side semantics for bigint/bytes columns** — should `.index()`/`where`
   over such a column be rejected at schema time (they compare tagged JSON, not
   values), or documented as unsupported? Record the answer; do not implement a
   rejection in this plan unless a test forces the question.
2. **Per-driver BLOB return types** (the MED-confidence half): confirm on a real
   run what a BLOB read returns under workerd D1 (`ArrayBuffer` expected),
   node:sqlite (`Uint8Array`), pg/mysql2 (`Buffer`). One workerd-gated
   (`LUNORA_WORKERD_TESTS=1`) or integration check is enough; record findings.
3. Does any Studio/observability read path parse `__doc__` directly (outside
   `rowToDocument`)? Grep `DOC_COLUMN` across `packages/*/src` and record.
4. `insertManyUnsafe` docs containing `Date`/`Map` (validator-skipping path) now
   round-trip via tags instead of degrading to `{}` — is that worth a docs note
   in `packages/do/docs/`? Record, don't expand scope.

---

## 11. Thermos review — BLOCKED, do not merge as implemented

A thermo-nuclear review ran real probes against a `node:sqlite` ctx-db harness and
found the implementation converts a **loud** failure into a **silent wrong answer**
on the exact path this plan named as its motivation (`@lunora/payment`'s money
columns). Reviewer verdict: _not safe to land as-is_. The advisor confirmed the
headline mechanism directly.

### H1 — `v.bigint()` becomes silently unqueryable

`encodeDocJson` stores a bigint as a tagged **array**; every query-side path still
serializes the comparison value through `serializeSqlValue`
(`packages/shard-engine/src/serialize-sql.ts:21-23`), which renders it as the
decimal string `"10"`. `json_extract` returns the array text. They can never match.

```
STORED:         {"amount":["$lunora.wire$","bigint","10"],…}
JSON_EXTRACT:   "[\"$lunora.wire$\",\"bigint\",\"10\"]"
FILTER MATCHES: 0     INDEX MATCHES: 0     SUM: 0
```

Before this branch `ctx.db.insert` threw and the developer picked another type.
After it, the insert succeeds and a balance check silently reads zero.

**Why the tests missed it**: `__tests__/ctx-db.bigint-bytes.test.ts:31` declares
`indexes: []` and never filters, orders or aggregates on the new columns.

### H2 — the write is already broken, and 270 breaks it completely

`recordWrite` sizes documents with `estimateBytes`, a bare `JSON.stringify` that
throws on bigint and charges the `maxWrittenBytes` fallback — so **one bigint write
per mutation is the hard ceiling**, and the second fails naming a 64 MB payload for
a 40-byte row. Worse: **plan 270** changes `estimateBytes` to return `undefined` and
`recordWrite` to throw `BAD_REQUEST` on it, so with both branches landed a bigint
insert fails immediately. **265 and 270 must land together or not at all.**

### H3 — byte-identity is false for four reachable shapes

Array-position `undefined`, `NaN`, `Infinity` and `Date` all change on-disk bytes
AND read-back type. Nothing gates them: there is no document-shape validation on
`ctx.db.insert`, and `v.any()`/`v.object()`/`v.record()` pass anything through.
Because `patch` rewrites the whole document, **the first patch of a legacy row
silently migrates it** — a rolling, write-triggered format change, not a cutover.

### H4 — previously-valid writes now throw untyped errors

`encodeWire` rejects non-plain objects **before** consulting `toJSON()`, and caps
nesting at 64 (a bound chosen for an untrusted _wire_, not for storage). A `v.any()`
field holding a `Decimal`/luxon `DateTime`/`Temporal.Instant` used to store its
`toJSON()` form and now hard-fails, as a raw `TypeError`/`RangeError` that surfaces
as an opaque redacted `RPC_FAILED`.

### M1 / M2 — read and egress paths

`introspect.ts`'s `safeParseObject` (its own private `DOC_COLUMN` copy is why it
escaped the sweep) and `observability/src/storage-correlation.ts:42` don't decode —
this is plan **300**. Separately, `export`/CDC egress returns _decoded_ values
through `jsonResponse`, which is plain `Response.json` with no `encodeWire`, so
bytes reach a replica/backup as `{}` and a bigint makes the whole admin response
throw.

### What has to happen before this can land

1. **Reconcile the query side with the codec** — either teach `serializeSqlValue`
   the tagged form, or store bigint/bytes in a `json_extract`-comparable shape.
   This is the core design question the plan did not ask.
2. **Teach `estimateBytes` about the codec** (jointly with 270).
3. **Decide explicitly** on Date / NaN / Infinity / array-`undefined` / `toJSON` /
   depth-64. This probably wants a **storage-shaped codec mode** distinct from the
   wire-shaped one, rather than reusing the wire codec verbatim.
4. Decode on introspection reads (plan 300) and re-encode on admin/CDC egress.
5. Tests that **filter, index and aggregate** on a bigint column — the coverage
   whose absence hid all of this.
