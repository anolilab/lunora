# Plan 479: Make `createPayment`'s `authorize` required, so mutations default-deny

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d8a41fe8d..HEAD -- packages/payment/src packages/payment/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `d8a41fe8d`, 2026-10-10

## Why this matters

`createPayment` (the raw factory in `@lunora/payment`) makes `authorize` optional, and when it is omitted `ensureAuthorized` returns without checking anything. The mutations that move money (`createCheckout`, `attach`, `capture`, `cancel`, `refund`, `track`) all call `ensureAuthorized(referenceId)` first. An app that wires the raw factory without an authorizer, and exposes those methods to clients, lets any caller charge, capture, or refund any `referenceId`. That is an IDOR on money movement. The repo's own advisor lint `payment-create-without-authorize` already flags this configuration, so the risk is known but the default is still open. After this plan the safe behavior is the only behavior: callers that really are trusted server code must say so explicitly.

## Current state

- `packages/payment/src/create-payment.ts:118-123` — the option is optional, and the doc comment says "Omit only for trusted server-internal callers (e.g. the reconciliation sweep)":

    ```ts
    readonly authorize?: AuthorizeReference;
    ```

- `packages/payment/src/create-payment.ts:189-193` — the early return that makes omission default-open:

    ```ts
    const ensureAuthorized = async (referenceId: string): Promise<void> => {
        if (!options.authorize) {
            return;
        }
    ```

- `packages/payment/src/context.ts:85-92` — the app-facing wrapper always passes an authorizer, so the default-open path is only reachable through the raw factory:

    ```ts
    authorize: authorize ? (referenceId) => authorize(referenceId, caller) : (referenceId) => caller.userId !== undefined && referenceId === caller.userId,
    ```

- Many tests call `createPayment({ adapter, store })` with no `authorize`, e.g. `packages/payment/__tests__/create-payment.test.ts:84`, `:111`, `:154`, `:184`, `:204`, and `packages/payment/__tests__/providers/autumn.test.ts:475`, `:494`.
- The repo's exemplar for a closed-by-default check is the same file's own denial branch (`create-payment.ts:200-210`): a throwing or non-`true` authorizer raises `LunoraPaymentError("FORBIDDEN", ...)`. Match that style.

Convention reminders (from `CLAUDE.md`): this is the `alpha` branch, so change the API and update every call site in the same change — no deprecated alias and no `legacy*` shim. Named exports only. Relative imports have no `.js` extension.

## Commands you will need

| Purpose       | Command                                                                       | Expected on success |
| ------------- | ----------------------------------------------------------------------------- | ------------------- |
| Build deps    | `pnpm run build:packages` (or `pnpm --filter "@lunora/payment..." run build`) | exit 0              |
| Typecheck     | `pnpm --filter "@lunora/payment" run lint:types`                              | exit 0              |
| Package tests | `pnpm --filter "@lunora/payment" run test`                                    | all pass            |
| Lint          | `pnpm --filter "@lunora/payment" run lint:eslint`                             | exit 0              |
| Package.json  | `pnpm run lint:package-json`                                                  | exit 0              |

If a script name differs in this repo, `pnpm --filter "@lunora/payment" run` lists them. Do not guess.

## Suggested executor toolkit

- Read `.agents/docs/packages.md` for package ownership before editing across packages.

## Scope

**In scope** (the only files you should modify):

- `packages/payment/src/create-payment.ts`
- `packages/payment/src/context.ts` (only if it needs the explicit bypass name)
- `packages/payment/__tests__/create-payment.test.ts`
- `packages/payment/__tests__/providers/autumn.test.ts`
- any other `packages/payment/__tests__/**` file that calls `createPayment(` without `authorize`
- `packages/payment/src/index.ts` only if an exported type must change
- `api-snapshots/` entries for `@lunora/payment` (regenerate with the repo's `api:update` after a fresh build — see Step 5)

**Out of scope** (do NOT touch, even though they look related):

- `packages/payment/src/reconcile.ts` logic and its state machine — only its access to the bypass changes, if needed.
- `packages/payment/src/webhook.ts`, `packages/payment/src/sync.ts` — webhook path is not gated by `authorize` and must stay that way.
- The provider adapters under `packages/payment/src/providers/`.
- `packages/advisor` lint rules — do not weaken or delete the `payment-create-without-authorize` lint. After this change it should be a no-op for the framework path; leave it in place.

## Git workflow

- Branch: `advisor/479-payment-authorize-default-deny`, branched from `alpha`.
- One commit. Subject example from this repo's history: `fix(payment): default-deny createPayment mutations without an authorizer`. Include in the body that this is a breaking change on alpha (the `authorize` option is now required; omission is a compile error), and paste the Step 1 grep output.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Prove there are no production callers without `authorize`

Run:

```bash
grep -rn "createPayment(" packages apps examples templates sdks shared --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v __tests__
```

Expected: the only production call is `packages/payment/src/context.ts:90`, which always passes `authorize` (line 92). `reconcile.ts` does not construct `createPayment`. Record the output in the commit body.

**Verify**: the grep output matches the expectation above. If any production call omits `authorize`, STOP (see STOP conditions) — do not add a bypass to make it compile.

### Step 2: Make `authorize` required

In `packages/payment/src/create-payment.ts`:

1. Change `CreatePaymentOptions` so `authorize` is required:

    ```ts
    export interface CreatePaymentOptions {
        readonly adapter: PaymentAdapter;
        /**
         * Per-caller authorization for every mutation. Return `true` to allow; anything else
         * (including a throw) rejects with 403. Required — there is no default-open mode.
         */
        readonly authorize: AuthorizeReference;
        ...
    }
    ```

2. Delete the `if (!options.authorize) { return; }` branch in `ensureAuthorized` (`:191-193`). Do **not** add an `internal` or `trustedServerInternal` bypass: the repo's rule is no knobs until a second use exists, and Step 1 found none.

**Verify**: `pnpm --filter "@lunora/payment" run lint:types` → exit 0 after Step 3 updates the test call sites. Do not "fix" errors by casting.

### Step 3: Update the test call sites

Every test that calls `createPayment` without `authorize` (found in Step 1's grep of `__tests__` — at least `create-payment.test.ts:84, 111, 154, 184, 204` and `providers/autumn.test.ts:475, 494`) gets `authorize: () => true` when it tests behaviour unrelated to authorization. Keep the authorization-specific cases that already pass a predicate (`create-payment.test.ts:238` and `:266`).

Do not add a shared test helper that hides the requirement.

**Verify**: `pnpm --filter "@lunora/payment" run lint:types` → exit 0.

### Step 4: Add the regression tests

In `packages/payment/__tests__/create-payment.test.ts`, following the existing structure there (model after the `authorize: (referenceId) => referenceId === "user_1"` cases near line 238):

1. "denies checkout when the authorizer returns false" — `createCheckout` for `referenceId: "user_2"` with an authorizer that only allows `user_1` rejects with `LunoraPaymentError` code `FORBIDDEN`, and the fake adapter's checkout spy is not called.
2. "denies capture and refund for a foreign reference" — same pattern for `capture` and `refund`.
3. "denies when the authorizer throws" — authorizer throws; expect `FORBIDDEN`.

Use `expect.assertions(n)` in each new test, as the file already does.

**Verify**: `pnpm --filter "@lunora/payment" run test -- create-payment` → all pass, including the 3 new tests.

### Step 5: Refresh the API snapshot (only if it changed)

`CreatePaymentOptions` is public. Build first, then update the snapshot:

```bash
pnpm --filter "@lunora/payment..." run build
pnpm run api:check
```

If `api:check` reports drift for `@lunora/payment` only, run `pnpm run api:update` and confirm the diff touches only `api-snapshots/` for payment. If `api:check` reports drift in another package, STOP — that means the build was stale or an unrelated change exists.

**Verify**: `pnpm run api:check` → exit 0.

### Step 6: Full package gate

```bash
pnpm --filter "@lunora/payment" run test
pnpm --filter "@lunora/payment" run lint:eslint
pnpm --filter "@lunora/payment" run lint:types
pnpm run lint:package-json
```

**Verify**: all four exit 0.

## Test plan

- New tests: the three cases in Step 4, in `packages/payment/__tests__/create-payment.test.ts`.
- Structural pattern: the existing authorization cases in the same file around line 238.
- Verification: `pnpm --filter "@lunora/payment" run test` → all pass, including the new tests.
- This package has a `workerd` project only if it touches storage; this change does not touch SQL or a Durable Object, so `test:workerd` is not required. Confirm with `grep -n "workerd" packages/payment/vitest.config.ts`; if it exists, run `pnpm --filter "@lunora/payment" run test:workerd` as well.

## Platform parity

Not applicable to the matrix: `createPayment`'s mutations are existing `ctx.*` payment surfaces, and this change tightens their authorization without adding or moving a surface. No `PlatformCapabilities` row changes.

## Done criteria

- [ ] `grep -n "if (!options.authorize)" packages/payment/src/create-payment.ts` returns no matches
- [ ] `grep -n "readonly authorize?" packages/payment/src/create-payment.ts` returns no matches
- [ ] `pnpm --filter "@lunora/payment" run test` exits 0, and the new tests exist and pass
- [ ] `pnpm run test:workerd` exits 0 if payment has a workerd project
- [ ] `pnpm --filter "@lunora/payment" run lint:types` exits 0
- [ ] `pnpm run api:check` exits 0
- [ ] `git status` shows changes only inside the in-scope list
- [ ] `plans/README.md` row for 479 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `create-payment.ts:118-123` or `:189-193` does not match the excerpts above (drift).
- Step 1 finds a call site in `apps/`, `templates/`, `examples/`, or `sdks/` that constructs `createPayment` without `authorize`. Report the site; do not add a bypass.
- The reconcile sweep turns out to need caller identity, not a bypass. Report instead of inventing a policy.
- Step 2's `lint:types` fails in a file outside the in-scope list.
- The same verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Future mutations added to `createPayment` must call `ensureAuthorized` before any provider call. Reviewers should check every new method for this.
- The advisor lint `payment-create-without-authorize` is intentionally left in place; with this change it should only fire on custom wrappers that bypass the factory. Review its output after this lands.
- Deliberately deferred: an audit of whether `context.ts`'s default (`referenceId === caller.userId`) is the right default for orgs. That is a product decision, not a bug in this plan.
