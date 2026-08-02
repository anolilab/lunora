# Wave 18 execution — live status

Scratch tracker for the /improve execute run (plans 254-299, 290 skipped by request).
Authoritative per-plan status lives in the tables in `README.md`; this file just
tracks dispatch so nothing is lost between sessions.

## COMPLETE — all 45 dispatched plans verified

254 · 255 · 256 · 257 · 259 · 260 · 261 · 262 · 263 · 264 · 265 · 266 · 267 · 268
· 269 · 270 · 271 · 272 · 273 · 274 · 275 · 276 · 277 · 278 · 279 · 282 · 283 ·
284 · 285 · 286 (Phase A) · 287 · 288 · 289 · 291 · 292 · 293 · 294 · 295 · 296 ·
297 · 298 · 299 · 301 — **verified**

Two REVISE rounds, both resolved: the platform chain (a `plans/` file edit
rewritten out) and the cross-tab chain (a destabilized pre-existing test, which
turned out to be 16 tests leaking timers — fixed with pure cleanup).

## Remaining

- **300** — decode wire-tagged doc columns for display. NOT dispatched: it needs
  `decodeDocJson`, which exists only on 265's branch. Branch from 265, not `alpha`.
- **286 W4** — the deletion phase. Blocked on a decision: the `@deprecated`
  annotations do not survive packem's dts bundler, so the deprecation cycle
  currently warns nobody. See §10 of that plan.

## Not yet dispatched

- **300** (decode wire-tagged doc columns for display) — depends on 265's branch
  for `decodeDocJson`; branch from it rather than from `alpha`.

Everything else has been dispatched. 286, 293, 294, 295, 296, 297, 299 and 301
went out in the "fix all found issues" round.

## Excluded

- 290 (eslint markdown crash) — skipped at the user's request.

## Three pre-existing red gates on `alpha` — ALL NOW FIXED ON BRANCHES

1. `pnpm --filter "@lunora/server" run lint:types` — duplicate `withGeoIndex` key
   in `mask.test.ts` (TS1117). **Fixed** — independently, on BOTH `advisor/254-*`
   and `advisor/270-*`, so those two conflict on that file at merge (take either
   side).
2. `pnpm --filter "@lunora/errors" run test` — 3 unregistered codes.
   **Fixed** on `advisor/293-*`: 527-passed/1-failed → **533 passed**.
3. `pnpm --filter "@lunora/advisor" run test` — **2 failures, but only on a tree
   with a freshly-built `@lunora/server`.** Passes on `alpha` today purely because
   `packages/server/dist/` is stale and predates `validateIndexFields`. Confirmed
   in two independent worktrees, one of which touched no dependencies, so it is
   not caused by plan 288's sweep. `defineSchema` now throws on the very condition
   the `index_references_unknown_field` lint exists to report.
   **Fixed** on `advisor/301-*` → advisor **455/455 on a fresh dist**. The lint was
   KEPT (not retired): `codegen/src/advisor.ts` feeds the advisor from its own
   AST-derived IR without ever executing `defineSchema`, so the lint still catches
   a `schema.ts` typo at build time. Proven root cause: the main checkout's
   `packages/server/dist/` is dated **Jul 31 17:08** and lacks `validateIndexFields`,
   while a fresh build (Aug 1 16:04) contains it.

All three raise the same question, which is worth more than any of them
individually: **why is a red suite not blocking CI?**

## Review protocol (per closing-the-loop.md)

Re-run every done criterion IN the executor's worktree; check `git diff --stat`
against the plan's in-scope list; read the full diff; audit new tests for vacuous
assertions; prove tests fail against base with `git checkout <base> -- <paths>`
(**never `git stash`** — shared repo-wide ref). Never merge, push, or commit to
the user's branch.

---

## Thermos review (post-execution) — 2026-08-01

Five reviewers (2 security, 1 data-plane, 1 client/studio/platform, 1 cross-cutting
quality) over the ~36 branches. It reversed two of my approvals.

### BLOCKED — do not merge

- **265** (`v.bigint()`/`v.bytes()` on the DO row store). Makes bigint **silently
  unqueryable**: the write side stores a tagged array while `serializeSqlValue`
  still renders `"10"`, so `json_extract` never matches — `filter`/`withIndex`/
  `aggregate` return empty on a money path. Also: `estimateBytes` throws on bigint
  and charges the full 32 MiB cap; **with 270 also landed, a bigint insert throws
  `BAD_REQUEST` outright** (the two must land together or not at all); byte-identity
  is false for array-`undefined`, `NaN`, `Infinity` and `Date`; `patch` rewrites
  whole docs so the first patch silently migrates a legacy row; egress doesn't
  re-encode so bytes reach a backup as `{}`. See §11 of that plan.
- **255** (vector read-path scoping). **Fails open on the root shard** — the read
  facade reuses the write side's `ROOT_SHARD_NAME ? undefined` expression, and for
  reads `undefined` means match-everything, so any unsharded query in a mixed app
  returns every tenant's vectors. Also silently breaks `@lunora/ai/rag` (its
  `getByIds`/`deleteByIds` pass a third `namespace` the facade drops): `readHead()`
  re-embeds everything, `hydrateFromStore()` returns no text, `remove()` no-ops.

### Fixes dispatched to the branch-holding executors

254 (`rankPageRows` required-vs-optional TypeError; duplicated mirror types; 1k-line
crossing; rank key left in plaintext) · 255 (above) · 257 (two opposing fail-opens:
unbounded recursion causing a false 422, AND `as const`/`satisfies`/identifier table
values contributing zero masked columns) · 259 (extraction **done**; expired
credential still runs a billable greeting at upgrade) · 261 (**security regression**:
local dev secret promoted to production; non-atomic `.dev.vars` rewrite conflating
environments; layering) · 262 (malformed export failing the Prettier gate; message
divergence a test pattern cannot match).

### Confirmed clean

272 · 291 · 269 (decision-correct) · 292 · 294 · 296 (bar one leftover `headerValue`
copy) · 298 · 301 · the adapters branch · the auth-ui stack (structurally the
strongest; only two test shapes wrong) · the platform TCK rework (`withHost`
replaced 43 bare cleanup calls — a genuine net simplification).

### Corrections to my own briefing

- **`emit.ts` has ZERO NUL bytes.** I told several agents it had one. Only
  `discover-mask-procedures.ts` (1) and the two `reactive-cache` files (2 each) do.
  Also: `scripts/no-nul-bytes.mjs` only scans STAGED files, which is how the one in
  `discover-mask-procedures.ts` has sat on `alpha` unreviewable in `git diff`.
- **36 branches, not 31** — the `worktree-agent-*` refs carry real work (cross-tab,
  adapters, platform TCK, auth-ui, shard-engine batching).
- `.claude/worktrees/agent-a6e7ac079c67ab8e4` (on the 276 branch) holds uncommitted
  edits to `cross-tab.ts` and `catalog-registration.test.ts` — files from two OTHER
  branches. Clear before committing there.

### Tests that pass with the fix reverted (verified individually)

272 (4 of 6) · 254 (rls-guard `:213`/`:224`) · 297 · 275 · 284 · 299 · 261 · 270 · 273. Two worse than vacuous: auth-ui's `sign-up-gate-parity` regex-matches SOURCE
STRINGS (a no-op `const _ = context.signUp` satisfies it), and
`discovery-rebuild.test.tsx:83` **asserts the bug persists** — a tripwire pointed the
wrong way; `it.fails(...)` says the same thing without arming it.

---

## ⚠ Live bug found on `alpha` while executing plan 280 (unrelated to the plan)

`packages/auth/src/audit-hooks.ts` ends `authAuditHook` with:

```ts
// Must return an object: better-auth's after-hook runner reads `.headers`
// / `.response` off the result, so returning `undefined` would throw.
return {};
```

**The comment is false, and the workaround it justifies is a live defect.**
better-auth's `runAfterHooks` treats any **non-undefined** hook return as the
endpoint's NEW response — so `return {}` silently replaced **every hooked auth
endpoint's response body with `{}` on the wire**: sign-up, sign-in, all of it,
for any deployment with the audit hook enabled.

Proven with three isolated probe tests (no hook / `{}` / `undefined`) against a
real better-auth instance. `undefined` does **not** throw, disproving the comment
outright; it leaves the response byte-for-byte equivalent to having no hook at
all. Fixed to `return undefined`, with the probes kept as a permanent regression
suite (`packages/auth/__tests__/audit-hooks.behaviour.test.ts`).

This is the third time this run that a **comment asserting a property the code
does not have** was load-bearing — after the metric-cap rationale citing a closed
attack path, and the "bounded prefix list" comment on an unbounded `storage.list`.
This one is the worst of the three, because the false comment did not merely
mislead a reader: it justified the code that caused the bug.

**It also says something about coverage.** The audit hook shipped to `alpha` with
tests, and none of them asserted what the hooked endpoint actually returned — the
same shape of gap as 265's test declaring `indexes: []`.
