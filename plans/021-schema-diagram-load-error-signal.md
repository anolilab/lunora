# Plan 021: Surface a column-load error in the schema diagram

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat dda03c28..HEAD -- packages/studio/src/features/schema/schema-viewer.tsx packages/studio/src/features/schema/schema-diagram.tsx packages/studio/src/features/schema/database-schema-node.tsx packages/studio/__tests__/features/schema/schema-diagram.test.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (additive UI signal; no behaviour change when nothing fails)
- **Depends on**: none, but **soft-depends on / interacts with plan 020**. Both
  edit `probeShardSchema`. If 020 lands first, the columns read is a single
  batched `describeTables` call, so a failure is **per-shard** (all tables show
  the signal). If 021 lands first, it tracks per-table failures over the current
  per-table `describeTable` calls. **Recommended order: 020 then 021.** This
  plan is written for the **post-020** world (batched, per-shard failure) with a
  pre-020 fallback noted inline.
- **Category**: DX / correctness (silent-failure visibility)
- **Planned at**: commit `dda03c28`, 2026-06-14

## Why this matters

When the Graph view probes typed columns, a failed columns read is **silently
swallowed** — the table simply renders with no column rows (an `—` placeholder).
Today in `probeShardSchema` (schema-viewer.tsx:249–274) a rejected
`describeTable` becomes `columns: []`, and the node body shows `—` (see
`database-schema-node.tsx:66-67`). That `—` is indistinguishable from a table
that genuinely has no columns beyond the system fields, or from "still loading."
So if an older worker lacks the admin op, or the admin token is missing for that
read, the operator sees an empty-looking diagram with no hint that something
failed.

This plan adds a small, honest signal: when the columns read fails, mark the
affected node so the diagram shows "couldn't load columns" instead of a bare
`—`. It's a visibility fix, not a behaviour change — success paths look
identical.

## Design decision (already scoped)

- **Granularity**: per-shard after plan 020 (the batched `describeTables` either
  resolves for the whole shard or rejects). The error state is a **boolean per
  shard**: "columns failed to load for this shard." Every node in that shard's
  diagram then shows the signal. (Pre-020 fallback: a `Set<string>` of table
  names whose `describeTable` rejected; see the inline note in Step 2.)
- **Signal**: a subtle inline indicator in the node — a small muted "columns
  unavailable" line where the `—` placeholder sits — plus a `data-testid` so the
  test can assert it. No toast, no blocking error; the diagram still renders all
  table nodes and FK edges.
- **No retry UI** in this plan — switching shards or re-seeding re-probes
  already (the viewer re-probes when `tables`/`shardKey` change). A retry button
  is out of scope.

## Current state

### `packages/studio/src/features/schema/schema-viewer.tsx`

State (lines 95–100): `shardEdges` and `shardColumns`, keyed by shard. The probe
(lines 249–274) — **post-020 this will be the batched version from plan 020**;
read the live code at execution time. Pre-020 it's the per-table
`Promise.allSettled` shown in plan 020's "Current state." Either way the columns
result is reduced into `setShardColumns({ ...previous, [shard]: <map> })`.

The diagram is rendered for the shard tier (lines 341–347):

```tsx
<SchemaDiagram
    columnsByTable={shardColumns[shardKey] ?? EMPTY_COLUMNS}
    edges={shardEdges[shardKey] ?? EMPTY_EDGES}
    tables={shardTableNames}
    testIdPrefix="sc-graph-shard"
    tier="shard"
/>
```

and for the global tier (line 353) — global never probes columns, so it never
shows the error signal:

```tsx
<SchemaDiagram columnsByTable={EMPTY_COLUMNS} edges={EMPTY_EDGES} tables={globalTableNames} testIdPrefix="sc-graph-global" tier="global" />
```

The `refresh` callback (lines 107–129) clears `shardColumns`/`shardEdges` for the
shard on reload — any new error state must be cleared there too.

### `packages/studio/src/features/schema/schema-diagram.tsx`

`SchemaDiagramProps` (lines 21–32):

```ts
interface SchemaDiagramProps {
    /** Typed columns per table (from `describeTable`); a table absent here renders with no rows yet. */
    readonly columnsByTable: Readonly<Record<string, ColumnMeta[]>>;
    /** Foreign-key edges to draw between the tables. */
    readonly edges: ReadonlyArray<SchemaEdge>;
    /** The tables to render as nodes. */
    readonly tables: ReadonlyArray<string>;
    /** Prefix for every `data-testid` so two diagrams on one page don't collide. */
    readonly testIdPrefix: string;
    /** Which storage tier this diagram represents (drives the per-node badge). */
    readonly tier: StorageTier;
}
```

`buildNodes` (lines 38–55) builds the node `data` from `{ columns, label, tier }`:

```ts
return positions.map(({ name, x, y }) => {
    return {
        data: { columns: columnsByTable[name] ?? [], label: name, tier },
        id: name,
        position: { x, y },
        type: "databaseSchema",
    };
});
```

The component reads `columnsByTable`, builds nodes/edges with `useMemo`, and
re-seeds via effects (lines 96–109).

### `packages/studio/src/features/schema/database-schema-node.tsx`

`DatabaseSchemaNodeData` (lines 32–36):

```ts
type DatabaseSchemaNodeData = {
    columns: DatabaseSchemaColumn[];
    label: string;
    tier: StorageTier;
};
```

The empty-state render (lines 66–67) — where the signal goes:

```tsx
{data.columns.length === 0 ? (
    <span className="px-3 py-1.5 text-xs text-muted-foreground">—</span>
) : (
```

### `packages/studio/__tests__/features/schema/schema-diagram.test.tsx`

`buildNodes` test (lines 33–45) and the `schemaDiagram (component)` block (lines
75–96) are the patterns for new unit tests. The `createClient` mock (lines
99–129) drives the viewer-integration test; `createMockClient` can be told to
make a query reject (check `packages/studio/__tests__/mock-client.ts` for how —
see Step 5).

## Commands you will need

| Purpose      | Command                                             | Expected |
| ------------ | --------------------------------------------------- | -------- |
| Build deps   | `pnpm run build:packages`                           | exit 0   |
| studio build | `pnpm --filter "@cirrus/studio..." run build`       | exit 0   |
| studio tests | `pnpm --filter "@cirrus/studio" run test -- schema` | all pass |
| studio types | `pnpm --filter "@cirrus/studio" run lint:types`     | exit 0   |
| eslint       | `pnpm --filter "@cirrus/studio" run lint:eslint`    | exit 0   |

Build dependencies once (`pnpm run build:packages`) before studio test/types —
repo convention (plan 016).

## Scope

**In scope** (the only files you may modify):

- `packages/studio/src/features/schema/schema-viewer.tsx` — track the per-shard
  columns-load failure; pass it to the shard `SchemaDiagram`; clear it on
  refresh.
- `packages/studio/src/features/schema/schema-diagram.tsx` — add a
  `columnsError?: boolean` prop, thread it into each node's `data` as
  `loadError`.
- `packages/studio/src/features/schema/database-schema-node.tsx` — add
  `loadError?: boolean` to the node data; render the signal in place of `—`.
- `packages/studio/src/locales/en.ts` — add the `t("…")` string(s).
- `packages/studio/__tests__/features/schema/schema-diagram.test.tsx` — tests
  for the new signal.

**Out of scope** (do NOT touch):

- The `@cirrus/do` admin ops and `layout.ts` — no wire/layout change.
- The global-tier diagram's behaviour (it never probes columns).
- Adding a retry button / toast.
- `probeShardSchema`'s batching shape (that's plan 020) — only ADD error
  tracking around whatever the probe already does.

## Git workflow

- Branch: `advisor/021-schema-diagram-load-error-signal`
- Conventional commits, e.g.
  `feat(studio): flag a failed column load in the schema diagram`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `en.ts` strings

In `packages/studio/src/locales/en.ts` add an entry (match the file's
key-as-English-string convention — read a few existing lines first), e.g.:

```ts
"Columns unavailable": "Columns unavailable",
```

If the locale file uses a flat `{ "English": "English" }` map, just add the line
alphabetically near other "C" keys. **Verify** the existing diagram strings
(`"No tables to graph."`, `"Graph"`) to confirm the format.

### Step 2: Track the per-shard columns-load failure in `schema-viewer.tsx`

1. Add state next to `shardColumns` (line 100):

    ```ts
    // Shards whose typed-column probe (`describeTables`) failed — drives the
    // diagram's "columns unavailable" signal so a failed load isn't mistaken for
    // an empty table.
    const [shardColumnsError, setShardColumnsError] = useState<Record<string, boolean>>({});
    ```

2. In `probeShardSchema`, set the flag from the columns read's outcome. **Post-020**
   (batched), it's a single boolean for the shard:

    ```ts
    const columnsFailed = described[0].status === "rejected"; // `described` from plan 020's batched probe
    // …after computing columnsByTable…
    setShardColumnsError((previous) => {
        return { ...previous, [shard]: columnsFailed };
    });
    ```

    > **Pre-020 fallback** (if plan 020 has NOT landed and the probe still calls
    > `describeTable` per table): set the flag `true` for the shard if **any**
    > per-table `described` settled to `rejected`. Track it from the existing
    > `results` array: `const columnsFailed = results.some((r) => r.columnsRejected)`
    > — which requires the per-table mapper to also return whether its
    > `describeTable` rejected. Keep it a single per-shard boolean either way (do
    > NOT introduce per-table error state — it complicates the node API for no
    > visible benefit, since a missing admin op fails uniformly).

3. In `refresh` (lines 119–122 area, where `shardEdges`/`shardColumns` are
   pruned for the shard), prune `shardColumnsError` the same way:

    ```ts
    setShardColumnsError((previous) => Object.fromEntries(Object.entries(previous).filter(([cachedShard]) => cachedShard !== shard)));
    ```

4. Pass the flag to the shard diagram (the global one never errors — omit the
   prop or pass `false`):

    ```tsx
    <SchemaDiagram
        columnsByTable={shardColumns[shardKey] ?? EMPTY_COLUMNS}
        columnsError={shardColumnsError[shardKey] === true}
        edges={shardEdges[shardKey] ?? EMPTY_EDGES}
        tables={shardTableNames}
        testIdPrefix="sc-graph-shard"
        tier="shard"
    />
    ```

**Verify**: `pnpm --filter "@cirrus/studio" run lint:types` → exit 0 (after the
prop is added in Step 3).

### Step 3: Thread the flag through `schema-diagram.tsx`

1. Add the optional prop to `SchemaDiagramProps`:

    ```ts
    /** True when the typed-column probe for this tier failed — nodes show a "columns unavailable" hint instead of an empty `—`. */
    readonly columnsError?: boolean;
    ```

2. Accept it in the component signature and pass it into `buildNodes` so each
   node's `data` carries `loadError`. Update `buildNodes`' signature and the
   `data` literal:

    ```ts
    const buildNodes = (
        tables: ReadonlyArray<string>,
        edges: ReadonlyArray<SchemaEdge>,
        columnsByTable: Readonly<Record<string, ColumnMeta[]>>,
        tier: StorageTier,
        columnsError: boolean,
    ): DatabaseSchemaNodeType[] => {
        // …
        return positions.map(({ name, x, y }) => {
            return {
                data: { columns: columnsByTable[name] ?? [], label: name, loadError: columnsError, tier },
                id: name,
                position: { x, y },
                type: "databaseSchema",
            };
        });
    };
    ```

3. Update the `useMemo` call to pass `columnsError ?? false` and add it to the
   dependency array:

    ```ts
    const seededNodes = useMemo(
        () => buildNodes(tables, edges, columnsByTable, tier, columnsError ?? false),
        [tables, edges, columnsByTable, tier, columnsError],
    );
    ```

    `buildNodes` is exported and used directly in a test (line 37). Update that
    test call to pass the new arg (Step 5).

**Verify**: `pnpm --filter "@cirrus/studio" run lint:types` → exit 0.

### Step 4: Render the signal in `database-schema-node.tsx`

1. Add `loadError?: boolean` to `DatabaseSchemaNodeData`:

    ```ts
    type DatabaseSchemaNodeData = {
        columns: DatabaseSchemaColumn[];
        label: string;
        /** True when this table's columns failed to load — show a hint, not a bare `—`. */
        loadError?: boolean;
        tier: StorageTier;
    };
    ```

2. Replace the empty-state branch (lines 66–67) so a load error shows the hint
   instead of `—`. Use `useT` for the string (check whether the node already
   imports a translator — if not, the node is a pure presentational component;
   import `useT` from `../../i18n/i18n-context` as `schema-diagram.tsx` does, or
   pass the already-translated string down. Prefer importing `useT` here to keep
   the prop surface small):

    ```tsx
    {data.columns.length === 0 ? (
        data.loadError === true ? (
            <span className="px-3 py-1.5 text-xs text-destructive" data-testid={`sd-node-${data.label}-error`}>
                {t("Columns unavailable")}
            </span>
        ) : (
            <span className="px-3 py-1.5 text-xs text-muted-foreground">—</span>
        )
    ) : (
    ```

    If you add `useT`, call `const t = useT();` at the top of the component. Use
    a Tailwind token already used elsewhere for error/destructive text — grep the
    studio for `text-destructive` to confirm it's the convention; if it isn't,
    fall back to `text-muted-foreground` and rely on the test id + copy.

    > Design note: the signal only replaces the empty placeholder. A table that
    > DID load columns shows them normally even if `loadError` is true for the
    > shard — but post-020 a shard-wide failure means every table has `[]`
    > columns, so in practice the hint shows on all nodes. That's correct: the
    > whole shard's columns failed.

**Verify**: `pnpm --filter "@cirrus/studio..." run build` → exit 0.

### Step 5: Tests

In `packages/studio/__tests__/features/schema/schema-diagram.test.tsx`:

1. Fix the existing `buildNodes` direct call (line 37) to pass the new
   `columnsError` arg: `buildNodes(TABLES, REF_EDGES, COLUMNS_BY_TABLE, "shard", false)`.

2. Add a `buildNodes` test that the flag lands in node data:

    ```ts
    it("marks nodes with loadError when columnsError is set", () => {
        expect.assertions(1);

        const nodes = buildNodes(TABLES, NO_EDGES, NO_COLUMNS, "shard", true);

        expect(nodes.every((node) => node.data.loadError === true)).toBe(true);
    });
    ```

3. Add a component test that the hint renders. With no columns + `columnsError`,
   each node shows the error hint instead of `—`:

    ```ts
    it("shows a columns-unavailable hint when the column probe failed", () => {
        expect.assertions(1);

        render(<SchemaDiagram columnsByTable={NO_COLUMNS} columnsError edges={NO_EDGES} tables={TABLES} testIdPrefix="sd" tier="shard" />);

        expect(screen.getByTestId("sd-node-messages-error").textContent).toContain("Columns unavailable");
    });
    ```

4. (Optional but recommended) A viewer-integration test that a failing columns
   read surfaces the hint. Make the mock's columns read reject. Check
   `packages/studio/__tests__/mock-client.ts` for how `query` rejections are
   expressed — if the mock's `query` can `throw`, throw for the columns op
   (`describeTables` post-020, else `describeTable`):

    ```ts
    if (reference === ADMIN_FUNCTIONS.describeTables) {
        throw new Error("no admin op");
    }
    ```

    Then after switching to graph view, assert
    `await screen.findByTestId("sd-node-messages-error")`. If wiring a rejecting
    mock proves awkward (the mock swallows throws, etc.), skip this integration
    test — the two unit tests above are sufficient coverage. Do NOT spend more
    than one attempt on the integration test.

**Verify**: `pnpm --filter "@cirrus/studio" run test -- schema` → all pass.

### Step 6: Full gate

**Verify** all of:

- `pnpm --filter "@cirrus/studio..." run build` → exit 0
- `pnpm --filter "@cirrus/studio" run test -- schema` → pass
- `pnpm --filter "@cirrus/studio" run lint:types` → exit 0
- `pnpm --filter "@cirrus/studio" run lint:eslint` → exit 0

## Test plan

- `buildNodes` unit test: `columnsError: true` → every node's
  `data.loadError === true`; the existing `buildNodes` call is updated for the
  new arg.
- Component test: `<SchemaDiagram columnsError … />` with empty columns renders
  `sd-node-<table>-error` with "Columns unavailable" text.
- Optional viewer-integration test: a rejecting columns read surfaces the hint
  after switching to graph view.
- Pattern source: the existing `buildNodes` and `schemaDiagram (component)`
  blocks in the same file.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run build:packages` exits 0
- [ ] `pnpm --filter "@cirrus/studio..." run build` exits 0
- [ ] `pnpm --filter "@cirrus/studio" run test -- schema` exits 0; the new
      `loadError` / hint tests pass and all pre-existing schema tests still pass
- [ ] `pnpm --filter "@cirrus/studio" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/studio" run lint:eslint` exits 0
- [ ] `git grep -n "loadError" packages/studio/src/features/schema` shows the
      prop threaded through diagram + node
- [ ] `plans/README.md` status row for 021 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match the live code (drift since
  `dda03c28`) — in particular if `probeShardSchema` has a shape this plan didn't
  anticipate (neither the pre-020 per-table form nor the post-020 batched form).
- `text-destructive` is not an established token in the studio AND there's no
  obvious error-text convention — fall back to `text-muted-foreground` (not a
  STOP, just a note), but if the node component can't access a translator at all
  without a larger refactor, STOP and report.
- Making the integration test pass would require changing `mock-client.ts`'s
  contract — skip the integration test (it's optional) rather than altering
  shared test infra.

## Maintenance notes

- The error state is intentionally **per-shard boolean**, matching plan 020's
  batched probe. If a future change reverts to per-table column reads with
  independent failures, reconsider whether per-table error granularity is worth
  the larger node API.
- The signal reuses the empty-state slot, so a table with genuinely zero
  user-columns (only `_id`/`_creationTime`, which are always present) won't hit
  the `columns.length === 0` branch — the system fields mean the column list is
  never empty on a successful load. So in practice the `—`/error branch only
  renders when the probe returned nothing at all, which is exactly the
  failure/older-worker case. Keep this invariant in mind if system-field
  emission ever changes.
- Interacts with plan 020 (same `probeShardSchema`). Execute 020 first; this
  plan's post-020 path is the primary one.
