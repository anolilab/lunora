# Plan 542 — Wire-round-trip `lunoraTest` results the way production does

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):**
> `git diff --stat 4a7c48bfd..HEAD -- packages/testing/src/harness.ts packages/server/src/in-process.ts`
> must print nothing — EXCEPT that plan 543 may have landed first and changed the
> `scheduledDispatchRef` block of `harness.ts` (around lines 919-932); that is expected. Confirm the
> excerpts in §1 match. Any other mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** DONE (review APPROVED; branch `fix/improve-542-harness-wire-round-trip`, commit `7ddac23da` on top of 543's `5e8333fc2`; no existing test changed; seed + 9 examples match baseline; not merged)
**Priority / effort / risk:** P2 / S / MED. **Category:** tests (harness fidelity).
**Depends on:** land after plan 543 (same file, adjacent block). Land on its own: it can change what
existing tests observe.

## 0. Headline finding

`lunoraTest`'s `t.query` / `t.mutation` / `t.action` hand the test the handler's return value **by
reference**. Production runs every dispatch result through the wire codec (`encodeWire` on the shard,
`decodeWire` in the client): an unencodable value (a class instance, a `Decimal`, a `RegExp`) fails
with `WIRE_ENCODE_FAILED` — and for a mutation inside its transaction, so the writes roll back — and
`undefined` object fields are dropped. A test can therefore pass on a value production refuses, or
assert object identity production never preserves.

## 1. Current state (audit)

- `packages/server/src/in-process.ts:280-302` — `runRegisteredFunction(expected, reference, context, args, allowInternal)`
  ends with `return Promise.resolve(reference.handler(context, (args ?? {}) as never));` (no codec).
- `packages/testing/src/harness.ts:934-956` — the top-level entry points:

    ```ts
    const query = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
        if (registeredFunctionKind(referenceOrInline)) {
            return runWithBudget(() => runRegisteredFunction("query", referenceOrInline as never, queryContext, args, false));
        }

        return runWithBudget(() => Promise.resolve((referenceOrInline as InlineQueryFunction<unknown>)(queryContext)));
    }) as TestHarness["query"];

    const mutation = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
        const body = registeredFunctionKind(referenceOrInline)
            ? (): Promise<unknown> => runRegisteredFunction("mutation", referenceOrInline as never, mutationContext, args, false)
            : (): unknown => (referenceOrInline as InlineMutationFunction<unknown>)(mutationContext);

        return runInTransaction(body).then(notifyAfter);
    }) as TestHarness["mutation"];

    const action = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
        if (registeredFunctionKind(referenceOrInline)) {
            return runWithBudget(() => runRegisteredFunction("action", referenceOrInline as never, actionContext, args, false));
        }
        ...
    ```

- Production: `packages/do/src/shard-do.ts:484-485` `wireEncodeFailure = (error) => new LunoraError("WIRE_ENCODE_FAILED", error instanceof Error ? error.message : String(error), { cause: error })`;
  `:511-517` `encodeDispatchResult` (mutation, called INSIDE the transaction); `:524-529` `encodeReadResult`
  (query/action). Composed `ctx.runQuery` / `ctx.runMutation` calls are in-isolate in production and
  are NOT encoded — do not encode them here either.
- Codec facts (`packages/wire/src/wire-codec.ts`): `encodeWire(undefined)` is the tag
  `[TAG, "undefined"]`, which `decodeWire` turns back into `undefined` — a void handler is unaffected.
  `undefined` object FIELDS are dropped. A `Date`, `bigint`, `Uint8Array` round-trip to equal values
  (new instances). A non-plain object throws.
- Precedent in the same package: `packages/testing/src/fake-scheduler.ts:175-192` already round-trips
  job args with `encodeWire` / `decodeWire` from `@lunora/wire` (a dependency of `@lunora/testing`), and
  `LunoraError` from `@lunora/errors` is already imported there.
- Packages and examples whose tests use `lunoraTest` (re-derive with
  `grep -rl "lunoraTest" packages/*/__tests__ examples/*/__tests__ --include='*.ts' --include='*.tsx'`):
  `packages/testing` (19 files), `packages/seed`, and the examples `privacy`, `workos-auth`,
  `team-chat`, `tanstack-start`, `kanban-board`, `feedback-board`, `clerk-auth`, `chess`,
  `auth-playground`.

## 2. Existing seams (do not reinvent)

- `encodeWire` / `decodeWire` from `@lunora/wire`; `LunoraError` from `@lunora/errors`.

## 3. The behavioural contract to preserve

- Inline forms (`t.query((ctx) => …)`, `t.mutation((ctx) => …)`, `t.action((ctx) => …)`, `t.run`) are
  not a production path; leave them returning by reference.
- Composed calls inside a handler are not encoded.
- `t.subscribe` is out of scope (production frames send `result ?? null`; a separate change).

## 4. Design decisions

- A module-level helper in `harness.ts`, `wireRoundTrip(value: unknown): unknown`, returning
  `decodeWire(encodeWire(value))` and mapping a thrown codec error to
  `new LunoraError("WIRE_ENCODE_FAILED", message, { cause })` as `wireEncodeFailure` does.
- Apply it to the REGISTERED branch of `query` and `action` (after the handler resolves, inside
  `runWithBudget`), and to the registered mutation body INSIDE `runInTransaction`
  (`() => runRegisteredFunction(...).then(wireRoundTrip)`), so an unencodable return rolls the
  mutation's writes back exactly as in production.

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                                                                                                                                               | Expected |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Install             | `pnpm install`                                                                                                                                                                                        | exit 0   |
| Build deps          | `pnpm --filter "@lunora/testing..." run build`                                                                                                                                                        | exit 0   |
| New test file       | `pnpm --filter "@lunora/testing" exec vitest run __tests__/wire-round-trip.test.ts`                                                                                                                   | all pass |
| Testing package     | `pnpm --filter "@lunora/testing" run test`                                                                                                                                                            | all pass |
| Seed                | `pnpm --filter "@lunora/seed..." run build` then `pnpm --filter "@lunora/seed" run test`                                                                                                              | all pass |
| Each example        | for each example listed in §1: `pnpm --filter "./examples/<name>..." run build` (skip if it fails for reasons unrelated to this change — record it) then `pnpm --filter "./examples/<name>" run test` | all pass |
| Types               | `pnpm --filter "@lunora/testing" run lint:types`                                                                                                                                                      | exit 0   |
| Format              | `pnpm exec oxfmt packages/testing/src/harness.ts packages/testing/__tests__/wire-round-trip.test.ts`                                                                                                  | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/testing" run lint:eslint`                                                                                                                                                     | exit 0   |

**Scope.** In scope: `packages/testing/src/harness.ts` (the helper and the three registered
branches), `packages/testing/__tests__/wire-round-trip.test.ts` (create), and AT MOST five existing
test files inside `packages/testing/__tests__/` whose assertions depend on by-reference results (see
Step 4). Out of scope: `packages/server/src/in-process.ts`, every test file outside
`packages/testing`, inline forms, `subscribe`.

**Step 1 — install, build, baseline.** Install and build. Run the testing package tests, the seed
tests and each example's tests ONCE before changing anything and record which (if any) already fail
at baseline. Verify: you have a written baseline list.

**Step 2 — failing tests** in `packages/testing/__tests__/wire-round-trip.test.ts` (model the setup
on `packages/testing/__tests__/scheduler.test.ts`: `initLunora.dataModel().create()`, `defineSchema`,
`lunoraTest(schema, { functions })`, and its `trackHarnesses` helper):

1. a query returning `{ at: new Date(0), n: 1n, skip: undefined }` → the result `toStrictEqual({ at: new Date(0), n: 1n })` (no `skip` key) and is not the same object the handler built (capture it in a module variable and `expect(result).not.toBe(captured)`);
2. a query returning an instance of a local `class Money { constructor(public cents: number) {} }` → rejects with `{ code: "WIRE_ENCODE_FAILED" }`;
3. a mutation that inserts a row and returns a `Money` instance → rejects with `WIRE_ENCODE_FAILED`,
   and a following query sees NO inserted row (rolled back);
4. an action returning a `Money` instance → rejects with `WIRE_ENCODE_FAILED`;
5. a mutation returning nothing → resolves `undefined`;
6. the inline form `t.query((ctx) => captured)` still returns the same object (`toBe`).

Verify: new test file → tests 1-4 FAIL, 5 and 6 pass.

**Step 3 — the fix** as in §4. Import `decodeWire`, `encodeWire` from `@lunora/wire` and `LunoraError`
from `@lunora/errors` if not already imported in `harness.ts`. Docblock on the helper: why (production
encodes every dispatch result; a test must see what a client sees).
Verify: new test file → all pass.

**Step 4 — the blast radius.** Run the testing package tests. For each failing test inside
`packages/testing/__tests__`, read it: if it asserts object identity or an `undefined` field on a
REGISTERED function's result, update the assertion to the wire-visible value and note the file and
test name. If more than five files need changing, or a failure is anything else, STOP. Then run seed
and each example. Any failure outside `packages/testing` that is not in the Step 1 baseline is a STOP:
report every failing file and test name with its error; do not edit those files.
Verify: testing tests pass; seed and examples match the baseline.

**Step 5 — red without the fix (mandatory).** Commit (Step 7), then
`git diff 4a7c48bfd..HEAD -- packages/testing/src/harness.ts | git apply -R` (if plan 543 is already
in the base, use `git diff HEAD~1..HEAD` instead), run the new test file, confirm tests 1-4 fail,
restore with `git checkout -- packages/testing/src/harness.ts`, confirm `git status --short` is clean.

**Step 6 — gates.** Format, lint, types. Verify: all exit 0.

**Step 7 — commit.** Stage the changed files by path. Message:

```
fix(testing): wire-round-trip lunoraTest results like production

t.query, t.mutation and t.action handed back the handler's value by
reference, while production encodes every dispatch result and refuses an
unencodable one (inside the mutation's transaction). Registered calls now
round-trip through the wire codec; inline forms are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

List every existing test you changed in the commit body.

## 6. Platform parity

Not applicable: test harness only.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                                     |
| ----- | --------- | ------------------------------------------------------------------------ |
| 0     | Steps 1-7 | tests 1-4 red without the fix; testing, seed and examples match baseline |

## 8. Risks & STOP conditions

- **STOP** on drift (other than plan 543's block) or excerpt mismatch.
- **STOP** if more than five existing test files inside `packages/testing` need changing.
- **STOP** if any suite outside `packages/testing` regresses against the Step 1 baseline: report the
  count and the list. The owner decides whether those tests encode wrong expectations.
- **STOP** if `@lunora/wire` is not a dependency of `@lunora/testing` (check its `package.json`).
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

1. (Owner) `t.subscribe` values: production frames send `result ?? null`; aligning the harness is a
   follow-up.

## Done criteria (all must hold)

- [ ] `git diff --stat <base>..HEAD` lists only in-scope files (harness, the new test file, ≤5 testing tests).
- [ ] `grep -n "wireRoundTrip" packages/testing/src/harness.ts` shows the helper and three uses.
- [ ] Tests 1-4 failed with the fix reverted (Step 5); all six pass with it.
- [ ] testing, seed and every listed example: no regression against the Step 1 baseline.
- [ ] `lint:types` and `lint:eslint` for `@lunora/testing` exit 0.
