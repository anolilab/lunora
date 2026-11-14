# Plan 608 — An identity-bound authorization check that dominates an IDOR sink scopes its key

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report — do
> not improvise. A reviewer dispatched you and maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: branch `fix/improve-608-idor-guard-before-sink` starts at
> `origin/fix/improve-588-idor-identity-scope` (`72544ca39`). `git log --oneline -1` → `72544ca39`.

**Baseline:** `72544ca39` (rebased 588 tip, 2026-11-12)
**Status:** DONE — APPROVED after one review round (helper throw tied to the identity read, read tied to the row parameter, single-row reads only); PR https://github.com/anolilab/lunora/pull/1592 (commits `a6f503f57`, `425dec432`, `aea84a007` — the last accepts the lint-mandated `const { userId } = ctx.auth`). Sweep: no finding disappears.
**Source:** follow-up to row 50 of the 2026-11-11 audit; owner decision (teach the lint) after plan 599 Step 6.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: HIGH (a suppressor; a previous fail-open version was caught in security review) · **Depends on**: plan 588 · **Category**: bug (false positive)

## 0. Headline

After plan 588, a kv/storage/container key counts as scoped only when it contains an identity value or a
database read whose own arguments reference `ctx.auth`. A key read off a row fetched by a caller-supplied id is
reported even when the code checks, before the sink, that the caller is authorised for that row:

```ts
const message = await ctx.db.get("messages", messageId);           // row R, fetched by caller id
if (!message) { throw … }
await requireMember(ctx, message.channelId);                       // identity-bound guard tied to R, enforced by throwing
return await ctx.storage.getSignedUrl(message.attachmentKey, …);   // sink: key from R
```

This plan teaches the shared IDOR suppressor to recognise such a guard, under three conditions that all must
hold. It is a suppressor, so every rule below fails closed: anything not positively matched still reports.

## 1. Current state

- `packages/codegen/src/argument-taint.ts`: `isScopedByIdentity(node)` (exported) with `referencesScopedKeySource`
  (identity root `auth`, or a `ctx.db` read whose arguments reference `ctx.auth` — `isIdentityBoundRead`),
  `trustedInitializerOf`, `valueIdentifiersIn`, `outermostChainOf`, `contextTrustPathOf` (from `discover/context-root.ts`).
- `packages/codegen/src/discover/argument-derived-accesses.ts`: the shared walk; for `config.scope === "identity"`
  (set by `kv-key-accesses.ts`, `storage-key-accesses.ts`, `container-key-accesses.ts`) it skips a row when
  `isScopedByIdentity(key)`.
- Tests: `packages/codegen/__tests__/argument-taint.test.ts` (`describe("isScopedByIdentity")`, fixture helper
  `sinkArgument(body, parameters)`), `packages/codegen/__tests__/discover/storage-key-accesses.test.ts`,
  `kv-key-accesses.test.ts`, `container-key-accesses.test.ts`.
- Helpers that resolve a called function by symbol: `memberFunctionOf` / `declarationOf` in `discover/context-root.ts`
  and `discover/attribution.ts`; `isConstDeclaration`, `unwrapExpression` in `discover/ast.ts`.

## 2. The rule (all three must hold)

Let the sink be the call the walk is inspecting, `K` its key argument, and `F` the innermost function containing the sink.

**(R) The row.** `K` (after `unwrapExpression`, or through one `trustedInitializerOf` hop if `K` is an identifier) is a
member/element-access chain rooted at an identifier `R`, and `R` is bound by a `const` in `F` whose initializer is
(`await` of) a `ctx.db` read (`contextTrustPathOf` root `db` on the callee chain). Otherwise the new rule does not apply.

**(a) Identity-bound guard.** A guard is one of:

1. _Helper guard_: a call statement `await h(…)` / `h(…)` (an `ExpressionStatement` whose expression, after removing
   `await`, is a call) where `h` resolves by symbol to a function declared in the app (same project; a function
   declaration or a `const` arrow/function expression; imported across files is followed; exactly ONE level — a helper
   called inside `h` is not followed). One argument of the call is the handler's ctx itself (`contextTrustPathOf(arg)` is
   `[]`); let `P` be `h`'s parameter at that position (a plain identifier, or `{ db, auth }`-style destructuring is NOT
   followed — fails closed). `h`'s body must contain BOTH a `P.db…` read call whose arguments contain a `P.auth…`
   member chain, AND a `throw` statement (anywhere in `h`'s own body, not in a nested function).
2. _Inline guard_: `const g = await <ctx.db read>(…)` in `F`, whose read arguments reference `ctx.auth`
   (`isIdentityBoundRead` from plan 588), immediately enforced by the next statement being
   `if (<!g | g === undefined | g === null | g == null>) { … throw …; }` or `… return …;` (the then-branch's last
   statement is a `throw` or `return`).
   **(b) Tied to the row.** For a helper guard, one argument OTHER than the ctx contains a value reference to `R`
   (e.g. `message.channelId`). For an inline guard, the read's arguments contain a value reference to `R`.
   **(c) Dominates and is enforced.** The guard statement `S` is a direct child of a `Block` (or the function body) that is
   an ancestor of the sink, and `S` comes before the child of that block that contains the sink. `S` is not inside a nested
   function, a loop body, an `if`/`else` branch, a `switch` case, or a `try` block that has a `catch` clause unless the sink is
   inside that same `try` block. If `h` is `async` (or returns a Promise), the call must be `await`ed. A helper guard is
   enforced only by throwing (its return value is not inspected); an inline guard only by the immediate `if` above.

Apply in `argument-derived-accesses.ts` for `config.scope === "identity"` only:
`isScopedByIdentity(key) || isGuardedByIdentityCheck(call, key)`. Kv, storage and container keys therefore follow the
same rule; browser/image/mail/ai/ratelimit/vector sinks are unchanged.

### Deliberately still reported (each a test)

- guard argument unrelated to `R` (`requireMember(ctx, args.channelId)` while the key comes from `message`);
- inline guard whose result is ignored (no `if`), or checked but the branch does not throw/return;
- guard inside one `if` branch, a loop, or a `catch`-guarded `try` with the sink outside;
- guard after the sink;
- helper whose read is not bound to `P.auth` (`ctx.db.members.findFirst({ where: { userId: args.userId } })`);
- helper that reads with identity but never throws (returns a boolean that the caller ignores);
- helper reached only through another helper (two levels);
- a non-awaited async helper guard;
- a helper whose ctx parameter is destructured.

### Rejected alternatives

- Treating any preceding call that mentions `ctx` as a guard (fail-open; the reason the earlier version was rejected).
- Full control-flow / dataflow analysis (out of proportion; the bounded structural rule covers the documented shape).
- Following helpers recursively (unbounded; harder to review).
- Accepting a guard whose result is used later (e.g. passed into the sink) — only throw/return enforcement counts.

## 3. Steps

1. Implement `isGuardedByIdentityCheck(sinkCall, key)` in `packages/codegen/src/argument-taint.ts` (small helpers above the
   exports; JSDoc stating §2 exactly), and wire it in `argument-derived-accesses.ts` for `scope === "identity"`.
   **Verify**: `pnpm --filter "@lunora/codegen" run lint:types` exit 0.
2. Tests in `packages/codegen/__tests__/discover/storage-key-accesses.test.ts` (fixture style of that file; helper
   declared in the same fixture file, and one variant with the helper in a second file):
   the team-chat shape → no row; an inline guard shape → no row; every "still reported" shape in §2 → one row each.
   Mirror one passing and one reporting case in `kv-key-accesses.test.ts` and `container-key-accesses.test.ts`.
   **Verify**: the files pass. Red: restore `argument-taint.ts` and `argument-derived-accesses.ts` from `72544ca39`
   (`git show 72544ca39:<p> > <p>`), the "no row" tests FAIL; restore; pass.
3. `pnpm --filter "@lunora/codegen" run test`, `lint:eslint`, `lint:types` exit 0; oxfmt on changed files.
   Commit: `fix(codegen): accept an identity-bound guard that dominates an IDOR sink`.

## Scope

In: `packages/codegen/src/argument-taint.ts`, `packages/codegen/src/discover/argument-derived-accesses.ts`, the three
feeder test files (and `argument-taint.test.ts` if a unit test fits better). Out: every other feeder, every lint, every app.

## STOP conditions

- Resolving a helper across files needs a project setup the feeder does not have.
- A test outside the in-scope files changes outcome.
- A verification fails twice.

## 6. Platform parity

Not applicable.

## Maintenance notes

- Reviewer: run the sweep over all 34 in-repo apps; every finding that disappears must be read and confirmed to have
  such a guard. The PR body states precisely what counts as scoping.
