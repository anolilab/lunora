# Plan 104: Memoize per-table column kinds in the SQL-store row decoder

> **Executor instructions**: Follow step by step; run each verify. STOP
> conditions halt you. Update `plans/README.md` when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/sql-store/src`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

Every `.global()` table read (the D1 adapter path) — plus the admin data-browser
decode and export/import that reuse the same function — decodes each row by
iterating `Object.entries(definition.shape)` and calling `effectiveColumnKind()`
per column, per row. `effectiveColumnKind` recurses for `v.optional(...)`. For an
M-column table returning R rows, that is R×M redundant validator-kind derivations
and R throwaway `Object.entries` array allocations, even though the column→kind
mapping is static per (immutable) table definition. Precomputing it once per
definition removes the per-row recomputation on the hot read path.

## Current state

`packages/sql-store/src/ctx-db.ts:359-376`:
```ts
const decodeGlobalRow = (definition: TableDefinitionLike, row: Record<string, unknown>): Record<string, unknown> => {
    const decoded: Record<string, unknown> = {};
    for (const [field, validator] of Object.entries(definition.shape)) {
        const raw = row[field];
        if (raw === undefined) continue;
        decoded[field] = sqliteDecode(raw, effectiveColumnKind(validator));
    }
    decoded["_id"] = row["id"];
    decoded["_creationTime"] = row["_creationTime"];
    return decoded;
};
```

Called per row via `decodeRow` → `decodeRows` (`ctx-db.ts:587-594`):
```ts
const decodeRows = (definition: TableDefinitionLike, rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>[] => {
    const documents: Record<string, unknown>[] = [];
    for (const row of rows) {
        const decoded = decodeRow(definition, row);   // decodeRow → decodeGlobalRow
        if (decoded) documents.push(decoded);
    }
    return documents;
};
```

`effectiveColumnKind` (`packages/sql-store/src/value-codec.ts:71-79`) is pure over
the (immutable) validator:
```ts
export const effectiveColumnKind = (validator: ValidatorLike): string | undefined => {
    if (validator.kind !== "optional") return validator.kind;
    const inner = (validator._meta as { inner?: ValidatorLike } | undefined)?.inner;
    return inner ? effectiveColumnKind(inner) : validator.kind;
};
```

There is a precedent for a per-definition derived list in the same file —
`tableColumns` (`ctx-db.ts:333-347`) already builds `[field, ColumnMetaLike][]`
once from `definition.shape`. Mirror that shape.

`TableDefinitionLike` is imported at `ctx-db.ts:31` and is an immutable
definition object (safe to key a `WeakMap` on).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Build (deps) | `pnpm --filter "@lunora/sql-store..." run build` | exit 0 |
| Typecheck | `pnpm --filter "@lunora/sql-store" run lint:types` | exit 0 |
| Test | `pnpm --filter "@lunora/sql-store" run test` | all pass |
| Lint | `pnpm --filter "@lunora/sql-store" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/sql-store/src/ctx-db.ts` — add a memoized `field → kind` derivation
  and use it in `decodeGlobalRow`.
- The existing sql-store decode test(s) (regression + a note; likely no new test
  needed beyond confirming identical output — see Test plan).

**Out of scope**:
- `effectiveColumnKind` itself (`value-codec.ts`) — leave the function as-is; only
  its call frequency changes.
- The encode path.
- Any change to decoded output shape or values — this is a pure internal
  memoization; output must be byte-identical.

## Git workflow

- Branch: `advisor/104-sqlstore-decode-column-kind-memo`
- Commit: `perf(sql-store): memoize per-table column kinds in the row decoder`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add a memoized derivation

Add a module-level `WeakMap<TableDefinitionLike, [string, string | undefined][]>`
(field → effective kind) and a helper:
```ts
const columnKindCache = new WeakMap<TableDefinitionLike, [string, string | undefined][]>();
const columnKinds = (definition: TableDefinitionLike): [string, string | undefined][] => {
    let kinds = columnKindCache.get(definition);
    if (kinds === undefined) {
        kinds = Object.entries(definition.shape).map(([field, validator]) => [field, effectiveColumnKind(validator)]);
        columnKindCache.set(definition, kinds);
    }
    return kinds;
};
```
Place it near `tableColumns` for consistency.

**Verify**: `pnpm --filter "@lunora/sql-store" run lint:types` → exit 0.

### Step 2: Use it in `decodeGlobalRow`

```ts
const decodeGlobalRow = (definition: TableDefinitionLike, row: Record<string, unknown>): Record<string, unknown> => {
    const decoded: Record<string, unknown> = {};
    for (const [field, kind] of columnKinds(definition)) {
        const raw = row[field];
        if (raw === undefined) continue;
        decoded[field] = sqliteDecode(raw, kind);
    }
    decoded["_id"] = row["id"];
    decoded["_creationTime"] = row["_creationTime"];
    return decoded;
};
```
Output must be identical to before.

**Verify**: `pnpm --filter "@lunora/sql-store" run test` → all pass (existing
decode tests confirm identical output).

## Test plan

- The existing sql-store decode/roundtrip tests are the safety net — they assert
  decoded output; if they pass unchanged, the memoization is transparent.
- Optionally add one test that decodes two result sets from the same definition
  and asserts identical output to a from-scratch (non-cached) decode of the same
  rows — but the primary gate is "existing tests still pass with identical
  output".
- Verification: `pnpm --filter "@lunora/sql-store" run test` → all pass.

## Done criteria

- [ ] `decodeGlobalRow` no longer calls `effectiveColumnKind` or `Object.entries(definition.shape)` per row; it iterates the cached `columnKinds(definition)`.
- [ ] Decoded output is unchanged (existing tests pass).
- [ ] `pnpm --filter "@lunora/sql-store" run lint:types` + `run test` + `run lint:eslint` exit 0.
- [ ] `git status` shows only `packages/sql-store/src/ctx-db.ts` (+ optional test).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- `TableDefinitionLike` turns out NOT to be a stable object identity across calls
  (e.g. a fresh definition object is built per read) — then a `WeakMap` keyed on
  it never hits; STOP and report. (It should be stable — definitions come from
  `defineSchema` — but confirm by checking how `decodeRows` receives `definition`.)
- Any existing decode test's output changes — the memoization must be transparent;
  a changed output means the cached kinds diverge from per-row derivation, which
  is a bug. STOP.
- `definition.shape` is mutated somewhere after first decode (it should be
  immutable) — a stale cache would then be wrong; STOP and report.

## Maintenance notes

- If `effectiveColumnKind` ever becomes context-dependent (not a pure function of
  the validator), this cache would be invalid — but that would be a larger design
  change; flag it in review if it comes up.
- The same per-definition memo pattern already exists for `tableColumns`; keep
  them consistent.
