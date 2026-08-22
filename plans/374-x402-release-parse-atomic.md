# Plan 374: Parse the released amount in `releaseSpendOnFailure` with `parseAtomicAmount`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/x402/src/pay/policy.ts packages/x402/__tests__/pay-policy.test.ts`
> If either changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`releaseSpendOnFailure` calls bare `BigInt()` on `context.selectedRequirements.amount` — a server-controlled string. The same file defines `parseAtomicAmount` specifically because bare `BigInt` "is the wrong tool twice over: it throws on junk … and it accepts `"-1"`", and both sibling enforcement paths use it. Here, junk makes the failure hook **throw**, replacing/masking the payment-creation error the client was about to see; and a negative string makes `release()` _increase_ `spent` (`spent > amount` is true for any negative `amount`, so `spent - amount` adds), prematurely locking the wallet out for the rest of the run. Reaching it requires the guard's reservation path to have been bypassed, so it is latent — but the file's own docs say the hooks defend against exactly that mis-wiring. `@lunora/x402` is experimental tier.

## Current state

- `packages/x402/src/pay/policy.ts:458-464`:
    ```ts
    export const releaseSpendOnFailure =
        (state: SpendState): OnPaymentCreationFailureHook =>
        (context) => {
            state.release(BigInt(context.selectedRequirements.amount));

            return Promise.resolve();
        };
    ```
- The helper — `policy.ts:44-53`:
    ```ts
    const ATOMIC_AMOUNT = /^\d+$/;
    /**
     * Parse a requirement's `amount`, or return `undefined` if it isn't a canonical atomic
     * quantity. The value is chosen by the *server*, so bare `BigInt` is the wrong tool
     * twice over: ...
     */
    const parseAtomicAmount = (raw: string): bigint | undefined => (ATOMIC_AMOUNT.test(raw) ? BigInt(raw) : undefined);
    ```
- The two sibling call sites that already parse: `policy.ts:321` (selection filter) and `policy.ts:398` (guard).
- The arithmetic hazard — `policy.ts:182-184`:
    ```ts
    release: (amount: bigint): void => {
        spent = spent > amount ? spent - amount : 0n;
    },
    ```

## Commands you will need

| Purpose    | Command                                        | Expected on success |
| ---------- | ---------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                 | exit 0              |
| Build deps | `pnpm --filter "@lunora/x402..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/x402" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/x402" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/x402" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/x402/src/pay/policy.ts` (the `releaseSpendOnFailure` body only)
- `packages/x402/__tests__/pay-policy.test.ts`

**Out of scope**:

- `parseAtomicAmount`, `createSpendState`, the guard, and the selection filter — all correct.
- Hardening `release()` itself against negative bigints — the parse-at-the-boundary fix makes the hook safe, and typed callers passing negative bigints is a different (compile-visible) misuse.

## Git workflow

- Branch: `improve/wave22-x402`.
- Commit: `fix(x402): parse released amount fail-closed`

## Steps

### Step 1: Parse before releasing

```ts
export const releaseSpendOnFailure =
    (state: SpendState): OnPaymentCreationFailureHook =>
    (context) => {
        // Server-controlled string — same fail-closed parse as the guard and the
        // selection filter. An unparsable amount releases nothing rather than
        // throwing out of a failure hook (which would mask the original error)
        // or, for a negative value, inflating the ledger.
        const amount = parseAtomicAmount(context.selectedRequirements.amount);

        if (amount !== undefined) {
            state.release(amount);
        }

        return Promise.resolve();
    };
```

**Verify**: `grep -n "BigInt(context" packages/x402/src/pay/policy.ts` → no matches.

### Step 2: Tests

In `pay-policy.test.ts`, next to the existing `releaseSpendOnFailure` / spend-state tests (find them: `grep -n "releaseSpendOnFailure\|createSpendState" packages/x402/__tests__/pay-policy.test.ts`):

- Valid amount string still releases (spent drops).
- `amount: "-1"` → hook resolves without throwing, `spentAtomic` unchanged.
- `amount: "junk"` → hook resolves without throwing, `spentAtomic` unchanged.

**Verify**: `pnpm --filter "@lunora/x402" run test` → all pass including the 3 new cases.

## Test plan

As Step 2 — assert `spentAtomic` before/after in each case, not merely "doesn't throw".

## Done criteria

- [ ] `grep -n "BigInt(context" packages/x402/src/pay/policy.ts` → no matches
- [ ] `pnpm --filter "@lunora/x402" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/x402" run lint:types` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The excerpts don't match the live code.
- `releaseSpendOnFailure` has other callers/tests relying on the throw-on-junk behavior (grep first) — report.

## Maintenance notes

- Reviewer: the silent no-op on unparsable amounts is deliberate (fail-closed: worst case the run over-counts spend, never under-counts). The comment in the code carries this.
- If a fourth `amount`-consuming path appears in this file, it must use `parseAtomicAmount` too — three of three now do.
