# Plan 417: Make `withAuthAudit` forward the caller's `hooks.after` return value

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Your reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/auth/src/audit-hooks.ts packages/auth/__tests__/audit-hooks.behaviour.test.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

better-auth's after-hook runner treats **any non-`undefined` value a hook resolves to as the endpoint's new response** — this file's own CRITICAL comment (`packages/auth/src/audit-hooks.ts:348-359`) documents that fact and pins it in `__tests__/audit-hooks.behaviour.test.ts`. Yet `withAuthAudit`'s composition (`audit-hooks.ts:368-377`) does `await existing(context)` and **discards the result**, returning the audit hook's value instead. An app that composes its own `hooks.after` to rewrite a response (the documented better-auth way to reshape, say, a sign-in payload) silently loses that rewrite the moment it wraps its options in `withAuthAudit` — the endpoint answers as if the app's hook never ran, with no error anywhere.

## Current state

- `packages/auth/src/audit-hooks.ts:368-377`:
    ```ts
    const after = existing
        ? async (context: unknown): Promise<unknown> => {
              await existing(context);

              return (audit as unknown as (context: unknown) => Promise<unknown>)(context);
          }
        : audit;
    ```
- The audit hook itself always `return undefined;` (`audit-hooks.ts:360`) — deliberately, per the CRITICAL comment at `:348-359` — so in the composed form the caller's return value is dropped and replaced by `undefined`.
- The doc comment above `withAuthAudit` (`:363-366`) says "theirs runs first, then the audit record" — ordering is right; only the return value is lost.

## Commands you will need

| Purpose    | Command                                        | Expected on success |
| ---------- | ---------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                 | exit 0              |
| Build deps | `pnpm --filter "@lunora/auth..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/auth" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/auth" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/auth" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/auth/src/audit-hooks.ts` (only the `withAuthAudit` composition)
- `packages/auth/__tests__/audit-hooks.behaviour.test.ts`

**Out of scope**:

- `authAuditHook` itself — its `return undefined` contract is correct and pinned by tests; do not change it.
- `email-gate.ts` — its before-hook composition has different semantics (before-hooks chain values); leave it.

## Git workflow

- Branch: shared wave branch `improve/wave22-auth`.
- Commit: `fix(auth): forward caller after-hook return in audit`

## Steps

### Step 1: Preserve the caller's return value

Change the composed hook to:

```ts
const after = existing
    ? async (context: unknown): Promise<unknown> => {
          const returned = await existing(context);

          await (audit as unknown as (context: unknown) => Promise<unknown>)(context);

          // The audit hook records a side effect and must never replace a
          // response the caller's own hook produced.
          return returned;
      }
    : audit;
```

Note the audit still runs after the caller's hook (ordering documented at `:363-366`), and its own return value (always `undefined`) is intentionally not used.

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0.

### Step 2: Composition test

In `audit-hooks.behaviour.test.ts`, next to the existing "hooks.after return value" suite (which pins the `undefined` no-op), add: compose `withAuthAudit` over options whose `hooks.after` returns a replacement object; assert the composed `after` resolves to that object (and the audit side effect still fired — reuse however the existing suite observes the audit write).

**Verify**: `pnpm --filter "@lunora/auth" run test` → all pass including the new test.

## Test plan

One new test as in Step 2; the existing suite already covers the no-existing-hook and audit-failure-swallowing paths.

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run test` exits 0 with the new composition test
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] The composed hook returns the caller's value (read the diff)
- [ ] No files outside scope modified

## STOP conditions

- The existing "hooks.after return value" suite fails after the change — that suite pins the _uncomposed_ hook's `undefined` contract; if it starts failing, the change leaked into `authAuditHook` itself. Stop.
- Current-state excerpts don't match live code.

## Maintenance notes

- If a second hook-composing helper is ever added to this package, note the asymmetry: after-hooks forward the _first_ non-undefined return; before-hooks (email-gate) chain. A shared composer is only worth it at a third instance.
