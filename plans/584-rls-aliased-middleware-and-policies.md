# Plan 584 — RLS is detected through a `const` middleware alias and a `definePolicies([...])` list

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/codegen/src/discover/builder-chain.ts packages/codegen/src/discover/procedure-middleware.ts packages/codegen/src/discover/rls-procedures/index.ts`
> Expect no output (this plan runs first on its branch).

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** TODO
**Source:** row 46 of the 2026-11-11 audit (advisor lints). Same branch as plan 586 (row 48), which lands after it.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED (an ERROR rule and an RLS rule start seeing more) · **Depends on**: none · **Category**: bug (lint false negative and false positive)

## 0. Headline finding

`wrappedCallsWhere` (the shared "does this chain `.use(rls(...))`" reader) only accepts a call
written inline in `.use(...)`. The shape the repo's own apps use —
`const ownRead = rls(ownNotes); … query.use(ownRead)` (`examples/clerk-auth/lunora/notes.ts:37-48`,
`apps/playground/lunora/notes.ts:28-37`) — reads `usesRls: false`. And `extractPolicyTables` only
reads `rls([{ table: "x" }, …])`, so the documented `rls(definePolicies([definePolicy({ table: "x", … })]))`
yields no tables. Effects: `rls_uncovered_table` never fires for documented policies;
`privileged_dispatch_unvalidated_payload` (ERROR) misses aliased targets;
`normalize_id_used_as_authorization` flags procedures RLS-protected through an alias.

## 1. Current state (audit)

- `packages/codegen/src/discover/builder-chain.ts:65-69`:

```ts
const wrappedCallsWhere = (receiver: Node, method: string, matches: (callee: Node) => boolean): CallExpression[] =>
    builderChainSteps(receiver)
        .filter((step) => step.name === method)
        .map((step) => step.call.getArguments()[0])
        .filter((argument): argument is CallExpression => argument !== undefined && TsNode.isCallExpression(argument) && matches(argument.getExpression()));
```

Used by `wrappedCallsInChain` → `rlsCallsInChain` (`rls-procedures/internal/chain.ts:23`),
`maskCallsInChain`, `chainUsesWrappedCall` (`normalize-id-authorization.ts:254`, `raw-row-returns.ts:180`),
`storage-rules.ts:30`, and `usesPlatformAdmin` in `functions/classify-procedure-call.ts:137`.

- `packages/codegen/src/discover/procedure-middleware.ts:152-165` already resolves a same-file alias for its own walk:

```ts
const resolveUseArgumentCall = (argument: TsNode): CallExpression | undefined => {
    if (Node.isCallExpression(argument)) {
        return argument;
    }
    if (!Node.isIdentifier(argument)) {
        return undefined;
    }
    const declaration = argument.getSourceFile().getVariableDeclaration(argument.getText());
    const initializer = declaration?.getInitializer();
    return initializer && Node.isCallExpression(initializer) ? initializer : undefined;
};
```

- `packages/codegen/src/discover/rls-procedures/index.ts:19-48` — `extractPolicyTables(rlsCall)` returns
  `[]` unless argument 0 is an array literal of object literals with a string `table`.
- Documented policy form (`apps/docs/src/content/docs/concepts/rls.mdx:25`, and both apps above):
  `const policies = definePolicies([definePolicy({ on: "read", table: "notes", when: … }), …]); const r = rls(policies);`

## 2. Existing seams

- `resolveUseArgumentCall` (move it, do not duplicate it).
- `findObjectProperty`, `unwrapExpression` from `../ast`; `resolvesToImportedName` from `./callee` (already used in builder-chain.ts).
- Tests: `packages/codegen/__tests__/discover/rls-internal-chain.test.ts`, `rls-metadata.test.ts`,
  `procedure-middleware.test.ts`, `normalize-id-authorization` tests (find with `ls packages/codegen/__tests__/discover | grep normalize`).

## 3. Contract to preserve

All existing tests in those files pass unchanged; `extractPolicyTables` keeps returning tables for the inline array-literal form.

## 4. Design decisions

- **Move `resolveUseArgumentCall` into `builder-chain.ts`** (export it) and use it in both
  `wrappedCallsWhere` and `procedure-middleware.ts`, so every chain reader agrees on aliases.
  Same-file `const` only, one hop, as today — an imported middleware alias stays out of scope.
- **Policy tables:** unwrap the `rls(...)` argument, follow one same-file `const` hop, unwrap a
  `definePolicies(<x>)` call to `<x>`, then for each array element accept an object literal, a
  `definePolicy(<object literal>)` call, or an identifier bound by a same-file `const` to either.
  The callee names are matched with `resolvesToImportedName(callee, "definePolicies"|"definePolicy")`.

## 5. Steps

### Step 1: one alias resolver for every chain reader

- Move `resolveUseArgumentCall` from `procedure-middleware.ts` to `builder-chain.ts` (named export, keep its JSDoc);
  import it in `procedure-middleware.ts`.
- In `wrappedCallsWhere`, map each step's first argument through `resolveUseArgumentCall` before the `matches` filter.
- Update `wrappedCallsWhere`'s JSDoc: "a `.use(alias)` whose same-file `const` alias is the call counts".

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0; `pnpm --filter "@lunora/codegen" exec vitest run __tests__/discover/rls-internal-chain.test.ts __tests__/discover/procedure-middleware.test.ts` → all existing pass.

Tests in `rls-internal-chain.test.ts` (mirror its existing cases):

- `const r = rls(p); export const q = query.use(r).query(h)` → one rls call found (new).
- `const notRls = other(p); export const q = query.use(notRls).query(h)` → none (safe neighbour).
- `let r = rls(p); r = other(p); …use(r)` → do NOT add a test asserting either way; `getVariableDeclaration` reads the initializer only. (Leave as is.)

Commit: `fix(codegen): resolve a const-aliased .use() middleware in every chain reader`.

### Step 2: tables from `definePolicies([...])`

Rewrite `extractPolicyTables` per §4 (keep the inline-array path). Helper functions stay in
`rls-procedures/index.ts`. Tests in `rls-metadata.test.ts` (mirror its existing table-extraction case):

- `rls(definePolicies([definePolicy({ on: "read", table: "notes", when: () => true })]))` inline → `["notes"]`.
- `const policies = definePolicies([definePolicy({ on: "read", table: "notes", when: () => true }), definePolicy({ on: "insert", table: "posts", when: () => true })]); const r = rls(policies); …use(r)` → `["notes", "posts"]`.
- `const one = definePolicy({ on: "read", table: "notes", when: () => true }); rls(definePolicies([one]))` → `["notes"]`.
- safe neighbour: `rls(loadPolicies())` → `[]` and `usesRls: true`.
  Use the import line the existing tests use for `rls` (add `definePolicies, definePolicy` to it).

**Verify**: test file passes. Commit: `fix(codegen): read policy tables from definePolicies and definePolicy`.

### Step 3: red without the fix

`git show 79b0c5a6a:<path> > <path>` for `builder-chain.ts`, `procedure-middleware.ts` and
`rls-procedures/index.ts`; run the two test files; confirm every new positive test FAILS; then
`git checkout -- packages/codegen/src` and re-run → pass. Report the failing names.

### Step 4: gates

codegen `test`, `lint:eslint`, `lint:types` → exit 0. If a test in another file starts failing
(e.g. a normalize-id or privileged-dispatch fixture whose expectations assumed `usesRls: false`), STOP and report it — do not edit it.

## Scope

In scope: `packages/codegen/src/discover/builder-chain.ts`, `…/procedure-middleware.ts` (the moved function and its import only),
`…/rls-procedures/index.ts`, `packages/codegen/__tests__/discover/rls-internal-chain.test.ts`, `…/rls-metadata.test.ts`.
Out of scope: every lint in `packages/advisor`, every app, `classify-procedure-call.ts` (plan 586).

## Done criteria

- [ ] codegen `test`, `lint:eslint`, `lint:types` exit 0
- [ ] new positive tests fail against the baseline sources
- [ ] `grep -n "const resolveUseArgumentCall" packages/codegen/src/discover/procedure-middleware.ts` → no match (moved)

## STOP conditions

- Excerpts do not match.
- A test outside the in-scope test files changes outcome.
- A verification fails twice.

## 6. Platform parity

Not applicable.

## Maintenance notes

- Rollout: procedures using an aliased `rls()` now read `usesRls: true`, so `normalize_id_used_as_authorization`
  stops flagging them, `privileged_dispatch_unvalidated_payload` (ERROR) sees aliased RLS targets, and
  `rls_uncovered_table` starts comparing those procedures' table accesses with the policy tables.
  The reviewer's sweep of in-repo apps lists every change.
