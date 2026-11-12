# Plan 587 — `privileged_dispatch_unvalidated_payload` sees destructured parameters, callback loops and non-inline handlers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/codegen/src/discover/privileged-dispatches.ts packages/codegen/src/discover/context-root.ts packages/codegen/__tests__/discover/privileged-dispatches.test.ts`
> Expect no output.

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** TODO
**Source:** row 49 of the 2026-11-11 audit (advisor lints).

## Status

- **Priority**: P2 · **Effort**: M · **Risk**: MED (widens an ERROR rule) · **Depends on**: none · **Category**: bug (security-lint false negative)

## 0. Headline finding

`privileged_dispatch_unvalidated_payload` (ERROR) only recognises one spelling of a queue or workflow
handler: an inline arrow/function `handler:`, plain-identifier context and batch parameters, and a
`for (const m of batch.messages)` loop. A handler written as a method shorthand or a named function, a
destructured `({ params, run })` / `(ctx, { messages })`, or `batch.messages.forEach((m) => …)` hides a
`run(...)` that forwards the untrusted payload into an RLS-protected function under the system identity.

## 1. Current state (audit)

`packages/codegen/src/discover/privileged-dispatches.ts`:

- `type HandlerFunction = ArrowFunction | FunctionExpression;` (line 22).
- `handlerFunctionOf(call, configIndex)` (~line 39-58): only a `PropertyAssignment` whose initializer is an arrow or function expression.
- `parameterName(handler, index)` (~line 62-66): `undefined` unless the parameter's name node is an `Identifier`; `dispatchesInHandler`
  returns `[]` when the context parameter (index 0) has no plain name; `queuePayloadPrefixes` returns `[]` when the batch parameter (index 1) has none.
- `queuePayloadPrefixes` (~line 149-170): prefixes `<batch>.messages` plus `<m>.body` for each `for (… of <batch>.messages)` with an identifier binding.
- `collectPayload` (~line 185): workflow prefix `<context>.params`; one forward pass of `const` bindings whose initializer is payload-derived.
- `dispatchesInHandler` (~line 230-275): a dispatch is a call whose callee is a property access with a `RUN_METHODS` name and whose
  receiver text is the context parameter or a queue message binding; args = argument 1; target = argument 0 via `resolveTarget`.

`packages/codegen/src/discover/context-root.ts:42-71` — `memberFunctionOf(member)` already resolves a `handler:` member that is an inline
arrow/function, a method shorthand, or a same-file `const`/`function` it names; NOT exported today (export list at the end of the file).

Tests: `packages/codegen/__tests__/discover/privileged-dispatches.test.ts` (`write(name, source)` then `discover()`); copy its shapes.

## 2. Design decisions

- **Handler resolution** via `memberFunctionOf` (export it from `context-root.ts`); widen `HandlerFunction` to its return type
  (`ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration`).
- **Destructured parameters** become name maps rather than a single name:
    - context (index 0): a plain identifier `c` → receivers `{c}` and workflow prefix `c.params`; an object binding pattern → the local
      bound to `params` is a payload NAME (workflow), and each local bound to a `RUN_METHODS` property (e.g. `run`) is a bare dispatch callee.
    - batch (index 1, queue): a plain identifier `b` → prefix `b.messages`; an object binding with `messages` → the local bound to it is the messages expression.
- **Message bindings**: besides `for (… of <messages>)`, the first parameter (plain identifier) of a callback passed to
  `.forEach`/`.map`/`.flatMap`/`.filter`/`.some`/`.every` called on `<messages>` is a message binding (`<m>.body` prefix, `<m>` a dispatch receiver).
- **A bare `run(...)` call** whose callee identifier is one of the destructured run locals counts as a dispatch (args = argument 1, target = argument 0), same as `ctx.run`.
- Text matching stays the feeder's existing policy (`getText()` comparisons); no symbol resolution added here.

## 3. Steps

### Step 1: handler resolution

Export `memberFunctionOf` from `context-root.ts`. In `privileged-dispatches.ts`, `handlerFunctionOf` returns
`memberFunctionOf(findObjectProperty(config, "handler"))`; widen `HandlerFunction`. Existing tests must pass unchanged.
**Verify**: codegen `lint:types` exit 0; test file passes.

### Step 2: destructured parameters, callback loops, bare `run`

Implement §2. Keep functions small; put a one-line why-comment on each new shape.
**Verify**: types exit 0; existing tests pass.

### Step 3: tests (new shapes AND safe neighbours)

Add to `privileged-dispatches.test.ts`, each `it` with `expect.assertions`:

- flagged: `defineWorkflow({ async handler(context) { await context.run(api.docs.create, { ownerId: context.params.ownerId }); } })` (method shorthand)
- flagged: `const onboardHandler = async (context) => context.run(api.docs.create, { ownerId: context.params.ownerId }); export const w = defineWorkflow({ handler: onboardHandler });`
- flagged: `defineWorkflow({ handler: async ({ params, run }) => run(api.docs.create, { ownerId: params.ownerId }) })`
- flagged: `defineQueue({ handler: async (ctx, { messages }) => { for (const m of messages) { await ctx.run(api.docs.create, { ownerId: m.body.ownerId }); } } })`
- flagged: `defineQueue({ handler: async (ctx, batch) => { batch.messages.forEach((m) => ctx.run(api.docs.create, { ownerId: m.body.ownerId })); } })`
- NOT flagged: `defineWorkflow({ handler: async ({ params, run }) => run(api.docs.create, { ownerId: "fixed" }) })`
- NOT flagged: `defineQueue({ handler: async (ctx, batch) => { batch.messages.forEach((m) => ctx.run(api.docs.create, { ownerId: "fixed" })); } })`
  Use the `api.<file>.<export>` targets and `toMatchObject` shapes the existing tests use.
  **Verify**: test file passes. Commit: `fix(codegen): follow more handler shapes for privileged dispatches`.

### Step 4: red without the fix

`git show 79b0c5a6a:packages/codegen/src/discover/privileged-dispatches.ts > packages/codegen/src/discover/privileged-dispatches.ts`
(leave `context-root.ts`), run the test file, confirm the 5 new flagged tests FAIL; `git checkout -- packages/codegen/src`; re-run → pass.

### Step 5: gates

codegen `test`, `lint:eslint`, `lint:types` exit 0. Do not run codegen in `examples/` (the reviewer runs the rollout).

## Commands you will need

| Purpose              | Command (worktree root)                                                   | Expected      |
| -------------------- | ------------------------------------------------------------------------- | ------------- |
| Install              | `pnpm install --frozen-lockfile`                                          | exit 0        |
| Build deps           | `pnpm --filter "@lunora/codegen..." run build`                            | exit 0        |
| Tests / lint / types | `pnpm --filter "@lunora/codegen" run test` / `lint:eslint` / `lint:types` | pass / exit 0 |

## Scope

In scope: `packages/codegen/src/discover/privileged-dispatches.ts`, `packages/codegen/src/discover/context-root.ts` (export only),
`packages/codegen/__tests__/discover/privileged-dispatches.test.ts`.
Out of scope: the lint in `packages/advisor`, RLS feeders, every app.

## Done criteria

- [ ] codegen `test`, `lint:eslint`, `lint:types` exit 0
- [ ] the 5 new flagged tests fail on the baseline feeder; the 2 safe neighbours pass on both

## STOP conditions

- `memberFunctionOf`'s signature differs from the excerpt.
- An existing test changes outcome.
- A verification fails twice.

## 6. Platform parity

Not applicable.

## Maintenance notes

- Rollout: `privileged_dispatch_unvalidated_payload` (ERROR) newly fires on queue/workflow handlers written as
  method shorthands or named functions, with destructured parameters, or iterating messages with array callbacks, when
  they forward payload into an RLS-protected target.
