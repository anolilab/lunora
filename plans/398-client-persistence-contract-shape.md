# Plan 398: Make the persistence contract suite assert the full `PersistedMutation` shape

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/client/__tests__/persistence.test.ts`
> On any change, compare the "Current state" excerpts against the live code;
> on a mismatch, treat it as a STOP condition. (A change from plan 397 landing
> on the same branch is expected and fine.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/397-client-persistence-clone-structural.md (the strict assertion fails against the in-memory adapter until 397 lands)
- **Category**: tests
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The three persistence adapters share one behavioural suite precisely "so the two can't diverge" — but the case named `"load() preserves the full mutation shape"` builds its fixture from a factory that never sets `clientId`, `identity`, or `version`, and asserts with `toEqual` on a four-field object. It therefore passed while the in-memory adapter dropped two documented load-bearing fields (fixed by plan 397). Any future field added to `PersistedMutation` is equally invisible. One tightened case turns the suite into a real contract test.

## Current state

`packages/client/__tests__/persistence.test.ts`:

- `:9-16` — the factory:
    ```ts
    const mutation = (id: string, overrides: Partial<PersistedMutation> = {}): PersistedMutation => {
        return {
            args: { id },
            functionPath: "posts:create",
            id,
            ...overrides,
        };
    };
    ```
- `:64-79` — the shape case appends `mutation("a", { args: { title: "hi" }, shardKey: "room-1" })` and asserts `toEqual({ args, functionPath, id, shardKey })` — no `clientId`/`identity`/`version`, and `toEqual` ignores `undefined`-valued key presence.
- `:42-46` — `adapters` runs the suite against `createInMemoryPersistence`, `createIndexedDbPersistence` (fake-indexeddb), and `createAsyncStoragePersistence` (fake AsyncStorage).

## Commands you will need

| Purpose    | Command                                          | Expected on success |
| ---------- | ------------------------------------------------ | ------------------- |
| Install    | `pnpm install`                                   | exit 0              |
| Build deps | `pnpm --filter "@lunora/client..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/client" run test`        | all pass            |
| Lint       | `pnpm --filter "@lunora/client" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/client/__tests__/persistence.test.ts`

**Out of scope**:

- Any `src/` file. If tightening the assertion reveals a NEW adapter divergence (beyond what plan 397 fixed), that's a STOP-and-report, not a fix here.

## Git workflow

- Branch: `improve/wave22-client`
- Commit: `test(client): assert full persisted-mutation shape`

## Steps

### Step 1: Tighten the shape case

Change `"load() preserves the full mutation shape"` to append a record with **every** `PersistedMutation` field populated:

```ts
await adapter.append(
    mutation("a", {
        args: { title: "hi" },
        clientId: "client-1",
        identity: "user-1",
        shardKey: "room-1",
        version: "v3",
    }),
);

const [loaded] = await adapter.load();

expect(loaded).toStrictEqual({
    args: { title: "hi" },
    clientId: "client-1",
    functionPath: "posts:create",
    id: "a",
    identity: "user-1",
    shardKey: "room-1",
    version: "v3",
});
```

`toStrictEqual` (not `toEqual`) so an adapter that adds explicit `undefined` keys or drops keys fails.

**Verify**: `pnpm --filter "@lunora/client" run test -- persistence` → the case passes against all three adapters (requires plan 397 already applied on this branch).

### Step 2: Keep a sparse-record case

Add one sibling case appending a record with the optional fields **absent** and asserting `toStrictEqual` against the sparse shape — this pins that adapters don't invent keys (the JSON round-trip in AsyncStorage naturally drops `undefined`; the suite should document that absence, not explicit `undefined`, is the contract).

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass.

## Test plan

- The two cases above, executed ×3 adapters by the existing `describe.each`.

## Done criteria

- [ ] `pnpm --filter "@lunora/client" run test` exits 0
- [ ] The shape case populates all 7 `PersistedMutation` fields and uses `toStrictEqual`
- [ ] `git status` shows only the test file modified

## STOP conditions

- The strict assertion fails against the IndexedDB or AsyncStorage adapter (i.e. a divergence plan 397 did not cover) — report the exact diff instead of loosening the assertion.
- Plan 397 is not present on the branch (the in-memory adapter still drops fields).

## Maintenance notes

- When a field is added to `PersistedMutation`, this case must be extended in the same change — the `toStrictEqual` will not fail on an _unset_ new field, so reviewers of `types.ts` changes should check this file.
