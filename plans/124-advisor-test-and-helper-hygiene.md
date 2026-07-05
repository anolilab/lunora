# Plan 124: Advisor hygiene — negative fixtures for two positive-only security lints + a shared public-write predicate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/advisor/src/lints packages/advisor/__tests__/security-lints.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but land BEFORE plan 125, which refactors sibling
  lints in the same package)
- **Category**: tests / tech-debt
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

Nearly every one of the advisor's security lints pairs a positive fixture with
a `.toHaveLength(0)` negative — except two: `sql_injection_risk` (an
**ERROR-level** lint) and `unbounded_string_arg` are positive-only. A
regression that makes them fire on safe code (false positives are what erode
trust in security lints and get them disabled) would not be caught.
Separately, the "public write" concept — `visibility === "public" &&
(kind === "mutation" || kind === "action")` — is re-derived inline across ~8
static lints; when the definition changes (a new procedure kind), every copy
must be found and edited in lockstep. Both are small, contained hygiene fixes
in the same package.

## Current state

- `packages/advisor/__tests__/security-lints.test.ts:133-144` — the
  `unbounded_string_arg` describe has exactly one `it` ("flags one INFO
  finding per unbounded string arg"); `:222-233` — `sql_injection_risk` has
  exactly one `it` ("flags one ERROR finding per interpolation"). Neither has
  a "finds nothing" case.
- The negative-fixture pattern used by siblings in the same file (e.g. line
  59): `expect(publicMutationWithoutRatelimit.run({ schema: schema() })).toHaveLength(0);`
  and (line 85) a populated-but-safe input asserting `toHaveLength(0)`.
- Lint input shapes (from the positive tests): `sql_injection_risk` consumes
  `context.sqlInterpolations: AdvisorSqlInterpolation[]` (`{ exportName, file, line }`)
  and returns `[]` when the key is `undefined` — see
  `packages/advisor/src/lints/static/sql-injection-risk.ts` `run()`:

    ```ts
    run: (context) => {
        if (context.sqlInterpolations === undefined) {
            return [];
        }
        return context.sqlInterpolations.map((interpolation) => emit(…));
    ```

    Meaning: the _feeder_ (codegen) decides what is unsafe; the lint maps
    evidence 1:1. The meaningful negatives are therefore (a) `undefined`
    evidence key and (b) empty array. `unbounded_string_arg` likewise consumes
    `argValidators[].unboundedStringArgs` — its negatives are (a) no
    `argValidators`, (b) a validator whose `unboundedStringArgs` is empty.

- The inlined predicate — verbatim in
  `packages/advisor/src/lints/static/public-mutation-without-ratelimit.ts:39`
  and `user-creating-mutation-without-captcha.ts:37`:
  `procedure.visibility === "public" && (procedure.kind === "mutation" || procedure.kind === "action")`.
  Files touching the same concept (grep `visibility === "public"` under
  `packages/advisor/src/lints/static/`):
  `soft-delete-include-deleted-from-args.ts`,
  `ai-unbounded-generation-public.ts`,
  `output-projection-missing-on-public-read.ts`,
  `public-mutation-without-ratelimit.ts`,
  `normalize-id-used-as-authorization.ts`,
  `privileged-fanout-from-public-procedure.ts`,
  `insert-many-unsafe-user-data.ts`,
  `user-creating-mutation-without-captcha.ts`.
  NOTE: not all of these want the _write_ predicate — some check public
  _reads_. Only consolidate exact-match logic (Step 3).
- The existing shared helper module: `packages/advisor/src/lints/helpers.ts`
  currently exports `OWNERSHIP_FIELD_NAMES`, `PII_FIELD_NAMES`,
  `SYSTEM_FIELDS`, `ownershipOrPiiColumns`, `tableColumnSet`.

Conventions: no `.js` extensions in imports; named exports; each lint is a
default-exported `Lint` object (sole export — allowed); `expect.assertions(n)`
in every test. Enforced commit types include `test` and `refactor`.

## Commands you will need

| Purpose       | Command                                                          | Expected on success |
| ------------- | ---------------------------------------------------------------- | ------------------- |
| Build deps    | `pnpm --filter "@lunora/advisor..." run build`                   | exit 0              |
| Advisor tests | `pnpm --filter "@lunora/advisor" run test`                       | all pass            |
| Types / lint  | `pnpm --filter "@lunora/advisor" run lint:types` / `lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/advisor/__tests__/security-lints.test.ts`
- `packages/advisor/src/lints/helpers.ts`
- The lint files listed above (predicate replacement only — no behavior change)

**Out of scope**:

- Lint behavior, severities, messages, `cacheKey` formats (byte-stable).
- The codegen feeders (`packages/codegen`) — evidence generation is upstream.
- Any lint not using the exact predicate.
- The 4-file-per-binding factory refactor (plan 125).

## Git workflow

- Branch: `advisor/124-advisor-hygiene`
- Suggested commits: `test(advisor): negative fixtures for sql_injection_risk and unbounded_string_arg`,
  `refactor(advisor): shared isPublicWrite predicate`.

## Steps

### Step 1: Negative fixtures

In `security-lints.test.ts`, add to the `sql_injection_risk` describe:

```ts
it("flags nothing without interpolation evidence", () => {
    expect.assertions(2);

    expect(sqlInjectionRisk.run({ schema: schema() })).toHaveLength(0);
    expect(sqlInjectionRisk.run({ schema: schema(), sqlInterpolations: [] })).toHaveLength(0);
});
```

And to `unbounded_string_arg`:

```ts
it("flags nothing when args are bounded or absent", () => {
    expect.assertions(2);

    expect(unboundedStringArgument.run({ schema: schema() })).toHaveLength(0);
    expect(
        unboundedStringArgument.run({
            argValidators: [{ anyArgs: [], exportName: "update", file: "update", line: 4, unboundedStringArgs: [] }],
            schema: schema(),
        }),
    ).toHaveLength(0);
});
```

Match the file's existing import names for the two lints (check the top of
the file — e.g. `sqlInjectionRisk`, `unboundedStringArgument`).

**Verify**: `pnpm --filter "@lunora/advisor" run test` → all pass, 2 new tests.

### Step 2: Add `isPublicWrite` to helpers

In `packages/advisor/src/lints/helpers.ts` add (with a short doc comment):

```ts
export const isPublicWrite = (procedure: { kind: string; visibility: string }): boolean =>
    procedure.visibility === "public" && (procedure.kind === "mutation" || procedure.kind === "action");
```

Type the parameter with the real procedure-protection type if one is exported
from `../types` or the lint context types — read
`public-mutation-without-ratelimit.ts`'s imports to find the actual type name
and use it instead of the structural literal if available.

**Verify**: `pnpm --filter "@lunora/advisor" run lint:types` → exit 0.

### Step 3: Replace exact-match inline copies

For each of the 8 files listed in "Current state": open it, and **only if**
its condition is exactly the public-write predicate (same three checks, same
semantics), replace with `isPublicWrite(procedure)`. Files checking public
_reads_ (`kind === "query"`) or partial conditions stay untouched — list them
in the report as "checked, different predicate". Expect ~2-4 true
replacements.

**Verify**: `pnpm --filter "@lunora/advisor" run test` → all pass (the lint
suites assert findings + cacheKeys, so a semantic slip fails loudly);
`grep -rn 'visibility === "public" && (procedure.kind === "mutation"' packages/advisor/src/lints/static/` → 0 matches.

## Test plan

- Step 1's two negative tests (the point of the plan).
- No new tests for the predicate extraction — the existing positive+negative
  lint suites are the behavior lock.

## Done criteria

- [ ] `sql_injection_risk` and `unbounded_string_arg` each have a
      `.toHaveLength(0)` negative test
- [ ] `helpers.ts` exports `isPublicWrite`; exact-match call sites use it
- [ ] `pnpm --filter "@lunora/advisor" run test` → all pass
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] Report lists which of the 8 files were replaced vs "different predicate"
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The lint `run()` signatures no longer match the excerpts (context type
  changed).
- Replacing the predicate in any file changes a test result (that means the
  file's condition was NOT an exact match — revert that file and record it).
- The procedure-protection type isn't importable into `helpers.ts` without a
  dependency cycle (use the structural parameter type instead and note it).

## Maintenance notes

- Plan 125 refactors sibling lints into factories — land this first; 125's
  executor should use `isPublicWrite` where applicable.
- New lints touching "public write" must import the helper (a reviewer
  checklist item, until an ESLint rule enforces it).
