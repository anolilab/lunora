# Plan 583 — The shared `args` taint follows a body-level destructure and locals composed into an expression

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/codegen/src/argument-taint.ts packages/codegen/__tests__/argument-taint.test.ts`
> Expect no output; otherwise compare the excerpts with the live code and STOP on a mismatch.

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** DONE — APPROVED; PR https://github.com/anolilab/lunora/pull/1569 (branch `fix/improve-583-argument-taint`, commit `f34e12180`). New in-repo finding: apps/bench insights/index.ts:31 kv_unscoped_user_key_idor INFO (internal mutation, true positive at the intended level, no change).
**Source:** row 45 of the 2026-11-11 audit (advisor lints). Shipped on one branch with plans 588 (row 50) and 590 (row 52), which build on it.

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED (widens ~10 rules, several ERROR) · **Depends on**: none · **Category**: bug (security-lint false negative)

## 0. Headline finding

`isArgumentDerived` — the taint predicate behind ten security rules — misses two of the
commonest ways handler code reads `args`: a body-level destructure (`const { url } = args; fetch(url)`)
and a local composed into a larger expression (`const host = args.host; fetch(\`https://${host}/x\`)`).
Silent today on those shapes: `action_fetch_ssrf`, `kv_unscoped_user_key_idor`,
`storage_key_from_user_args`, `container_instance_key_from_user_input`,
`browser_user_url_without_allowlist`, `mail_recipient_from_request_input`,
`images_url_source_from_user_input`, `ai_raw_run_escape_hatch`,
`soft_delete_include_deleted_from_args`, `owner_field_from_args_not_auth`.

## 1. Current state (audit)

`packages/codegen/src/argument-taint.ts`:

- `singleHopInitializer` (~line 196): returns `undefined` unless the node is a bare `Identifier`;
  then scans `descendantsOfKind(enclosingFunction, SyntaxKind.VariableDeclaration)` and keeps
  the nearest preceding declaration with `variable.getName() !== name` → `continue`. For
  `const { url } = args` the declaration's `getName()` is the pattern text `{ url }`, so it never matches.
- `isArgumentDerived` (~line 243):

```ts
export const isArgumentDerived = (expression: TsNode): boolean => {
    if (referencesArgs(expression)) {
        return true;
    }

    const initializer = singleHopInitializer(expression);

    return initializer !== undefined && referencesArgs(initializer);
};
```

- So for a template/member/call expression built from a local, no hop happens at all.
- The comment at ~207-213 explains the hop is spelling-based on purpose: over-resolving only makes
  the TAINT side report more (fails open). Keep that policy.
- `packages/codegen/__tests__/argument-taint.test.ts` — `describe("isArgumentDerived")` has
  "is direct-or-single-hop: one hop counts, two do not" (`const first = args.key; const second = first; SINK(second)` → `false`).
  That boundary MUST still hold. Fixtures use `sinkArgument(body, parameters = "{ ctx, args }")`.

## 2. Existing seams

- `referencesArgs`, `singleHopInitializer`, `descendantsOfKind` (already in the file / imports).
- The request-rooted twin `isRequestInputDerived` (same file, after `isScopedByContext`) already hops
  through a member-access root; the new behaviour generalises that idea to every identifier.

## 3. Behavioural contract to preserve

- All existing tests in `argument-taint.test.ts` pass unchanged, including the two-hop boundary.
- `singleHopInitializer`'s existing behaviour for a plain `const key = …` is unchanged.

## 4. Design decisions

- **Binding elements count as a hop.** For a body-level `const { url } = args` (any depth of object
  or array binding pattern, renames included), the hop returns the destructured declaration's
  initializer (`args`). Chosen over resolving the exact property: taint is fail-open, so tainting
  every name bound from `args` is the safe direction.
- **One hop per identifier, not more.** For a non-identifier expression, each value identifier
  inside it (not a property name: skip an identifier that is the name node of a property access or
  a property assignment) is followed one hop. The hop is never applied to an initializer again, so
  two chained `const`s still do not count.

## 5. Steps

### Step 1: binding elements in `singleHopInitializer`

Keep the loop, but replace the name test: a declaration matches when either
`Node.isIdentifier(variable.getNameNode()) && variable.getName() === name`, or the name node is an
`ObjectBindingPattern`/`ArrayBindingPattern` that contains (at any depth) a `BindingElement` whose
`getNameNode()` is an `Identifier` with text `name` (use `variable.getNameNode().getDescendantsOfKind(SyntaxKind.BindingElement)`).
Everything else (nearest preceding, initializer present) stays the same. Update the function's JSDoc in one sentence.

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0.

### Step 2: per-identifier hop in `isArgumentDerived`

After the existing two checks, when `expression` is NOT an identifier, return true if any value
identifier inside it has a `singleHopInitializer` that `referencesArgs`. Write it as a small
helper `valueIdentifiersIn(node)` (the identifiers that are not the name of a property access or
property assignment), used only here. Update the JSDoc ("directly, through one local hop on the
expression, or through one hop on any local composed into it").

**Verify**: types exit 0; `pnpm --filter "@lunora/codegen" exec vitest run __tests__/argument-taint.test.ts` → all existing pass.

### Step 3: tests (new shapes AND nearby safe shapes)

Add to `describe("isArgumentDerived")` in `argument-taint.test.ts`, each `it` with `expect.assertions`:

- true: `const { url } = args;\nSINK(url);`
- true: `const { target: url } = args;\nSINK(url);` (renamed)
- true: `const { page: { id } } = args;\nSINK(id);` (nested)
- true: `const host = args.host;\nSINK(\`https://${host}/x\`);`
- true: `const body = args.payload;\nSINK(body.url);`
- false: `const { userId } = ctx.auth;\nSINK(\`users/${userId}\`);`
- false: `const host = "example.com";\nSINK(\`https://${host}/x\`);`
- false (boundary kept): `const first = args.key;\nconst second = first;\nSINK(\`k/${second}\`);`
- false: `const { url } = config;\nSINK(url);` where `config` is not args

Also add one feeder-level test so the widening is proven end to end: in
`packages/codegen/__tests__/discover/kv-key-accesses.test.ts`, mirror an existing "flags" test with a handler
body `const { key } = args; await ctx.kv.get(key);` → one row, and a neighbour
`const { key } = args; await ctx.kv.get(\`${ctx.auth.userId}/${key}\`);` → no row.

**Verify**: both test files pass.

### Step 4: red without the fix

Commit Steps 1–3 (`fix(codegen): follow body destructures and composed locals in the args taint`).
Then `git show 79b0c5a6a:packages/codegen/src/argument-taint.ts > packages/codegen/src/argument-taint.ts`,
run both test files, confirm the 5 new `true` cases and the new kv "flags" test FAIL; restore with
`git checkout -- packages/codegen/src/argument-taint.ts` and re-run → all pass.

### Step 5: whole-package gates

`pnpm --filter "@lunora/codegen" run test`, `lint:eslint`, `lint:types` → exit 0. If a test
ELSEWHERE in codegen now fails because a fixture that used to be clean is now flagged, STOP and
report the test name and fixture — do not edit that test.

## Commands you will need

| Purpose              | Command (worktree root)                                                   | Expected      |
| -------------------- | ------------------------------------------------------------------------- | ------------- |
| Install              | `pnpm install --frozen-lockfile`                                          | exit 0        |
| Build deps           | `pnpm --filter "@lunora/codegen..." run build`                            | exit 0        |
| Tests / lint / types | `pnpm --filter "@lunora/codegen" run test` / `lint:eslint` / `lint:types` | pass / exit 0 |
| Format               | `pnpm exec oxfmt --check <changed .ts files>`                             | exit 0        |

## Scope

In scope: `packages/codegen/src/argument-taint.ts`, `packages/codegen/__tests__/argument-taint.test.ts`,
`packages/codegen/__tests__/discover/kv-key-accesses.test.ts`.
Out of scope: every `discover/*` feeder, every lint, every app under `examples/`, `templates/`, `apps/`.

## Done criteria

- [ ] codegen `test`, `lint:eslint`, `lint:types` exit 0
- [ ] the new `true` cases and the kv "flags" test fail against the baseline `argument-taint.ts`
- [ ] the two-hop boundary test is unchanged and passes

## STOP conditions

- Excerpts do not match.
- An existing codegen test outside the in-scope test files fails (report; do not edit it).
- A verification fails twice after a reasonable fix.

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

First commit on the shared branch; plans 588 and 590 follow on top.

## Maintenance notes

- Rollout: the ten rules listed in §0 newly fire on values bound by a body-level destructure of
  `args` or on templates/member accesses built from an `args`-derived local. The reviewer's sweep of
  in-repo apps lists every new finding in the PR.
- A future multi-hop dataflow would replace this; until then the boundary is one hop per identifier.
