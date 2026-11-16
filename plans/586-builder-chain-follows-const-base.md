# Plan 586 — A middleware on a shared base builder (`const guarded = mutation.use(…)`) counts for every procedure built on it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/codegen/src/discover/builder-chain.ts packages/codegen/src/discover/procedure-middleware.ts packages/codegen/src/discover/functions/classify-procedure-call.ts`
> Expected: only the changes plan 584 made on this branch (builder-chain.ts, procedure-middleware.ts).

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** DONE — APPROVED; PR https://github.com/anolilab/lunora/pull/1572 (same branch as 584, commit `5008c619c`).
**Source:** row 48 of the 2026-11-11 audit (advisor lints). Same branch as plan 584, lands after it.

## Status

- **Priority**: P2 · **Effort**: M · **Risk**: LOW (removes false positives; may add RLS/mask-driven findings) · **Depends on**: plan 584 · **Category**: bug (lint false positive)

## 0. Headline finding

With `const guarded = mutation.use(rateLimit(...)); export const send = guarded.mutation(h)`, every
chain reader stops at the identifier `guarded`, so `send` reads as having no rate limit / RLS /
captcha / mask. That yields false `public_mutation_without_ratelimit`,
`privileged_fanout_from_public_procedure` and `user_creating_mutation_without_captcha` findings.

## 1. Current state (audit)

- `packages/codegen/src/discover/builder-chain.ts` `walkBuilderChain` (~line 34): loops while the
  current node is a `CallExpression` whose callee is a property access; returns `{ root: current, steps }`
  when it reaches a non-call (an identifier like `guarded`). It never looks at what `guarded` is bound to.
- `packages/codegen/src/discover/procedure-middleware.ts:203-226` — `protectionsInChain(receiver)` has its
  OWN loop (same shape) over `.use(...)` steps, so it stops at `guarded` too.
- `functions/classify-procedure-call.ts:85-121` — `resolveBuilderRootKind` already follows a root
  identifier's `const` initializer ONE hop by hand, so the procedure is classified; and
  `usesPlatformAdmin` (~line 136) does the same for one hop. They show the hop is safe.

## 2. Design decisions

- **Follow the root in the one shared walk.** When `walkBuilderChain` ends at an `Identifier` whose symbol's
  value declaration is a `VariableDeclaration` that passes `isConstDeclaration` (from `./ast`) and whose
  initializer (unwrapped) is a `CallExpression`, continue the walk into that initializer, appending its
  steps, for at most 3 hops (cycle-safe). `root` becomes where the last hop ends. Chosen over patching each
  reader: every reader (`builderChainSteps`, `wrappedCallsWhere`, `chainHasStep`, `builderChainRoot`) then agrees.
- **`protectionsInChain` uses `builderChainSteps`** instead of its own loop, so it inherits the hop.
- The manual one-hop code in `classify-procedure-call.ts` stays (harmless; removing it is a separate cleanup).

## 3. Steps

### Step 1: follow const roots in `walkBuilderChain`

Implement §2 in `builder-chain.ts` (a `hops` counter local to the function; JSDoc updated: "a root
bound to a `const` builder is followed, up to three hops, so `const base = mutation.use(x); base.mutation(h)`
carries `x`").

**Verify**: types exit 0; `pnpm --filter "@lunora/codegen" exec vitest run __tests__/discover` → all existing pass. If any existing test changes outcome, STOP and report.

### Step 2: `protectionsInChain` on the shared walk

Rewrite `protectionsInChain` to iterate `builderChainSteps(receiver).filter((step) => step.name === "use")`
and call `useStepProtections(step.call.getArguments()[0])` for each (skip a missing argument). Same OR-merge as today.

### Step 3: tests

In `packages/codegen/__tests__/discover/procedure-middleware.test.ts`, mirror an existing rate-limit test:

- `const guarded = mutation.use(rateLimit({...as the existing test...})); export const send = guarded.mutation(async () => {});` → `usesRateLimit: true` (new).
- two hops: `const a = mutation.use(rateLimit(...)); const b = a.input({}); export const send = b.mutation(...)` → `usesRateLimit: true`.
- safe neighbour: `const plain = mutation.input({}); export const send = plain.mutation(...)` → `usesRateLimit: false`.
- `let base = mutation.use(rateLimit(...)); export const send = base.mutation(...)` → `usesRateLimit: false` (a `let` is not followed).
  In `rls-internal-chain.test.ts`: `const base = query.use(rls(p)); export const q = base.query(h)` → one rls call (new).

**Verify**: both files pass. Commit: `fix(codegen): follow a const base builder in the builder-chain walk`.

### Step 4: red without the fix

`git show HEAD~1:packages/codegen/src/discover/builder-chain.ts > …` and the same for `procedure-middleware.ts`
(HEAD~1 is plan 584's last commit), run the two test files, confirm the new positive tests FAIL; `git checkout -- packages/codegen/src`; re-run → pass.

### Step 5: gates

codegen `test`, `lint:eslint`, `lint:types` exit 0.

## Scope

In scope: `packages/codegen/src/discover/builder-chain.ts`, `…/procedure-middleware.ts` (`protectionsInChain` only),
`packages/codegen/__tests__/discover/procedure-middleware.test.ts`, `…/rls-internal-chain.test.ts`.
Out of scope: `classify-procedure-call.ts`, every lint, every app.

## Done criteria

- [ ] codegen `test`, `lint:eslint`, `lint:types` exit 0
- [ ] new positive tests fail without the fix; the `let` and plain-base neighbours pass either way

## STOP conditions

- An existing discover test changes outcome after Step 1.
- A verification fails twice.

## 6. Platform parity

Not applicable.

## Maintenance notes

- Rollout: procedures built on a shared base builder now inherit its `.use(...)` middleware, so
  `public_mutation_without_ratelimit`, `privileged_fanout_from_public_procedure` and
  `user_creating_mutation_without_captcha` stop firing on them; RLS/mask-driven rules start seeing them.
