# Plan 102: Close the mask() value-oracle on the index-reader paths (withIndex / withSearchIndex)

> **Executor instructions**: Follow step by step; run each verify. This is a
> SECURITY fix — honor the STOP conditions strictly. Update `plans/README.md`
> when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/server/src/mask packages/server/src/facade.ts`
> If `mask/middleware.ts` changed, compare the excerpts below against live code
> before proceeding; a mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

The recent security remediation (commit `1246948c`) hardened `mask()` against a
value-oracle on the `where`/`count`/`aggregate`/`groupBy`/`.filter` paths: a
caller must not be able to filter by a masked column and binary-search the exact
value the mask hides. But the fix did **not** cover the two index-reader entry
points — `withIndex` and `withSearchIndex`. `ctx.db.query('users').withIndex(
'by_email', q => q.eq('email', arg)).first()` (or the search-index equivalent)
still returns the matching (masked) row, confirming the value of a masked column
via the index range/search term. This is the same PII-confirmation leak the
remediation set out to close, still open on the index path. Search indexes on
email/phone are common, so `withSearchIndex` is the more plausible vector.

**Precondition (bounds severity)**: the app must (a) declare a `mask()` on the
table, (b) have a normal index or search index on the masked column, and (c)
expose a query that lets the caller supply the index range/search term. That is
the same precondition the fixed `where` oracle had — it is a real leak, not
hypothetical, but it is not "every masked table".

## Current state

`packages/server/src/mask/middleware.ts` — `wrapReader` re-wraps `withIndex` /
`withSearchIndex` to mask the _output_ rows but never checks whether the range /
search term references a masked column (`middleware.ts:285-286`):

```ts
            withIndex: (indexName, range) => wrapReader(reader.withIndex(indexName, range), columns),
            withSearchIndex: (indexName, search) => wrapReader(reader.withSearchIndex(indexName, search), columns),
```

Contrast the `where` path, which already fails closed
(`middleware.ts:390-406`):

```ts
const assertWhereAllowed = (tableName: string, where: unknown, method: string): void => {
    const columns = perTable.get(tableName);
    if (!columns || where === undefined) return;
    const referenced = new Set<string>();
    collectWhereFields(where, referenced);
    for (const field of referenced) {
        if (field in columns) {
            throw new LunoraError("MASK_UNSUPPORTED", `${method}() filtering "${tableName}" by masked column "${field}" is not supported`);
        }
    }
};
```

`collectWhereFields` (`middleware.ts:361-374`) recursively walks a `where` object
collecting referenced field names into a `Set`. `perTable` is
`Map<string, MaskColumns<Context>>` (`middleware.ts:520`); `columns` (a
`MaskColumns`) supports `field in columns` membership.

The `.filter` path masks the row _before_ the predicate
(`middleware.ts:261-265`) — that pattern (mask-then-observe) is not available for
an index range because the range constrains _which rows are fetched_, before any
row exists to mask. So the fix must be **reject**, mirroring `assertWhereAllowed`,
not mask-then-filter.

**Reachability confirmed**: `ctx.db.query(table)` is the documented fluent reader
and the per-table facade's `withSearchIndex` routes straight through it
(`packages/server/src/facade.ts:287`):

```ts
        withSearchIndex: (indexName, search) => writer.query(tableName).withSearchIndex(indexName, search),
```

**Key difficulty**: the mask middleware has no schema, so it cannot map an
`indexName` → its columns directly. The range/search is a _builder callback_
(`range`/`search` are functions like `q => q.eq('email', arg)` /
`q => q.search('email', arg)`), so the referenced fields aren't a plain object
you can walk like `where`. Two viable strategies (Step 1 picks one).

## Commands you will need

| Purpose         | Command                                          | Expected              |
| --------------- | ------------------------------------------------ | --------------------- |
| Build (deps)    | `pnpm --filter "@lunora/server..." run build`    | exit 0                |
| Typecheck       | `pnpm --filter "@lunora/server" run lint:types`  | exit 0                |
| Test            | `pnpm --filter "@lunora/server" run test`        | all pass              |
| Lint            | `pnpm --filter "@lunora/server" run lint:eslint` | exit 0                |
| Find mask tests | `ls packages/server/__tests__ \| grep -i mask`   | existing mask test(s) |

## Scope

**In scope**:

- `packages/server/src/mask/middleware.ts` — the `withIndex` / `withSearchIndex`
  wrappers in `wrapReader`, plus any small helper needed to detect referenced
  masked fields.
- The existing mask middleware test file (add cases) — find it via the grep above.

**Out of scope**:

- The already-fixed `where`/`count`/`aggregate`/`groupBy`/`.filter` paths — do
  not touch their logic.
- `@lunora/do`'s actual index execution — the fix lives entirely in the mask
  middleware boundary.
- The RLS middleware (separate concern).

## Git workflow

- Branch: `advisor/102-mask-index-reader-oracle`
- Commit: `security(server): close mask value-oracle on withIndex/withSearchIndex`
  (if commitlint rejects `security`, it is in the enum per the Wave 3 note — but
  if the hook fails, use `fix(server): …`).
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Choose the detection strategy

**Strategy A (precise — preferred): intercept the builder callback.** Wrap the
`range`/`search` callback so the `q` it receives is a recording proxy that logs
every field name passed to `q.eq/gt/gte/lt/lte/search/...`. Run the user's
callback against the recording proxy (a dry pass) to collect referenced fields,
check them against `columns` (`field in columns`), throw `MASK_UNSUPPORTED` if
any is masked, and only then pass the _real_ builder through to
`reader.withIndex/withSearchIndex`. Read the builder interface the underlying
`reader.withIndex`/`withSearchIndex` expects (find the `IndexRangeBuilder` /
`SearchFilterBuilder` type — grep `packages/server/src` and `packages/do/src`
for `withIndex`/`withSearchIndex` signatures) so the recording proxy implements
the same method surface and each method returns the proxy (chainable).

**Strategy B (blunt — fallback): reject any index read on a masked table.** If
the builder surface is too large/unstable to proxy safely, throw
`MASK_UNSUPPORTED` for `withIndex`/`withSearchIndex` on any table in `perTable`
(i.e. any masked table), with a message explaining the constraint. This is safe
(fails closed) but over-broad: it breaks legitimate index queries over the
table's _non-masked_ columns. Only choose B if A proves infeasible, and record
the tradeoff.

Decide A vs B by reading the builder types. Prefer A.

**Verify** (after deciding, before coding): note in your working log which
strategy and why.

### Step 2: Implement the guard

For Strategy A: add a helper `collectIndexFields(builderCallback): Set<string>`
(or inline) using the recording proxy; then in the `withIndex`/`withSearchIndex`
wrappers, before delegating, run the guard:

```ts
withIndex: (indexName, range) => {
    assertIndexFieldsAllowed(range, columns, "withIndex");   // throws MASK_UNSUPPORTED if a masked field is referenced
    return wrapReader(reader.withIndex(indexName, range), columns);
},
withSearchIndex: (indexName, search) => {
    assertIndexFieldsAllowed(search, columns, "withSearchIndex");
    return wrapReader(reader.withSearchIndex(indexName, search), columns);
},
```

Reuse the `MASK_UNSUPPORTED` `LunoraError` and a message shaped like
`assertWhereAllowed`'s (`withIndex() filtering "<table>" by masked column
"<field>" is not supported`).

**Verify**: `pnpm --filter "@lunora/server" run lint:types` → exit 0.

### Step 3: Tests

Add cases to the mask middleware test:

1. `withSearchIndex('by_email', q => q.search('email', 'a@b.c'))` on a table
   masking `email` → throws `MASK_UNSUPPORTED` (this is the headline oracle).
2. `withIndex('by_email', q => q.eq('email', 'a@b.c'))` on a masked `email` →
   throws `MASK_UNSUPPORTED`.
3. `withIndex('by_created', q => q.eq('createdAt', …))` on the same masked table
   but a **non-masked** column → allowed, and returned rows are still masked
   (Strategy A must pass this; Strategy B will fail it — if you chose B, this
   test asserts the rejection and you must document the regression).
4. Existing `where`/`count` oracle tests still pass (regression).

**Verify**: `pnpm --filter "@lunora/server" run test` → all pass.

## Test plan

- Extend the existing mask middleware test file (found via `ls
packages/server/__tests__ | grep -i mask`). Use its existing harness for
  building a masked `ctx.db` and a fake reader. If it already tests
  `assertWhereAllowed`, mirror that setup for the index cases.
- The four cases above. Case 3 is the discriminator between Strategy A (passes)
  and B (rejects) — its assertion depends on your Step 1 choice.
- Verification: `pnpm --filter "@lunora/server" run test` → all pass.

## Done criteria

- [ ] `withIndex` / `withSearchIndex` on a masked table throw `MASK_UNSUPPORTED` when the range/search references a masked column.
- [ ] (Strategy A) index reads over non-masked columns of a masked table still work and still mask output rows.
- [ ] Existing `where`/`count`/`aggregate`/`groupBy`/`.filter` oracle tests unchanged and passing.
- [ ] `pnpm --filter "@lunora/server" run lint:types` + `run test` + `run lint:eslint` exit 0.
- [ ] `git status` shows only in-scope files.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The builder (`range`/`search`) surface cannot be safely proxied (e.g. it's a
  frozen host object, or methods have side effects that make a dry pass unsafe) —
  fall back to Strategy B and clearly document the non-masked-column regression;
  do NOT ship a proxy you're unsure records completely (an incomplete recorder
  that misses a field name would leave the oracle open — worse than the blunt fix).
- Running the user callback twice (dry pass + real pass) is observably unsafe
  because the callback has side effects — STOP; the builder callbacks should be
  pure, but if not, Strategy B is required.
- The excerpts in "Current state" don't match live code (drift) — STOP.
- The fix would need to touch `@lunora/do`'s index execution — it must not; the
  boundary is the mask middleware. STOP if you can't guard it there.

## Maintenance notes

- If a new chainable index-reader entry point is added to the reader interface
  (beyond `withIndex`/`withSearchIndex`), it must get the same guard — the oracle
  class is "any caller-controlled predicate over a masked column".
- A reviewer should specifically try to construct a bypass: a search index whose
  builder references a masked field through an alias/computed path the recorder
  might miss. The recorder must catch every field-naming method.
- This mirrors `assertWhereAllowed`; keep the two in sync if the masked-column
  membership model changes.
