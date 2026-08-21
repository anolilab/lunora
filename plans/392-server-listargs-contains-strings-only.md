# Plan 392: Offer the `contains` operator only on string-typed filter columns in `defineListArgs`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/server/src/list-args.ts`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (narrows accepted input; breaking on alpha — record in commit body)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`defineListArgs` exists to be an allow-list: "the caller cannot smuggle a predicate over a column the author didn't publish" (list-args.ts:29-31). But `operatorsValidator` hardcodes `contains: v.optional(v.string())` into the operator object of **every** filter column regardless of the column's type, and the SQL compiler (`packages/shard-engine/src/where-sql.ts:164-165`) compiles `contains` to a substring position test with no column-type check. So every `.expose({ rest: true })` endpoint publishing a numeric, boolean, or timestamp filter column silently accepts `?where[age][contains]=4` — semantically meaningless on those types and a non-sargable full scan of whatever the index would have narrowed. The allow-list is bypassed one operator at a time.

## Current state

- `packages/server/src/list-args.ts:154-171` — the operator object builder:
  ```ts
  const operatorsValidator = (value: Validator, maxInValues: number): Validator => {
      ...
      return v.object({
          contains: v.optional(v.string()),
          eq: v.optional(value),
          gt: v.optional(value),
          ...
  ```
  Every operator except `contains`/`isNull` is typed from `value`; `contains` is unconditionally present.
- `packages/server/src/list-args.ts:196` — `OPERATOR_KEYS` includes `"contains"`, so the `toQueryArgs` sanitizer passes it through for every column.
- `packages/server/src/list-args.ts:34-39` — module doc already names `contains` as non-sargable; the doc covers cost, not the type-mismatch.
- Validator kinds available on a `Validator` (see `PASS_THROUGH_KINDS` in `packages/codegen/src/compile-validator.ts:40` for the kind vocabulary): `"string"`, `"id"`, `"storage"` are the string-ish kinds; a column may be wrapped `v.optional(...)` (kind `"optional"`, inner under a property — read `packages/values/src/v.ts` to find the exact wrapper shape, likely `.inner` or `.element`; grep `kind === "optional"` in `packages/values/src` for how other code unwraps it).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/server..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/server" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/server" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/server" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/server/src/list-args.ts`
- The `defineListArgs` test file (`grep -rln "defineListArgs" packages/server/__tests__/`)

**Out of scope**:
- `packages/shard-engine/src/where-sql.ts` — defense-in-depth there is a separate decision; the boundary fix belongs in the validator that admits client input.
- The type-level `WhereOperators` in `data-model` — only if the runtime change makes a type assertion fail (then update the conditional type minimally and note it); do not redesign the type surface.
- Other non-sargable operators (`ne`, `notIn`, `isNull: false`) — documented cost, semantically valid; not this plan.

## Git workflow

- Branch: `improve/wave22-server`
- Commit: `fix(server): offer contains only on string columns`
- Commit body must record the break: previously-accepted `contains` on non-string columns is now rejected with a validation error (alpha branch — no back-compat shim, per repo policy).

## Steps

### Step 1: Gate the operator

In `operatorsValidator`, accept the column's unwrapped kind and include `contains` only for string-ish kinds:

```ts
const STRING_KINDS = new Set(["id", "storage", "string"]);
// unwrap v.optional(...) to the inner validator's kind first
```

Build the object conditionally (`...(isStringish ? { contains: v.optional(v.string()) } : {})`). Find the correct way to read a validator's kind and unwrap `optional` by reading `packages/values/src/v.ts` — do not guess property names; if validators don't expose a readable `kind` at this layer, STOP and report what is exposed.

Also gate the `toQueryArgs` pass-through: in the sanitizer that rebuilds against `OPERATOR_KEYS` (line ~196 onward), drop `contains` for non-string columns so the programmatic path matches the validator path (find where the per-column validator/type is in reach there; if the sanitizer has no type context, rebuilding from the same per-column operator validators is the fix — follow the existing structure).

**Verify**: `pnpm --filter "@lunora/server" run lint:types` → exit 0.

### Step 2: Tests

In the existing `defineListArgs` test file, add:
1. A `v.number()` filter column: args containing `{ age: { contains: "4" } }` are **rejected** by the generated validator (assert the ValidationError mentions the unknown/unsupported key).
2. A `v.string()` column still accepts `contains`.
3. A `v.optional(v.string())` column still accepts `contains` (unwrap works).

**Verify**: `pnpm --filter "@lunora/server" run test -- list-args` → all pass.

## Test plan

The three cases above, modeled on the existing `defineListArgs` operator tests in the same file. Full server suite green.

## Done criteria

- [ ] `pnpm --filter "@lunora/server" run test` exits 0 with the 3 new tests
- [ ] A `v.number()` column's generated OpenAPI/validator surface no longer lists `contains` (assert via the validator rejection test)
- [ ] `pnpm --filter "@lunora/server" run lint:types` + `lint:eslint` exit 0
- [ ] Commit body records the breaking narrowing

## STOP conditions

- Validators do not expose an inspectable kind at the `defineListArgs` layer (report what introspection exists instead of reaching into private fields).
- The `data-model` `WhereOperators` type cannot express the conditional without a large refactor — report; a runtime-only gate with the type left wide is an acceptable fallback the reviewer must sign off on.
- An in-repo consumer (studio, examples) sends `contains` on a non-string column — report it; it's a latent bug at that call site.

## Maintenance notes

- If a future full-text path wants substring search on non-string columns via casts, it should be a new explicit operator, not a widening of `contains`.
- Reviewer: check the OpenAPI emitter output for a filter column of each type — the spec should now advertise `contains` only on string columns.
