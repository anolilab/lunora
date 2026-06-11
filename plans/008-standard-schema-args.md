# Plan 008: Accept Standard Schema validators in query/mutation/action args (PLAN5 §6.1)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2f6a466f..HEAD -- packages/values/src packages/server/src/functions.ts packages/server/src/builder packages/codegen/src`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: direction / dx
- **Planned at**: commit `2f6a466f`, 2026-06-11

## Why this matters

PLAN5 §6.1 promises: "let `query`/`mutation`/`action` args accept any
Standard Schema validator (zod/valibot/arktype) via
`schema["~standard"].validate`". Half of the bridge already shipped: every
Cirrus validator **exports** the Standard Schema v1 surface
(`packages/values/src/v.ts:278`), so Cirrus validators work inside other
tools. The other direction is missing: a user who already has a zod schema
for a field must hand-translate it into `v.*`. This plan adds the inbound
adapter — `v.from(standardSchema)` — so any spec-compliant validator drops
into an args map, with codegen emitting a safe type for it.

## Current state

- `packages/values/src/v.ts` — the validator factory. `createValidator`
  (~line 262) builds the internal validator object; note the existing
  outbound Standard Schema block at line ~278:

```ts
"~standard": {
    validate(value: unknown): StandardSchemaV1.Result<T> {
        const result = validator.safeParse(value);
        if (result.ok) return { value: result.value };
        return { issues: [{ message: result.error.message, path: result.error.path }] };
    },
    vendor: "cirrus",
    version: 1,
} satisfies StandardSchemaV1.Props<T, T>,
```

  So a `StandardSchemaV1` type import already exists in this package — reuse
  it. Validators are wrapped by `asColumn(...)` and expose
  `_parse(value, context)`, `parse`, `safeParse`, `kind`, `_meta`.

- `packages/server/src/functions.ts:68` — the single runtime enforcement
  point for args:

```ts
const validateArgs = <A extends ArgsValidator>(validators: A, args: Record<string, unknown>): InferArgs<A> =>
```

  Called from `functions.ts:94` and from the builder at
  `packages/server/src/builder/index.ts:53` and `:76`. Read `validateArgs`'s
  body and the `ArgsValidator` type before coding — args are a **map of
  field-name → Cirrus validator** (`{ text: v.string(), ... }`).

- `packages/codegen/src/discover-schema.ts` and `discover-functions.ts` —
  codegen statically parses `v.*` call chains in user files to build a
  validator IR (`ValidatorIR`) for emitted types. It has a finite vocabulary
  of `v.<kind>` calls; an unknown call must not crash discovery.

- The Standard Schema v1 spec (https://standardschema.dev) is tiny: an object
  with `"~standard": { version: 1, vendor: string, validate(value) =>
  { value } | { issues } | Promise<...> }`. **Do not add zod/valibot as
  dependencies** — test with a hand-rolled minimal spec-compliant fixture.

Repo conventions: ESM, no `.js` on relative imports, named exports only when
a file has >1 export, catalog versions for any dep (you should need none).

## Commands you will need

| Purpose          | Command                                                | Expected on success |
| ---------------- | ------------------------------------------------------ | ------------------- |
| Install          | `pnpm install`                                          | exit 0              |
| values tests     | `pnpm --filter "@cirrus/values" run test`               | all pass            |
| server tests     | `pnpm --filter "@cirrus/server" run test`               | all pass            |
| codegen tests    | `pnpm --filter "@cirrus/codegen" run test`              | all pass            |
| Typecheck        | `pnpm --filter "@cirrus/values" run lint:types && pnpm --filter "@cirrus/server" run lint:types && pnpm --filter "@cirrus/codegen" run lint:types` | exit 0 |

## Scope

**In scope**:
- `packages/values/src/v.ts` (or a new sibling `from-standard-schema.ts`) +
  `packages/values/src/index.ts` re-export + `packages/values/__tests__/`
- `packages/server/src/functions.ts` ONLY if `validateArgs` needs a tweak
  (it should not if the adapter returns a real Cirrus validator)
- `packages/codegen/src/discover-schema.ts` / `discover-functions.ts` — only
  the minimal branch to map a `v.from(...)` call to an `unknown`-typed IR
- `packages/codegen/__tests__/` — one fixture exercising `v.from`
- Docs: the `@cirrus/values` README section listing validators

**Out of scope**:
- Table/schema columns: `v.from` is for **function args only** in this plan.
  `defineTable` columns need column metadata (`_meta.column`, SQL types) that
  a foreign schema cannot provide — reject it there (see step 2).
- Async validation: Standard Schema permits `validate` to return a Promise.
  Cirrus arg validation is synchronous. Throw a clear error on a Promise
  result (see step 1); do NOT plumb async through `validateArgs`.
- Adding zod/valibot/arktype anywhere, even as devDependencies.
- Client-side type inference niceties beyond what `Infer` gives for free.

## Git workflow

- Branch: `feat/values-standard-schema-args` off `alpha`.
- Conventional commits, e.g. `feat(values): v.from() adapter for standard schema validators`,
  `feat(codegen): discover v.from args as unknown`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Implement `v.from(schema)` in `@cirrus/values`

Add a `from` builder (export it on the `v` namespace object exactly the way
the other builders like `record` are attached — read the bottom of `v.ts` to
see how `v` is assembled):

```ts
const from = <S extends StandardSchemaV1>(schema: S): ColumnValidator<StandardSchemaV1.InferOutput<S>, ...> => {
    const props = schema["~standard"];
    if (!props || props.version !== 1 || typeof props.validate !== "function") {
        throw new Error("@cirrus/values: v.from() expects a Standard Schema v1 object (missing or invalid \"~standard\")");
    }
    return asColumn(createValidator<...>("from", (value, context) => {
        const result = props.validate(value);
        if (result instanceof Promise) {
            throw new ValidationError("v.from(): async Standard Schema validators are not supported in args", context.path);
        }
        if ("issues" in result && result.issues) {
            // Map the FIRST issue to the package's ValidationError shape,
            // appending the issue's own path to context.path.
        }
        return result.value;
    }));
};
```

Load-bearing details (verify each against the real code, the names above are
indicative): how `fail(...)`/`ValidationError` raise errors with `context.path`;
what `asColumn` requires; what generic parameters `ColumnValidator` takes.
Mirror an existing simple validator (e.g. the `record` builder at v.ts:~589)
for the exact shapes. Use the spec's `StandardSchemaV1.InferOutput<S>` if the
vendored type declares it; otherwise infer via the `validate` return type.

**Verify**: `pnpm --filter "@cirrus/values" run lint:types` → exit 0.

### Step 2: Reject `v.from` in table definitions

Find where `defineTable` (in `packages/server/src/schema.ts`) consumes column
validators. If columns are accepted structurally (any `ColumnValidator`
passes), add a guard: a validator with `kind === "from"` used as a table
column throws
`"v.from() validators are args-only — table columns need a concrete v.* type"`.
If `defineTable` already validates kinds against a known set, confirm `from`
is naturally rejected and skip the code change (note it in the report).

**Verify**: `pnpm --filter "@cirrus/server" run test` → all pass.

### Step 3: Unit tests for the adapter

In `packages/values/__tests__/` (model on the existing `v.test.ts`), with a
hand-rolled fixture:

```ts
const fakeZodString = {
    "~standard": {
        validate: (value: unknown) =>
            typeof value === "string" ? { value: value.toUpperCase() } : { issues: [{ message: "expected string", path: [] }] },
        vendor: "fake",
        version: 1 as const,
    },
};
```

Cases: (1) success passes the *transformed* value through (`"a"` → `"A"` —
proves the adapter returns `result.value`, not the input); (2) failure throws
the package's ValidationError with the issue message and merged path;
(3) non-Standard-Schema input to `v.from` throws the construction error;
(4) async `validate` (returns a Promise) throws the args-only sync error;
(5) round-trip: a *Cirrus* validator (which itself has `~standard`) passes
through `v.from` unharmed.

**Verify**: `pnpm --filter "@cirrus/values" run test` → all pass, 5 new cases.

### Step 4: Args-map integration test in `@cirrus/server`

In `packages/server/__tests__/` (model on existing function tests — find with
`grep -rln "validateArgs\|mutation(" packages/server/__tests__ | head -3`):
define a `mutation({ args: { name: v.from(fixture), count: v.number() }, handler })`
and assert (a) a valid call reaches the handler with the transformed value,
(b) an invalid `name` rejects with the validation error, (c) the plain `v.*`
sibling field still validates — mixing works.

**Verify**: `pnpm --filter "@cirrus/server" run test` → all pass.

### Step 5: Teach codegen to not choke

In the codegen validator-IR parser (`parseValidator`/equivalent in
`discover-schema.ts` — find the `switch`/map over `v.<kind>` names), add a
branch for `from`: emit an IR node that types the arg as `unknown` (or the
file's existing "opaque" fallback if one exists). The emitted api types for a
function using `v.from` must compile. Add one codegen test: a fixture function
file using `v.from(...)` in args → discovery succeeds, emitted args type for
that field is `unknown`.

**Verify**: `pnpm --filter "@cirrus/codegen" run test` → all pass. If an
emit-affecting change alters golden fixtures, regenerate them the way the
existing codegen tests do (see the fixture-regen pattern used by that suite),
and confirm only the new fixture's output changed.

### Step 6: Document

Add a short "Standard Schema interop" section to `packages/values/README.md`:
outbound (`~standard` on every `v.*`) + inbound (`v.from`, args-only, sync-only).

**Verify**: `pnpm run lint:prettier` → exit 0 (or run the fix variant).

## Test plan

Steps 3–5 enumerate the cases. Full gate:
`pnpm --filter "@cirrus/values" run test && pnpm --filter "@cirrus/server" run test && pnpm --filter "@cirrus/codegen" run test` → all pass.

## Done criteria

- [ ] `v.from` exported from `@cirrus/values` with the 5 unit cases passing
- [ ] Server integration test proves mixed `v.from` + `v.*` args maps validate
- [ ] Codegen handles `v.from` without crashing; emitted type is `unknown`
- [ ] No new dependencies in any package.json (`git diff -- '**/package.json'` is empty)
- [ ] All three packages' `lint:types` + `test` exit 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `validateArgs` does anything beyond mapping field→validator `_parse` calls
  (e.g. it introspects `kind` or `_meta.column` in ways a `"from"` kind
  breaks) — report what it needs.
- The vendored `StandardSchemaV1` types in `@cirrus/values` don't expose an
  output-inference helper and you cannot type `v.from` without `any` — stop
  rather than ship an `any`.
- Codegen's validator parser turns out to *evaluate* (not just parse) `v.*`
  chains, making the `unknown` fallback impossible without executing user
  code.
- Step 2 reveals table columns structurally accept any validator AND there is
  no clean choke point to reject `from` — needs a maintainer decision.

## Maintenance notes

- Async Standard Schema support is deliberately deferred — it requires
  `validateArgs` (and both builder call sites) to go async, which touches the
  RPC hot path. Revisit if users ask for zod `.refine(async)`.
- Client-side: args typed via `v.from` flow as the schema's inferred type
  end-to-end only if `Infer` picks up the generic; the codegen-emitted
  `unknown` is the floor for the *generated* api surface. A future
  improvement is emitting `import type`-based inference instead.
- When PLAN5 §6.1 is marked done, also update CONVEX-PARITY/VOID-TEARDOWN
  notes that listed it as a gap.
