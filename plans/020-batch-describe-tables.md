# Plan 020: Batch `describeTables` admin RPC for the schema diagram

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat dda03c28..HEAD -- packages/do/src/introspect.ts packages/do/src/shard-do.ts packages/studio/src/lib/admin.ts packages/studio/src/features/schema/schema-viewer.tsx packages/do/__tests__/shard-do.admin.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW–MEDIUM (touches the DO admin dispatch + its subscription scoping)
- **Depends on**: none. **Interacts with 021** (both edit the schema-viewer
  probe loop) — land 020 first if doing both; see plan 021's dependency note.
- **Category**: performance / DX
- **Planned at**: commit `dda03c28`, 2026-06-14

## Why this matters

When the studio's **Database → Schema → Graph** view opens, it probes every
table's typed columns to draw the diagram. Today that's **one
`describeTable` RPC per table** — `probeShardSchema` in
`schema-viewer.tsx` fires `READ_TABLE_PAGE` + `DESCRIBE_TABLE` per table inside
a `Promise.all` over `names`. For a schema with N tables that's N round-trips for
column metadata that all lives in the same Durable Object and is computed by a
synchronous, in-memory `this.tableColumns(table)` lookup. A single batched
`describeTables` call returns the whole map in one round-trip.

This is a latency win on graph open (especially on schemas with many tables and
on higher-latency connections), and it shrinks the admin-RPC fan-out the DO has
to dispatch and subscription-scope. The per-table `describeTable` op stays — it
has its own non-batch caller (the list-view path doesn't use it today, but the
op is public contract and the base-hook test covers it), so this plan **adds**
`describeTables` alongside it rather than replacing it.

## Background: the metadata pipeline

Column metadata is schema-sourced (cirrus stores rows as a `__doc__` JSON blob,
so `PRAGMA table_info` carries neither types nor PK/FK roles). The authoritative
list comes from the codegen-generated shard subclass overriding
`tableColumns(table)`; the base `ShardDO` returns `[]`. The admin op
`__cirrus_admin__:describeTable` calls that hook. The studio mirrors the wire
types and calls the op over RPC. This plan threads a _batch_ variant through the
same chain:

```
@cirrus/do introspect (ADMIN_FUNCTIONS + result type)
  → @cirrus/do shard-do dispatch (loop tableColumns over args.tables)
  → @cirrus/studio admin.ts (mirror op + result type)
  → @cirrus/studio schema-viewer (one batched call instead of N)
```

No codegen change is needed — the existing `tableColumns` override already
returns per-table column metadata; the batch op just calls it in a loop.

## Current state

### 1. `packages/do/src/introspect.ts`

`ADMIN_FUNCTIONS` (lines 31–72) — the reserved admin paths. `describeTable` is at
line 37; the values are spelled out inline (not interpolated) "so the values
stay emittable under `--isolatedDeclarations`":

```ts
const ADMIN_FUNCTIONS = {
    applyCdc: "__cirrus_admin__:applyCdc",
    // …
    describeTable: "__cirrus_admin__:describeTable",
    // …
} as const;
```

`ColumnMeta` (lines 231–243) and `TableColumnsResult` (lines 245–248):

```ts
interface ColumnMeta {
    /** `v.storage(...)` column — the value is an R2 object key. */
    isStorage?: boolean;
    name: string;
    /** Optional on insert (declared `v.optional(...)` or carrying a default). */
    optional: boolean;
    /** Primary key — the `_id` column. */
    pk?: boolean;
    /** Foreign-key target table for a `v.id("target")` column. */
    ref?: string;
    /** Display type: the validator IR kind. */
    type: string;
}

/** Payload of a `__cirrus_admin__:describeTable` call: every column of the table, in schema order. */
interface TableColumnsResult {
    columns: ColumnMeta[];
}
```

`ColumnMeta` and `TableColumnsResult` are exported from this module (the studio
mirrors them by hand, but `@cirrus/do`'s own exports back the codegen + DO use).
Find the existing `export type { … ColumnMeta … TableColumnsResult … }` /
`export { … }` lines near the bottom of the file and add the new type there in
the same way the siblings are exported. **Verify the exact export mechanism by
reading the bottom of the file before editing** — match it exactly.

### 2. `packages/do/src/shard-do.ts`

The base hook `tableColumns` (lines 2130–2133):

```ts
// eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the generated schema's column metadata
protected tableColumns(_table: string): ColumnMeta[] {
    return [];
}
```

The dispatch helper `readAdminTableSignal` (lines 3627–3642) — called from
`readAdminOp` at line 3601, returns `{ result, tables: Set<string> }` or
`undefined` to fall through. The `tables` set is the subscription-scope key (it
tells the coordinator which tables this read depends on; `ADMIN_WILDCARD` means
"all"):

```ts
private readAdminTableSignal(functionPath: string, sql: SqlExec, args: Record<string, unknown>): undefined | { result: unknown; tables: Set<string> } {
    if (functionPath === ADMIN_FUNCTIONS.listTableIndexes || functionPath === ADMIN_FUNCTIONS.describeTable) {
        const table = typeof args["table"] === "string" ? args["table"] : "";
        const result = functionPath === ADMIN_FUNCTIONS.describeTable ? { columns: this.tableColumns(table) } : { indexes: this.tableIndexes(table) };

        return { result, tables: new Set([table === "" ? ADMIN_WILDCARD : table]) };
    }

    if (functionPath === ADMIN_FUNCTIONS.migrationStatus) {
        const id = typeof args["id"] === "string" ? args["id"] : undefined;

        return { result: { migrations: readMigrationStatus(sql, id) }, tables: new Set([ADMIN_WILDCARD]) };
    }

    return undefined;
}
```

### 3. `packages/studio/src/lib/admin.ts`

`ADMIN_FUNCTIONS` (lines 29–63) — the studio's mirror, `describeTable` at line 33. `ColumnMeta` (lines 320–332) and `TableColumnsResult` (lines 334–337) mirror
`@cirrus/do`'s. These are `export interface`.

### 4. `packages/studio/src/features/schema/schema-viewer.tsx`

`DESCRIBE_TABLE` ref (line 36):

```ts
const DESCRIBE_TABLE = adminRef(ADMIN_FUNCTIONS.describeTable);
```

The probe (lines 249–274) — the **only** caller to convert:

```ts
const probeShardSchema = useCallback(
    async (shard: string, names: string[]): Promise<void> => {
        const results = await Promise.all(
            names.map(async (table): Promise<{ columns: ColumnMeta[]; edges: SchemaEdge[]; table: string }> => {
                const [page, described] = await Promise.allSettled([
                    client.query(READ_TABLE_PAGE, { limit: 1, offset: 0, table }, callOptions(shard)) as Promise<TablePage>,
                    client.query(DESCRIBE_TABLE, { table }, callOptions(shard)) as Promise<TableColumnsResult>,
                ]);

                return {
                    columns: described.status === "fulfilled" ? described.value.columns : [],
                    edges: page.status === "fulfilled" ? referencesToEdges(table, page.value.refs) : [],
                    table,
                };
            }),
        );

        setShardEdges((previous) => {
            return { ...previous, [shard]: results.flatMap((result) => result.edges) };
        });
        setShardColumns((previous) => {
            return { ...previous, [shard]: Object.fromEntries(results.map((result) => [result.table, result.columns])) };
        });
    },
    [client],
);
```

Note: the FK **edges** still come from per-table `readTablePage` (it returns the
`refs` map and is also the row-count probe); only the **columns** read
(`DESCRIBE_TABLE`) is being batched. `READ_TABLE_PAGE` per table stays.

### 5. `packages/do/__tests__/shard-do.admin.test.ts`

The existing `describeTable` dispatch test (lines 180–219) is the pattern to copy
for the batch test. It builds an `AdminShard` (base, reports `[]`) and a
subclass overriding `tableColumns`, then `fetch`es an `adminRequest`. The
helpers `adminRequest`, `ADMIN_TOKEN`, `AdminShard`, `state`, `ADMIN_FUNCTIONS`
are already imported/defined in that file.

## Commands you will need

| Purpose      | Command                                                                    | Expected |
| ------------ | -------------------------------------------------------------------------- | -------- |
| Build deps   | `pnpm run build:packages`                                                  | exit 0   |
| do tests     | `pnpm --filter "@cirrus/do" run test -- shard-do.admin`                    | all pass |
| do types     | `pnpm --filter "@cirrus/do" run lint:types`                                | exit 0   |
| studio build | `pnpm --filter "@cirrus/studio..." run build`                              | exit 0   |
| studio tests | `pnpm --filter "@cirrus/studio" run test -- schema`                        | all pass |
| studio types | `pnpm --filter "@cirrus/studio" run lint:types`                            | exit 0   |
| eslint       | `pnpm --filter "@cirrus/do" run lint:eslint` and same for `@cirrus/studio` | exit 0   |

Build dependencies once up front (`pnpm run build:packages`) — `@cirrus/do` and
`@cirrus/studio` resolve cross-package `@cirrus/*` types from built `dist/`;
skipping it produces misleading "missing export" / "X is not a function" errors.
This is repo convention (plan 016).

## Scope

**In scope** (the only files you may modify):

- `packages/do/src/introspect.ts` — add `describeTables` to `ADMIN_FUNCTIONS`
  and a `TablesColumnsResult` type; export it.
- `packages/do/src/shard-do.ts` — dispatch `describeTables` in
  `readAdminTableSignal` (or a sibling clause in `readAdminOp` if it doesn't fit
  the helper's shape — see Step 2).
- `packages/studio/src/lib/admin.ts` — mirror the op + result type.
- `packages/studio/src/features/schema/schema-viewer.tsx` — replace the
  per-table `DESCRIBE_TABLE` calls in `probeShardSchema` with one batched call.
- `packages/do/__tests__/shard-do.admin.test.ts` — add a batch-dispatch test.
- `packages/studio/__tests__/features/schema/schema-diagram.test.tsx` — update
  the viewer-integration mock to answer `describeTables` (see Step 5).

**Out of scope** (do NOT touch):

- `packages/codegen/src/emit.ts` and any generated/golden fixtures — no codegen
  change is needed; the `tableColumns` override already exists.
- The per-table `describeTable` op — keep it; do not delete it.
- The FK-edge probe (`READ_TABLE_PAGE`) — leave it per-table.
- `schema-diagram.tsx` / `database-schema-node.tsx` / `layout.ts` — the diagram
  components are unaffected; the columns map they receive is unchanged in shape.

## Git workflow

- Branch: `advisor/020-batch-describe-tables`
- Conventional commits (see `git log`), e.g.
  `perf(studio): batch describeTable into one describeTables RPC`. A single
  commit is fine, or split do/studio if you prefer.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the op + result type in `@cirrus/do` introspect

In `packages/do/src/introspect.ts`:

1. Add to `ADMIN_FUNCTIONS` (keep the inline-string form, alphabetical-ish
   neighbours like the rest):

    ```ts
    describeTables: "__cirrus_admin__:describeTables",
    ```

2. Next to `TableColumnsResult`, add the batch result type:

    ```ts
    /** Payload of a `__cirrus_admin__:describeTables` call: columns per requested table, keyed by table name. */
    interface TablesColumnsResult {
        columnsByTable: Record<string, ColumnMeta[]>;
    }
    ```

3. Export `TablesColumnsResult` the same way `TableColumnsResult` is exported
   (read the bottom-of-file export statements and match them exactly).

**Verify**: `pnpm run build:packages` → exit 0;
`pnpm --filter "@cirrus/do" run lint:types` → exit 0.

### Step 2: Dispatch `describeTables` in `shard-do.ts`

In `readAdminTableSignal`, add a clause that reads a `tables` **array** arg,
loops `this.tableColumns(table)` over it, and returns the keyed map. Scope the
subscription `tables` set to the requested tables (each declared table), or
`ADMIN_WILDCARD` if the arg is missing/empty:

```ts
if (functionPath === ADMIN_FUNCTIONS.describeTables) {
    const requested = Array.isArray(args["tables"]) ? args["tables"].filter((table): table is string => typeof table === "string") : [];
    const columnsByTable: Record<string, ColumnMeta[]> = {};

    for (const table of requested) {
        columnsByTable[table] = this.tableColumns(table);
    }

    return { result: { columnsByTable }, tables: new Set(requested.length === 0 ? [ADMIN_WILDCARD] : requested) };
}
```

Place this clause inside `readAdminTableSignal` alongside the existing
`describeTable`/`listTableIndexes` clause. If the helper's lint/complexity budget
rejects the addition (e.g. an ESLint complexity rule trips), STOP and report —
do not restructure the dispatcher beyond adding this clause.

**Verify**: `pnpm --filter "@cirrus/do" run lint:types` → exit 0;
`pnpm --filter "@cirrus/do" run lint:eslint` → exit 0.

### Step 3: Test the batch dispatch in `@cirrus/do`

In `packages/do/__tests__/shard-do.admin.test.ts`, add an `it` after the
existing describeTable test (after line 219), mirroring its structure. Use a
subclass overriding `tableColumns` that returns distinct columns for two tables,
fetch `describeTables` with `{ tables: ["messages", "users"] }`, and assert the
keyed map:

```ts
it("returns columns for several tables in one describeTables call", async () => {
    expect.assertions(2);

    class ColumnsShard extends AdminShard {
        // eslint-disable-next-line class-methods-use-this -- test stub mirroring the codegen override
        protected override tableColumns(table: string): { isStorage?: boolean; name: string; optional: boolean; pk?: boolean; ref?: string; type: string }[] {
            if (table === "messages") {
                return [
                    { name: "_id", optional: false, pk: true, type: "id" },
                    { name: "text", optional: false, type: "string" },
                ];
            }

            return table === "users" ? [{ name: "_id", optional: false, pk: true, type: "id" }] : [];
        }
    }

    const shard = new ColumnsShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });

    // Base hook still reports nothing per-table for an unknown table.
    const base = new AdminShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
    const baseResponse = await base.fetch(adminRequest(ADMIN_FUNCTIONS.describeTables, { tables: ["messages"] }, ADMIN_TOKEN));

    await expect(baseResponse.json()).resolves.toEqual({ result: { columnsByTable: { messages: [] } } });

    const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.describeTables, { tables: ["messages", "users"] }, ADMIN_TOKEN));

    await expect(response.json()).resolves.toEqual({
        result: {
            columnsByTable: {
                messages: [
                    { name: "_id", optional: false, pk: true, type: "id" },
                    { name: "text", optional: false, type: "string" },
                ],
                users: [{ name: "_id", optional: false, pk: true, type: "id" }],
            },
        },
    });
});
```

Confirm `ADMIN_FUNCTIONS` in the test file imports from `@cirrus/do`'s
introspect (so `describeTables` resolves). If the test file pins a local copy of
`ADMIN_FUNCTIONS`, add `describeTables` there too — but first check the import at
the top of the test.

**Verify**: `pnpm --filter "@cirrus/do" run test -- shard-do.admin` → all pass,
including the new test.

### Step 4: Mirror the op + result type in the studio admin client

In `packages/studio/src/lib/admin.ts`:

1. Add `describeTables: "__cirrus_admin__:describeTables",` to `ADMIN_FUNCTIONS`.
2. Add the mirrored result type next to `TableColumnsResult`:

    ```ts
    /** Payload of a `__cirrus_admin__:describeTables` call, mirroring `@cirrus/do`'s `TablesColumnsResult`. */
    export interface TablesColumnsResult {
        columnsByTable: Record<string, ColumnMeta[]>;
    }
    ```

**Verify**: `pnpm --filter "@cirrus/studio" run lint:types` → exit 0 (after
`pnpm run build:packages` if not already built this session).

### Step 5: Batch the probe in `schema-viewer.tsx`

1. Replace the `DESCRIBE_TABLE` ref (line 36) with a batch ref:

    ```ts
    const DESCRIBE_TABLES = adminRef(ADMIN_FUNCTIONS.describeTables);
    ```

2. Update the `import type { … }` line (line 12) to include `TablesColumnsResult`
   and drop `TableColumnsResult` (it's no longer used by this file — confirm with
   a grep before removing).

3. Rewrite `probeShardSchema` (lines 249–274) so columns come from a single
   batched call while edges still come from per-table `readTablePage`. The
   batched describe is best-effort: if it rejects, every table gets `[]`
   columns (same fallback as today). Example:

    ```ts
    const probeShardSchema = useCallback(
        async (shard: string, names: string[]): Promise<void> => {
            const [described, pages] = await Promise.all([
                Promise.allSettled([client.query(DESCRIBE_TABLES, { tables: names }, callOptions(shard)) as Promise<TablesColumnsResult>]),
                Promise.all(
                    names.map(async (table): Promise<{ edges: SchemaEdge[]; table: string }> => {
                        const page = await Promise.allSettled([
                            client.query(READ_TABLE_PAGE, { limit: 1, offset: 0, table }, callOptions(shard)) as Promise<TablePage>,
                        ]);

                        return { edges: page[0].status === "fulfilled" ? referencesToEdges(table, page[0].value.refs) : [], table };
                    }),
                ),
            ]);

            const columnsByTable = described[0].status === "fulfilled" ? described[0].value.columnsByTable : {};

            setShardEdges((previous) => {
                return { ...previous, [shard]: pages.flatMap((result) => result.edges) };
            });
            setShardColumns((previous) => {
                return { ...previous, [shard]: Object.fromEntries(names.map((table) => [table, columnsByTable[table] ?? []])) };
            });
        },
        [client],
    );
    ```

    The exact internal shape is up to you, but it MUST preserve these observable
    behaviours (the existing tests assert them):
    - `setShardColumns` writes a `{ [table]: ColumnMeta[] }` map under `[shard]`,
      with **every** requested table present (missing → `[]`).
    - `setShardEdges` writes the flattened FK edges under `[shard]`.
    - A failed columns read does **not** throw out of the function (the diagram
      must still render the tables with no rows).
    - Only **one** `describeTables` query is issued per probe (not one per
      table). You can sanity-check this in the test by counting mock calls if you
      like, but it's not required.

    > Note: keeping a single-element `Promise.allSettled([...])` is a clean way to
    > "swallow" one rejection without a try/catch — but if you'd rather use a
    > plain `try/catch` or `.catch(() => ({ columnsByTable: {} }))`, that's fine
    > as long as the behaviours above hold and ESLint passes. Match the file's
    > existing style (it favours `Promise.allSettled`).

4. Grep the file for any remaining `DESCRIBE_TABLE`/`TableColumnsResult`
   references and remove the now-dead ones.

**Verify**: `pnpm --filter "@cirrus/studio..." run build` → exit 0;
`pnpm --filter "@cirrus/studio" run lint:types` → exit 0;
`pnpm --filter "@cirrus/studio" run lint:eslint` → exit 0.

### Step 6: Update the diagram viewer-integration test mock

`packages/studio/__tests__/features/schema/schema-diagram.test.tsx` — the
`createClient` mock (lines 99–129) answers `describeTable` per table (lines
118–122). The viewer now calls `describeTables`, so the mock must answer the
batch op. Add a branch (keep the old `describeTable` branch too, since the
`@cirrus/do` contract still serves it and other tests/components may use it):

```ts
if (reference === ADMIN_FUNCTIONS.describeTables) {
    const { tables } = args as { tables: string[] };

    return { columnsByTable: Object.fromEntries(tables.map((table) => [table, COLUMNS_BY_TABLE[table] ?? []])) };
}
```

The viewer-integration test ("renders the diagram node with a typed column when
switched to graph view") must still pass unchanged — it asserts the `messages`
node renders its `author` column after switching to graph view.

**Verify**: `pnpm --filter "@cirrus/studio" run test -- schema` → all pass.

### Step 7: Full gate

**Verify** all of:

- `pnpm --filter "@cirrus/do" run test -- shard-do.admin` → pass
- `pnpm --filter "@cirrus/do" run lint:types` and `lint:eslint` → exit 0
- `pnpm --filter "@cirrus/studio" run test -- schema` → pass
- `pnpm --filter "@cirrus/studio" run lint:types` and `lint:eslint` → exit 0

## Test plan

- **New** `@cirrus/do` test: batch `describeTables` returns the keyed
  `columnsByTable` map for several tables, and `[]` for tables the override
  doesn't know — in `shard-do.admin.test.ts`, modelled on the existing
  describeTable test (lines 180–219).
- **Updated** studio mock: `schema-diagram.test.tsx` `createClient` answers
  `describeTables`; the viewer-integration test passes unchanged, proving the
  batched probe still populates the diagram.
- No new test infra; jsdom setup (ResizeObserver/DOMMatrix stubs) already exists
  for the diagram tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run build:packages` exits 0
- [ ] `pnpm --filter "@cirrus/do" run test -- shard-do.admin` exits 0; the new
      batch test passes
- [ ] `pnpm --filter "@cirrus/do" run lint:types` and `lint:eslint` exit 0
- [ ] `pnpm --filter "@cirrus/studio" run test -- schema` exits 0; the
      viewer-integration test passes
- [ ] `pnpm --filter "@cirrus/studio" run lint:types` and `lint:eslint` exit 0
- [ ] `git grep -n "DESCRIBE_TABLE\b" packages/studio/src` returns nothing (the
      per-table ref in the viewer is gone; the op constant `describeTable` in
      `admin.ts` may remain)
- [ ] `plans/README.md` status row for 020 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match the live code (drift since
  `dda03c28`).
- `describeTable` turns out to be referenced in a server-side admin **allowlist**
  that enumerates permitted ops explicitly (i.e. adding `describeTables` requires
  registering it somewhere this plan didn't anticipate). Search for the string
  `describeTable` across `packages/do/src` and `packages/runtime/src` before
  Step 2; if you find an allowlist/enum the plan didn't mention, STOP.
- Adding the dispatch clause trips an ESLint complexity/`max-statements` rule on
  `readAdminTableSignal` — STOP rather than refactoring the dispatcher.
- A studio test fails in a way suggesting the columns map shape changed
  (diagram receives the wrong prop shape) — re-check Step 5's observable
  behaviours; if they hold and it still fails, STOP and report.

## Maintenance notes

- `describeTables`' subscription scope is the union of requested tables. Schema
  is static between codegen/migrations, so these reads aren't live today; if a
  live schema channel is ever added, confirm the wildcard fallback (empty
  `tables` arg) still scopes correctly.
- The per-table `describeTable` op is retained as public contract. If a future
  cleanup wants to remove it, check it has no remaining callers across all
  framework adapters and the MCP server first.
- Plan **021** (schema-diagram load-error signal) edits the same
  `probeShardSchema`. With batching, a columns-read failure becomes
  **per-shard** (one batched call) rather than **per-table**, so 021's error
  granularity should be modelled as "the shard's columns failed to load," not
  "table X failed." If 021 lands first, this plan must preserve whatever
  error-tracking state 021 introduced.
