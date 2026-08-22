# Plan 366: Make `money()` reject fractional and non-finite amounts instead of silently truncating

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/payment/src/money.ts packages/payment/__tests__/money.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`money(19.99, "USD")` returns **19** minor units — a 99% under-charge — because the constructor truncates fractional numbers instead of rejecting them, directly under a docstring that says "never use floats for amounts". `money(Number.NaN, "USD")` throws a bare `RangeError` from `BigInt` rather than a `LunoraPaymentError`. Every in-repo adapter pre-rounds before calling `money`, which is exactly why the hole is invisible internally and only bites app authors calling the exported helper. The repo already has the correct pattern one file over: `track()` rejects a non-safe-integer quantity at the boundary with `VALIDATION_ERROR`.

## Current state

- `packages/payment/src/money.ts:53-61`:
    ```ts
    /**
     * Construct money. Currency is normalized to uppercase; never use floats for amounts.
     * @experimental
     */
    export const money = (minorUnits: bigint | number, currency: CurrencyCode): Money => {
        const units = typeof minorUnits === "bigint" ? minorUnits : BigInt(Math.trunc(minorUnits));

        return { currency: currency.toUpperCase(), minorUnits: units };
    };
    ```
- The exemplar guard to mirror — `packages/payment/src/create-payment.ts:390-392` (inside `track`):
    ```ts
    if (!Number.isSafeInteger(target) || target < 0) {
        throw new LunoraPaymentError("VALIDATION_ERROR", `track(): \`quantity\` must be a non-negative safe integer (got ${String(input.quantity)})`);
    }
    ```
    (No `target < 0` check here — negative money is legitimate for refund math; only integrality/finiteness is at issue.)
- In-repo callers pass either `bigint` or pre-rounded numbers (`Math.round(...)` in `providers/stripe.ts:126,174,205,236,250` and `providers/polar.ts:117`); `zeroMoney` passes `0n`. No in-repo caller passes a fraction.
- `LunoraPaymentError` lives in `packages/payment/src/error.ts` (verify the exact import path used by `money.ts`'s siblings — `create-payment.ts` imports it from `"./error"`).

## Commands you will need

| Purpose    | Command                                           | Expected on success |
| ---------- | ------------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                    | exit 0              |
| Build deps | `pnpm --filter "@lunora/payment..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/payment" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/payment" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/payment" run lint:eslint` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/payment/src/money.ts`
- `packages/payment/__tests__/money.test.ts`

**Out of scope**:

- The provider adapters (`providers/*.ts`) — their `Math.round` pre-rounding is deliberate provider-payload normalization; do not change it.
- `formatMoney` — its `Number(minorUnits)` is documented UI-only.
- `track()`'s guard in `create-payment.ts` — already correct.

## Git workflow

- Branch: shared wave branch `improve/wave22-payment` (your dispatcher creates it).
- Commit: `fix(payment): reject fractional amounts in money()`

## Steps

### Step 1: Guard the number branch

In `packages/payment/src/money.ts`, replace the truncation with a validation guard:

```ts
export const money = (minorUnits: bigint | number, currency: CurrencyCode): Money => {
    if (typeof minorUnits === "number" && !Number.isSafeInteger(minorUnits)) {
        throw new LunoraPaymentError("VALIDATION_ERROR", `money(): \`minorUnits\` must be a bigint or a safe integer (got ${String(minorUnits)})`);
    }

    const units = typeof minorUnits === "bigint" ? minorUnits : BigInt(minorUnits);

    return { currency: currency.toUpperCase(), minorUnits: units };
};
```

Import `LunoraPaymentError` the same way sibling files do (check `create-payment.ts`'s import). Note `Number.isSafeInteger` also rejects `NaN`, `Infinity`, and `-Infinity`, so the bare-`RangeError` path is closed by the same check.

**Verify**: `grep -n "Math.trunc" packages/payment/src/money.ts` → no matches.

### Step 2: Regression tests

In `packages/payment/__tests__/money.test.ts` (model after the existing tests in that file), add:

- `money(19.99, "USD")` throws `LunoraPaymentError` with code `VALIDATION_ERROR`.
- `money(Number.NaN, "USD")` throws `LunoraPaymentError` (not a bare `RangeError`).
- `money(1999, "usd")` still returns `{ currency: "USD", minorUnits: 1999n }` (happy path unchanged).
- `money(-500, "USD")` still works (negative integers are legal).

**Verify**: `pnpm --filter "@lunora/payment" run test` → all pass, including the new tests.

## Test plan

- 4 new cases in `money.test.ts` as listed in Step 2; keep existing cases green.
- If an existing test asserts the truncating behavior, it encoded the bug — update it and say so in the commit body.

## Done criteria

- [ ] `grep -n "Math.trunc" packages/payment/src/money.ts` → no matches
- [ ] `pnpm --filter "@lunora/payment" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/payment" run lint:types` exits 0
- [ ] `pnpm --filter "@lunora/payment" run lint:eslint` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The `money()` excerpt doesn't match the live code.
- Any in-repo caller actually passes a fractional number (search: `grep -rn "money(" packages/payment/src/` and inspect) — that caller would start throwing; report instead of "fixing" the caller.
- A test outside `money.test.ts` fails after the change.

## Maintenance notes

- The error message intentionally names `money()` so app authors see where the bad value entered.
- Reviewer: confirm the guard is on the number branch only — bigints of any size remain valid.
