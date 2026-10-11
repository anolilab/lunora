# Plan 484: Flag `v.any()` public args reached through an alias, a destructured `any`, or a helper

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat dcffa4d73..HEAD -- packages/codegen/src/discover/argument-validators.ts packages/codegen/__tests__/discover/argument-validators.test.ts`
> If either file changed, compare the "Current state" excerpts against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: lint coverage
- **Planned at**: commit `dcffa4d73`, 2026-10-11

## Why this matters

The `public_arg_uses_any` lint (`packages/advisor/src/lints/static/public-argument-uses-any.ts`) reports a `v.any()` argument on a public query, mutation, or action because it accepts arbitrary untyped input from an untrusted client. The lint itself is correct, but its evidence comes from a codegen discovery pass that matches the validator by its source text. The pass only recognises a call written exactly as `v.<name>(…)`. Three ordinary ways of writing the same validator produce no finding at all, so an app that hides an unvalidated arg behind an alias or a helper gets a green advisor run. The lint's own doc comment promises "one finding per offending arg", and that promise does not hold for these forms.

## Current state

- `packages/codegen/src/discover/argument-validators.ts:35-47` — the validator matcher. The receiver must be the literal identifier `v`, and the callee must be a property access:

    ```ts
    const vFactoryName = (node: Node): string | undefined => {
        if (!Node.isCallExpression(node)) {
            return undefined;
        }

        const expression = node.getExpression();

        if (!Node.isPropertyAccessExpression(expression) || expression.getExpression().getText() !== "v") {
            return undefined;
        }

        return expression.getName();
    };
    ```

- `packages/codegen/src/discover/argument-validators.ts:50` — the search is limited to the arg initializer and its descendants. A helper declared elsewhere is never entered:

    ```ts
    const vFactoryCalls = (initializer: Node): Node[] => [initializer, ...initializer.getDescendants()].filter((node) => vFactoryName(node) !== undefined);
    ```

- `packages/codegen/src/discover/argument-validators.ts:98-102` — the `any` classification. It only fires when `vFactoryName` returns `"any"`:

    ```ts
    const calls = vFactoryCalls(initializer);
    const name = propertyKeyName(property);

    if (calls.some((call) => vFactoryName(call) === "any")) {
        anyArgs.push(name);
    ```

- The same matcher drives `unboundedStringArgs` (`:103`), so an aliased `v.string()` is also silently not flagged. Same root cause, same fix.
- `packages/advisor/src/lints/static/public-argument-uses-any.ts:26-40` — the lint only consumes `context.argValidators`. It has no gap of its own; it reports exactly what discovery hands it.
- Discovery is name-based on purpose in one neighbour: `packages/codegen/src/parse-validator.ts:281-309` says a project that aliases `v` "simply does not get alias resolution". That was a deliberate choice for the type parser, where a false classification throws. For the advisory lint the failure direction is the opposite: a missed `v.any()` is a silent pass. Do not reuse the parser's choice here without saying so.

### The missed forms

Each snippet is a public mutation that should produce one `public_arg_uses_any` finding for `payload` and produces none today.

1. **Aliased import of the namespace** (`import { v as val }` or `import * as t`):

    ```ts
    import { v as val } from "@lunora/values";
    import { mutation } from "@lunora/server";

    export const update = mutation({
        args: { payload: val.any() },
        handler: async () => null,
    });
    ```

    Missed because `expression.getExpression().getText()` is `"val"`, not `"v"` (`:42`).

2. **Destructured shorthand** (`const { any } = v`):

    ```ts
    const { any } = v;

    export const update = mutation({
        args: { payload: any() },
        handler: async () => null,
    });
    ```

    Missed because the callee is a bare identifier, not a property access, so `vFactoryName` returns `undefined` at `:40-42`.

3. **Helper that returns `v.any()`** (declared in the same file or imported):

    ```ts
    const untyped = () => v.any();

    export const update = mutation({
        args: { payload: untyped() },
        handler: async () => null,
    });
    ```

    Missed because `vFactoryCalls` (`:50`) searches only the descendants of `untyped()`, which contain no `v.any`. The helper's body is never entered.

Forms that are caught today (the existing fixtures in `packages/codegen/__tests__/discover/argument-validators.test.ts` cover the first): a direct `v.any()`, `v.optional(v.any())`, and `v.union(v.any(), …)`, because the `v.any` call is a descendant of the arg initializer. An inline IIFE that calls `v.any()` also works for the same reason.

## Commands

| Purpose       | Command                                                           | Expected on success  |
| ------------- | ----------------------------------------------------------------- | -------------------- |
| Codegen tests | `pnpm --filter "@lunora/codegen" run test -- argument-validators` | all pass             |
| Codegen types | `pnpm --filter "@lunora/codegen" run lint:types`                  | exit 0 (after build) |
| Codegen lint  | `pnpm --filter "@lunora/codegen" run lint:eslint`                 | exit 0               |
| Advisor tests | `pnpm --filter "@lunora/advisor" run test -- security-lints`      | all pass (unchanged) |
| Build deps    | `pnpm --filter "@lunora/codegen..." run build`                    | exit 0               |

If a script name differs, `pnpm --filter "@lunora/codegen" run` lists them. Do not guess. Run `lint:eslint` after any Prettier pass, not before (see `CLAUDE.md`).

## Scope

**In scope** (the only files you should modify):

- `packages/codegen/src/discover/argument-validators.ts`
- `packages/codegen/__tests__/discover/argument-validators.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `packages/advisor/src/lints/static/public-argument-uses-any.ts` — the lint is correct; it only needs the evidence to be complete.
- `packages/advisor/__tests__/security-lints.test.ts` — its tests feed `argValidators` directly and do not exercise discovery.
- `packages/codegen/src/parse-validator.ts` — its alias behaviour is a documented choice for the type parser. Changing it is a separate decision.
- `packages/codegen/src/compile-validator.ts` and `schema-ir.ts` — they handle `v.any()` for emit, not for the advisor.
- Any `CHANGELOG.md` or `api-snapshots/` entry — no public export changes.

## Git workflow

- Branch: `advisor/484-aliased-any-lint`, from `alpha` (`dcffa4d73`).
- One commit. Subject: `fix(codegen): flag v.any() args reached through an alias, destructure, or helper`. Body lines wrap at 100 characters. No provenance or source names in the message.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests first

In `packages/codegen/__tests__/discover/argument-validators.test.ts`, add one fixture per missed form, in the same shape as `WEAK_ARGS`, using the existing `workdir` and `writeFileSync` harness in the `describe` block (`:87`). Each test writes one file under `lunora/`, calls `discoverArgumentValidators(project, join(workdir, "lunora"))`, and asserts `anyArgs` equals `["payload"]`:

- "flags a v.any() reached through an aliased namespace import" — the `val.any()` snippet above.
- "flags a v.any() reached through a destructured any" — the `const { any } = v` snippet above.
- "flags a v.any() returned by a same-file helper" — the `untyped()` snippet above.

Use `expect.assertions(n)` as the file already does. Keep the existing fixtures unchanged, and keep the bare-`v` fixtures working without an import (the current fixtures have no import of `v`).

**Verify**: `pnpm --filter "@lunora/codegen" run test -- argument-validators` → exactly the three new tests fail, and the existing ones still pass. If a new test passes before any change, STOP: the form is already caught and the finding is wrong.

### Step 2: Resolve the namespace and destructured names from the file

In `argument-validators.ts`:

1. Replace the hard-coded `"v"` receiver check with a set of local names that refer to the validator namespace. Collect them from the file's import declarations (an import whose named specifier `v` is aliased, or a namespace import) and keep `"v"` in the set so that unimported fixtures still match.
2. Collect local names bound by a destructure of the namespace (`const { any } = v`), and treat a bare call to one of those names as `v.any()`.
3. Keep `vFactoryName`'s contract: it returns the factory name (`"any"`, `"string"`) or `undefined`. Only the receiver resolution changes.

Do not follow arbitrary identifiers. Resolve only the two binding shapes above.

**Verify**: `pnpm --filter "@lunora/codegen" run test -- argument-validators` → the aliased and destructured tests now pass; the helper test still fails.

### Step 3: Follow a same-file helper one level

When an arg initializer is a call to a `const` arrow or function declared in the same file, search that declaration's body for a `v.<name>(…)` call, using the matcher from Step 2. Follow one level only. A helper that calls another helper is not followed, and the executor must record that as a known limit in the commit body.

Imported helpers are out of scope for this plan. Record that they are still missed.

**Verify**: `pnpm --filter "@lunora/codegen" run test -- argument-validators` → all tests pass, including the helper test.

### Step 4: Negative and regression cases

Add two tests to the same file:

- "does NOT flag a non-validator call named any" — `const any = () => 1; args: { payload: any() }` produces no finding. The name `any` alone must not clear or flag anything.
- "does NOT flag v.any() on an internal procedure" — the existing `INTERNAL` fixture still produces zero findings.

**Verify**: `pnpm --filter "@lunora/codegen" run test -- argument-validators` → all pass.

### Step 5: Gates

```bash
pnpm --filter "@lunora/codegen..." run build
pnpm --filter "@lunora/codegen" run test
pnpm --filter "@lunora/codegen" run lint:types
pnpm --filter "@lunora/codegen" run lint:eslint
pnpm --filter "@lunora/advisor" run test
```

**Verify**: all five exit 0.

## Test plan

- New tests: the three missed-form cases in Step 1, plus the two negatives in Step 4, all in `packages/codegen/__tests__/discover/argument-validators.test.ts`.
- Structural pattern: the existing `WEAK_ARGS` and `INTERNAL` fixtures in the same file.
- Check the lint end to end: after the build, `pnpm --filter "@lunora/advisor" run test` should still pass unchanged. The advisor lint tests feed evidence directly, so they should not change.
- No workerd project is needed. This change touches no SQL, storage, or Durable Object.

## Platform parity

Not applicable. This change alters only a static advisor lint's discovery; it adds no `ctx.*` surface and no binding. No `PlatformCapabilities` row changes.

## Done criteria

- [ ] The three missed-form tests exist and failed before Step 2, and pass after Step 3
- [ ] The two negative tests in Step 4 pass
- [ ] `pnpm --filter "@lunora/codegen" run test` exits 0
- [ ] `pnpm --filter "@lunora/codegen" run lint:types` exits 0
- [ ] `pnpm --filter "@lunora/codegen" run lint:eslint` exits 0
- [ ] `pnpm --filter "@lunora/advisor" run test` exits 0 and its tests are unchanged
- [ ] `git status` shows changes only inside the in-scope list
- [ ] `plans/README.md` row for 484 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `argument-validators.ts:35-50` or `:98-102` does not match the excerpts above (drift).
- A new test passes before any change. The form is already caught, and this plan's finding is wrong for that form.
- Making the aliased or destructured form match requires changing `parse-validator.ts` or the advisor lint. Report instead of widening scope.
- Any existing test in `argument-validators.test.ts` or `security-lints.test.ts` changes its expected output. Do not weaken the existing lint or its assertions to get green.
- The same verification fails twice after a reasonable fix attempt.

## Risks

- **Risk:** Resolving a destructured `any` could match an unrelated local named `any`. Mitigate: bind it only when the destructure source is the namespace name (Step 4 negative test).
- **Risk:** Following helpers adds a second lookup path that can disagree with the parser. Mitigate: follow one level only and state it in the commit body.
- **Perf watch:** Discovery runs over every `lunora/` source file per codegen run. Confirm the added import scan does not measurably change `pnpm --filter "@lunora/codegen" run test` duration. No dedicated `__bench__` suite covers this path.

## Open questions (answer during execution)

1. Should a helper that is imported from another file be flagged as unknown rather than skipped? This plan records it as a known miss. Decide with the advisor if the operator wants it fail-closed.
2. Does the `unbounded_string_arg` lint need the same alias fix in the same commit? This plan says yes, because it shares the matcher. Confirm before the commit.
