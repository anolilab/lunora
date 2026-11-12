# Plan 591 — Expiry and webhook-tolerance thresholds read `7 * 24 * 60 * 60`, and "over an hour" means over

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/codegen/src/discover/storage-uploads.ts packages/codegen/src/discover/payment-webhooks.ts packages/codegen/src/discover/ast.ts packages/advisor/src/lints/static/payment-webhook-wide-tolerance.ts`
> Expect no output.

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** TODO
**Source:** row 53 of the 2026-11-11 audit (advisor lints).

## Status

- **Priority**: P3 · **Effort**: S · **Risk**: LOW · **Depends on**: none · **Category**: bug (lint false negative)

## 0. Headline finding

`storage_presigned_url_for_private_content` (near-7-day expiry) and `payment_webhook_wide_tolerance`
read their thresholds only from a plain numeric literal, so the way people write durations —
`expiresInSeconds: 7 * 24 * 60 * 60`, `webhookToleranceSeconds: 2 * 60 * 60` — is never checked.
The same helper turns a separator literal `604_800` into `NaN` (`Number("604_800")`). And the tolerance
rule fires at exactly 3600 while its description says "over an hour".

## 1. Current state (audit)

- `packages/codegen/src/discover/storage-uploads.ts:28` and `packages/codegen/src/discover/payment-webhooks.ts:20`
  each define the same
  `const numericLiteralValue = (node) => (node && Node.isNumericLiteral(node) ? Number(node.getText()) : undefined);`
- `storage-uploads.ts` uses it for `expiresInSeconds`; `payment-webhooks.ts:23-27` `toleranceFromOptions` for `webhookToleranceSeconds`.
- `packages/advisor/src/lints/static/storage-presigned-url-for-private-content.ts:15,21-22` —
  `NEAR_MAX_EXPIRES_THRESHOLD_SECONDS = 6 * 24 * 60 * 60`; `isNearExpiryCeiling` treats `undefined` as fine.
- `packages/advisor/src/lints/static/payment-webhook-wide-tolerance.ts:13` `WIDE_TOLERANCE_THRESHOLD_SECONDS = 60 * 60`;
  `:47` `row.toleranceSeconds >= WIDE_TOLERANCE_THRESHOLD_SECONDS`; description (`:35-36`) says "(over an hour)"; the JSDoc (`:27-30`)
  says "a computed or env-sourced value is not evaluated".

## 2. Design decisions

- One shared `staticNumberValue(node)` in `packages/codegen/src/discover/ast.ts` (both feeders import it):
  after `unwrapExpression`, a numeric literal → `node.getLiteralValue()` (handles `604_800`); a prefix `-`/`+`
  on a static number; a binary `*`, `+`, `-` of two static numbers; anything else (identifiers, calls, env) → `undefined`.
  Identifiers are NOT followed: keep it to arithmetic over literals, the shape the audit names.
- `>` instead of `>=` for the tolerance, matching "over an hour"; the JSDoc sentence about computed values is updated.

## 3. Steps

### Step 1: shared folding helper

Add `staticNumberValue` to `ast.ts` (named export, short JSDoc saying why: durations are written as products).
Replace both local `numericLiteralValue` helpers with it and delete them.
Tests: in the existing test file for ast helpers if there is one (`ls packages/codegen/__tests__/discover | grep -i ast`), else in
`packages/codegen/__tests__/discover/storage-uploads.test.ts` (find the file with `ls packages/codegen/__tests__/discover | grep -i storage-upload`):

- `expiresInSeconds: 7 * 24 * 60 * 60` → recorded `604800`
- `expiresInSeconds: 604_800` → `604800`
- `expiresInSeconds: (60 * 60) * 24` → `86400`
- safe neighbour: `expiresInSeconds: env.TTL` and `expiresInSeconds: 60 * ttl` → absent (`undefined`).
  And in the payment-webhooks feeder test: `webhookToleranceSeconds: 2 * 60 * 60` → `7200`.

**Verify**: codegen `lint:types` exit 0; the two test files pass.
Commit: `fix(codegen): fold numeric duration arithmetic in storage and webhook options`.

### Step 2: "over an hour" means over

In `payment-webhook-wide-tolerance.ts` change `>=` to `>`, and update the JSDoc sentence to "Fires only on a statically known
`webhookToleranceSeconds` (a literal or arithmetic over literals) above the ceiling; an env-sourced value is not evaluated".
Test in `packages/advisor/__tests__/` (the file that tests this lint: `grep -rl payment_webhook_wide_tolerance packages/advisor/__tests__`):
`toleranceSeconds: 3600` → no finding; `3601` → one finding.

**Verify**: `pnpm --filter "@lunora/advisor" run test` → pass.
Commit: `fix(advisor): flag webhook tolerance only above one hour`.

### Step 3: red without the fix

Restore `storage-uploads.ts`, `payment-webhooks.ts`, `ast.ts` and `payment-webhook-wide-tolerance.ts` from `79b0c5a6a` (`git show … > …`),
run the new tests, confirm the folding cases and the 3600 case FAIL; `git checkout -- packages`; re-run → pass.

### Step 4: gates

codegen and advisor `lint:eslint`, `lint:types`, `test` → exit 0.

## Scope

In scope: `packages/codegen/src/discover/ast.ts` (new helper only), `…/storage-uploads.ts`, `…/payment-webhooks.ts`,
`packages/advisor/src/lints/static/payment-webhook-wide-tolerance.ts`, and the three test files named above.
Out of scope: thresholds' values, `storage-presigned-url-for-private-content.ts`, every app.

## Done criteria

- [ ] codegen and advisor `lint:eslint`, `lint:types`, `test` exit 0
- [ ] `grep -rn "const numericLiteralValue" packages/codegen/src` → no match
- [ ] new folding tests and the 3600 boundary test fail on the baseline sources

## STOP conditions

- A third copy of the literal-only helper exists that this plan does not list (report it, do not change it).
- A verification fails twice.

## 6. Platform parity

Not applicable.

## Maintenance notes

- Rollout: `storage_presigned_url_for_private_content` and `payment_webhook_wide_tolerance` now see durations written as
  products or with separators; `payment_webhook_wide_tolerance` stops firing at exactly 3600 s.
