# Plan 446: Stop `parseObjectShape` silently dropping computed property keys

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/codegen/src/parse-validator.ts packages/codegen/src/compile-validator.ts packages/codegen/src/emit.ts packages/values/src/validator-map.ts`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.
>
> **Layout note (2026-08-28)**: the feeders moved to `packages/codegen/src/discover/`
> with the `discover-` prefix stripped, and the two largest were split into directories
> (`discover/functions/`, `discover/schema/`). The blast-radius table below is updated;
> locate call sites by symbol rather than by line number.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1699f4317`, 2026-08-21

## Why this matters

`parseObjectShape` is the single AST→IR reader for every object literal codegen
consumes: a function's `.input()` args, a table shape in `defineSchema`, an HTTP
route's `searchParams`/`body`/`params`, and a mutator's args. It **skips**
computed property keys (`{ ["name"]: v.string() }`) with no diagnostic. The field
simply vanishes from the IR.

For **args**, that vanishing field is a soundness violation of the contract
stated in `packages/values/src/validator-map.ts:20-28`:

> The contract is soundness, not completeness: a compiled parser may return
> `DEFER_VALIDATION` for any input it is not certain about … but it must **NEVER**
> return a built record for input the interpreted parser would reject, and the
> record it returns must be byte-for-byte what the interpreted parser would have
> produced.

The compiled validator is installed onto the **live** `.args` object at generated-module
load (`emit.ts:1617`, `installCompiledValidatorMap`) — and at _runtime_ the computed
key has resolved normally, so the live map DOES carry the field. Codegen's IR does
not. The two disagree, and the fast path wins.

For **table shapes** the same skip silently drops a column from `Doc_*` and from the
emitted schema — the identical failure mode the comment immediately above the skip
(`parse-validator.ts:217-225`) describes for shorthand properties, which was fixed
because "the column vanished from `Doc_*`, and an index over it only surfaced as a
confusing `index_references_unknown_field` advisory".

This is **pre-existing** — not introduced by wave 22. It was found while reviewing
the wave-22 compiled-validator work (plans 388/389, PR #437).

## Current state

`packages/codegen/src/parse-validator.ts:214-254` — `parseObjectShape`, with the
skip at **232-238**:

```ts
const parseObjectShape = (object: ObjectLiteralExpression): Record<string, ValidatorIR> => {
    const out: Record<string, ValidatorIR> = {};

    for (const property of object.getProperties()) {
        // …shorthand handling…
        const shorthand = Node.isShorthandPropertyAssignment(property);

        if (!shorthand && !Node.isPropertyAssignment(property)) {
            continue;
        }

        // Skip computed property names (`[expr]: ...`) — we can't derive a stable
        // identifier from them and they can't be emitted safely.
        const nameNode = property.getNameNode();

        if (Node.isComputedPropertyName(nameNode)) {
            continue;
        }
        // …
        const fieldName = property.getName();

        if (!FIELD_NAME_RE.test(fieldName)) {
            throw new LunoraError("INTERNAL", `@lunora/codegen: field name is not a valid JS identifier: ${JSON.stringify(fieldName)}`);
        }

        out[fieldName] = parseValidator(initializer);
    }

    return out;
};
```

`FIELD_NAME_RE` is `parse-validator.ts:31`: `/^[A-Za-z_$][\w$]*$/u`.

### Why the skip exists (and why it is the wrong shape)

ts-morph's `PropertyAssignment.getName()` returns the _bracketed source text_ for a
computed name, so without the skip the `FIELD_NAME_RE` guard would abort the whole
codegen run with a spurious `INTERNAL` error. Verified probe (ts-morph, in-repo copy):

| Source          | `getName()`  | `isComputedPropertyName` | Inner expression kind           |
| --------------- | ------------ | ------------------------ | ------------------------------- |
| `id: 1`         | `id`         | false                    | —                               |
| `["name"]: 2`   | `["name"]`   | true                     | `StringLiteral` → `"name"`      |
| `` [`tpl`]: 3`` | `` [`tpl`]`` | true                     | `NoSubstitutionTemplateLiteral` |
| `[KEY]: 4`      | `[KEY]`      | true                     | `Identifier` (unresolvable)     |

So the first two rows are **statically resolvable** to a real key. The skip throws
them away along with the genuinely unresolvable third.

### The divergence, precisely

`emit.ts:1601-1616` skips the install when the parsed IR is empty:

```ts
if (definition.lifecycle || Object.keys(definition.args).length === 0) {
    return undefined;
}

const compiled = compileArgsValidator(definition.args);
```

**Evidence correction vs. the original finding.** The originally-reported probe
(`fast keys=[] vs oracle THREW: args.__proto__: Expected string`) was run through
the _test harness_ (`__tests__/snippet-helpers.ts`, which calls `compileArgsValidator`
directly and bypasses that `length === 0` guard). Through the real emitter, an args
map whose keys are **all** computed produces an empty IR and therefore **no install**
at all — that case is inert. The reachable production case is the **mixed** one:

```ts
args: { id: v.string(), ["name"]: v.string() }
```

- IR = `{ id }` → non-empty → a compiled parser IS emitted and installed.
- Input `{ id: "x", name: "y" }` → fast path commits `{ id: "x" }`; the oracle
  returns `{ id: "x", name: "y" }`. The handler receives `args.name === undefined`
  — a **silently dropped field**, not a type error.
- Input `{ id: "x" }` (no `name`) → fast path commits `{ id: "x" }`; the oracle
  **throws** `args.name: Expected string`. The compiled path **accepts input the
  oracle rejects** — the exact prohibition in the contract.

Both violations are reachable with _any_ computed key, string-literal or otherwise;
`__proto__` is not special here.

The install site, `packages/codegen/src/emit.ts:1594-1598`:

```
// emit a specialised fast-path parser and install it onto the function's live
// `.args` object — the same reference the procedure builder validates against,
// so dispatch transparently uses it
```

### Blast radius (every `parseObjectShape` caller)

| Call site                                                                   | What a dropped key costs                                  |
| --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `discover/functions/internal/expose.ts:128`, `internal/builder-chain.ts:68` | args field missing from IR → the soundness break above    |
| `discover/schema/internal/table-builder.ts:749`                             | table column vanishes from `Doc_*` and the emitted schema |
| `discover/http-routes.ts:51`                                                | route `searchParams`/`body`/`params` field unvalidated    |
| `discover/mutators.ts:123`                                                  | mutator arg vanishes                                      |
| `discover/shapes.ts:138`                                                    | shape field vanishes                                      |
| `parse-validator.ts:352` (`v.object(...)`)                                  | nested object field vanishes at any depth                 |

## Existing seams (do not reinvent)

- **`renderLiteralSource`** (`parse-validator.ts`, just below `parseObjectShape`)
  already implements exactly the literal-resolution this fix needs:
    ```ts
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        return JSON.stringify(node.getLiteralValue());
    }
    ```
    Use the same two-kind test; do not build a general constant evaluator.
- **`FIELD_NAME_RE` + the `INTERNAL` throw** already exist for "this key cannot be
  emitted". A resolved computed key flows through them unchanged.
- **`LunoraError("INTERNAL", …)`** is the established failure shape in this file.
- **The differential corpus** in `packages/codegen/__tests__/compile-validator.test.ts`
  is the safety net that would have caught this; extend it rather than writing a
  bespoke harness.

## The behavioural contract to preserve

1. The soundness contract in `packages/values/src/validator-map.ts:20-28` — the
   compiled parser may DEFER freely, but must never commit a record the interpreted
   oracle would reject, and its record must equal the oracle's.
2. Existing golden fixtures under `packages/codegen/__tests__/fixtures/` must stay
   byte-identical: no real-world schema in the repo uses computed keys, so a correct
   fix changes no emitted output. A fixture diff means the change reached further
   than intended.
3. Codegen must never abort with a spurious `INTERNAL` on a shape TypeScript accepts.

## Design decisions

**D1 — Resolve statically-known computed keys; fail loud on the rest.**
Chosen over "always fail loud on any computed key" (would break `{ ["name"]: … }`,
which is legal TypeScript with an unambiguous key, and is what `object-shorthand`-style
autofixers and generated code can emit) and over "keep skipping but warn" (a warning in
a codegen run is scrollback; the field is still silently missing at runtime).

**D2 — The unresolvable case is a codegen-time `INTERNAL` error, not a diagnostic.**
Chosen over an advisor-style diagnostic: `parseObjectShape` has no diagnostic channel
(its callers take a plain `Record<string, ValidatorIR>`), and adding one for a
vanishingly rare shape is a mechanism built for a single caller. The existing
`FIELD_NAME_RE` throw already sets the precedent that an unemittable key aborts the run
with an actionable message.

**D3 — Do not touch `compile-validator.ts`.** The compiler is correct given its input;
the bug is upstream in the IR. Guarding the compiler instead would leave the table-shape
and HTTP-route call sites still broken. (Root cause, one place, all six call sites.)

## Commands you will need

| Purpose      | Command                                           | Expected on success |
| ------------ | ------------------------------------------------- | ------------------- |
| Install      | `pnpm install`                                    | exit 0              |
| Build deps   | `pnpm --filter "@lunora/codegen..." run build`    | exit 0              |
| Tests        | `pnpm --filter "@lunora/codegen" run test`        | all pass            |
| Typecheck    | `pnpm --filter "@lunora/codegen" run lint:types`  | exit 0              |
| Lint         | `pnpm --filter "@lunora/codegen" run lint:eslint` | exit 0              |
| API snapshot | `pnpm run api:check`                              | exit 0, no diff     |

## Scope

**In scope** (the only files you should modify):

- `packages/codegen/src/parse-validator.ts`
- `packages/codegen/__tests__/compile-validator.test.ts`
- one new or extended test asserting the table-shape / unresolvable-key behaviour
  (put it in `packages/codegen/__tests__/discover/schema.test.ts` if a table case fits
  there; otherwise extend `compile-validator.test.ts`)

**Out of scope**:

- `packages/codegen/src/compile-validator.ts` — see D3.
- `packages/codegen/src/emit.ts` — the `length === 0` install guard is correct as-is.
- `packages/values/src/validator-map.ts` — the contract text is right; the code violated it.
- Golden fixtures under `packages/codegen/__tests__/fixtures/` — must not change.

## Git workflow

- Branch: `improve/followup-codegen-computed-keys`
- Commit: `fix(codegen): resolve computed keys in object shapes` (48 chars)
- Commit body must state that an unresolvable computed key now aborts codegen, since
  that is a behaviour change on a pre-release branch.

## Steps

### Step 1: Reproduce the divergence first

Add a failing case to the differential suite in
`packages/codegen/__tests__/compile-validator.test.ts` — add to the `SNIPPETS` array
in the `describe("compileArgsValidator — differential parity vs interpreted oracle")`
block:

```ts
'{ id: v.string(), ["name"]: v.string() }',
```

The shared `assertParity` helper already walks the `CORPUS` (which contains
`{ name: "ada" }`, `{}`, `{ name: 123 }`, …), compiles the IR, and asserts the oracle
agrees. Note `liveFromSnippet` evaluates the snippet with `new Function`, so the live
map correctly carries `name`.

**Verify**: `pnpm --filter "@lunora/codegen" run test -- compile-validator` → the new
case FAILS with `compiled accepted input the oracle rejected` (or an output-diverged
assertion). If it passes, STOP — the premise is wrong.

### Step 2: Resolve statically-known computed keys in `parseObjectShape`

In `packages/codegen/src/parse-validator.ts`, replace the skip at lines 232-238 with a
resolution step. Derive the field name from the computed name's inner expression when
it is a `StringLiteral` or `NoSubstitutionTemplateLiteral` (mirror `renderLiteralSource`
below in the same file), and throw `LunoraError("INTERNAL", …)` otherwise. Feed the
resolved name through the existing `FIELD_NAME_RE` check so a resolved-but-unemittable
key (`["my-key"]`) still fails the same way a literal `"my-key"` would.

Replace the stale "we can't derive a stable identifier from them" comment with one
that says what is now true: literal computed names resolve; a non-literal one aborts
the run because a silently-dropped field breaks the compiled-validator soundness
contract (cite `validator-map.ts`).

The error message must name the offending source text and the file, e.g.:
`@lunora/codegen: computed property name [KEY] cannot be resolved at codegen time — use a literal key. A dropped field would silently bypass argument validation.`

**Verify**:

- `pnpm --filter "@lunora/codegen" run test -- compile-validator` → the Step 1 case passes.
- `grep -n "isComputedPropertyName" packages/codegen/src/parse-validator.ts` → still one
  match (the resolution branch), not zero.

### Step 3: Cover the unresolvable case and the table-shape case

Add two tests:

1. **Unresolvable key aborts.** A snippet like `{ id: v.string(), [KEY]: v.string() }`
   parsed through `irFromSnippet` (from `__tests__/snippet-helpers.ts`) throws a
   `LunoraError` whose message names `[KEY]`. Model it on the existing
   `it("declines to compile unions (returns undefined source)")` block.
2. **Resolvable key survives into a table shape.** A `defineTable` with a
   `["email"]: v.string()` column yields an IR carrying `email`. Model on the existing
   cases in `packages/codegen/__tests__/discover/schema.test.ts`.

**Verify**: `pnpm --filter "@lunora/codegen" run test` → all pass, including the 3 new cases.

### Step 4: Prove nothing else moved

**Verify**:

- `pnpm --filter "@lunora/codegen" run test` → exit 0.
- `git status --porcelain packages/codegen/__tests__/fixtures/` → **empty**. Any fixture
  diff is a STOP condition.
- `pnpm run api:check` → exit 0 (the IR types are unchanged, so this should be clean; if
  it is not, the change reached further than intended).

## Test plan

- **Exemplar file**: `packages/codegen/__tests__/compile-validator.test.ts`. Its
  `assertParity` helper is the differential harness — it compiles the IR, evaluates the
  same snippet to live `v.*` validators, and asserts over the shared `CORPUS` that a
  committed fast-path record is one the oracle would also produce. Adding a snippet to
  `SNIPPETS` is the whole test; do not hand-roll a parallel harness.
- 1 differential snippet (mixed literal + computed key).
- 1 unit test: unresolvable computed key throws.
- 1 unit test: resolvable computed key survives into a table shape.
- Existing golden fixtures unchanged.

## Platform parity

Not applicable — this touches no `ctx.*` surface, no provider binding, and no
deploy/runtime capability. It is a codegen-internal AST reader.

## Done criteria

- [ ] `pnpm --filter "@lunora/codegen" run test` exits 0 with the 3 new cases
- [ ] `pnpm --filter "@lunora/codegen" run lint:types` exits 0
- [ ] `pnpm --filter "@lunora/codegen" run lint:eslint` exits 0
- [ ] `pnpm run api:check` exits 0
- [ ] `git status --porcelain packages/codegen/__tests__/fixtures/` is empty
- [ ] `git status --porcelain` shows no file outside the in-scope list
- [ ] Reverting only the `parse-validator.ts` hunk makes the new differential case fail
      (proves the test is load-bearing)

## STOP conditions

- **STOP** if the Step 1 differential case **passes** before the fix — the premise
  ("the compiled path accepts what the oracle rejects") is then wrong and this plan
  should be re-derived, not patched around.
- **STOP** if any golden fixture under `packages/codegen/__tests__/fixtures/` changes.
  No fixture uses a computed key; a diff means the edit changed a path it should not have.
- **STOP** if making the unresolvable case throw breaks an existing test — that would
  mean some in-repo source relies on a computed key being dropped, which is a different
  and larger problem.
- **STOP** if the fix appears to require touching `compile-validator.ts` or `emit.ts`.

## Maintenance notes

- The resolution branch handles `StringLiteral` and `NoSubstitutionTemplateLiteral`
  only, matching `renderLiteralSource` in the same file. If a third literal form ever
  needs support, change both together — they are two readers of the same idea.
- Reviewer: check the new error message names the offending source text. An
  `INTERNAL` error with no location is worse than the silent drop it replaces.
- The general lesson: the differential corpus in `compile-validator.test.ts` only
  covers snippets someone thought to add. A new _syntactic_ shape (shorthand, computed,
  spread) reaching `parseObjectShape` needs a corpus entry, not just a unit test —
  spread properties (`{ ...base, id: v.string() }`) are the next untested shape.
