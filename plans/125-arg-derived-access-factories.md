# Plan 125: Collapse the per-binding "arg-derived access" quadruplets into two factories

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/codegen/src/discover-kv-key-accesses.ts packages/codegen/src/discover-container-key-accesses.ts packages/codegen/src/discover-vector-namespace-accesses.ts packages/codegen/src/discover-storage-key-accesses.ts packages/codegen/src/discover-browser-url-accesses.ts packages/codegen/src/discover-image-delivery-url-accesses.ts packages/codegen/src/ir.ts packages/advisor/src`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (touches 6 codegen feeders + 6 lints; golden-output and lint
  suites are the safety net)
- **Depends on**: plans/124-advisor-test-and-helper-hygiene.md (same package —
  land 124 first)
- **Category**: tech-debt
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

Each "user-input reaches a binding sink" security lint ships as **four
parallel artifacts**: a codegen IR type, a ~90-120-line discover feeder, an
advisor access interface, and a ~46-line lint — times six bindings (kv,
container-key, vector-namespace, storage-key, browser-url,
image-delivery-url), ~24 files. The taint core is already shared
(`argument-taint.ts`), so what's duplicated is AST-walk scaffolding and
map-to-finding boilerplate. Adding the next binding lint costs four
near-identical new files, and a fix to the shared shape (e.g. the cache-key
format) must be applied six times and can drift. Two factories — a generic
`discoverArgDerivedAccesses(config)` in codegen and a `makeArgDerivedSinkLint(config)`
in advisor — collapse the marginal cost to one config-object each.

## Current state

- The six feeders and their sizes (`b6eb48dcd`):
  `discover-kv-key-accesses.ts` (96), `discover-container-key-accesses.ts`
  (101), `discover-vector-namespace-accesses.ts` (122),
  `discover-storage-key-accesses.ts` (115), `discover-browser-url-accesses.ts`
  (99), `discover-image-delivery-url-accesses.ts` (90).
- Shared taint core (`packages/codegen/src/argument-taint.ts` exports):
  `calleeName`, `referencesArgs`, `singleHopInitializer`, `isArgumentDerived`,
  `isScopedByContext`, `referencesRequestInput`, `isRequestInputDerived`,
  `enclosingExportName`.
- Feeder shape (from `discover-kv-key-accesses.ts:1-45`): a method-set +
  receiver match (`receiver === "ctx.kv" || receiver.startsWith("ctx.kv.")`),
  a per-call extractor building the IR row when the key argument
  `isArgumentDerived` and not `isScopedByContext`, over
  `listLunoraSourceFiles(lunoraDirectory)` — imported from
  `./discover-functions` together with `lunoraRelativePath`.
- IR types in `packages/codegen/src/ir.ts`: `KvKeyAccessIR`,
  `ContainerKeyAccessIR`, `VectorNamespaceAccessIR`, `StorageKeyAccessIR`,
  `BrowserUrlAccessIR`, `ImageDeliveryUrlAccessIR` — structurally
  `{ exportName; file; line; method }` (some may add a field — inventory in
  Step 1).
- Lint shape (from `kv-unscoped-user-key-idor.ts`, 50 lines): a `Lint` object
  whose `run(context)` returns `[]` when `context.kvKeyAccesses === undefined`
  else maps rows through `emit(lint, { cacheKey, detail, metadata })` — the
  five siblings are the same modulo naming/prose:
  `container-instance-key-from-user-input`, `vectors-namespace-from-user-input`,
  `storage-key-from-user-args`, `images-url-source-from-user-input`, plus the
  browser-url one (find its exact filename with
  `grep -rln "browserUrlAccesses" packages/advisor/src/lints/static/`).
- Advisor access interfaces: `packages/advisor/src/{kv,container-key,vector-namespace,storage-key,…}-accesses.ts`
  (one tiny interface each).
- Wiring: `packages/codegen/src/run-codegen.ts` (~lines 296-411) calls each
  feeder; the advisor `LintContext` carries each accesses array. Golden
  fixtures pin codegen output; the advisor suites pin lint output
  (`packages/advisor/__tests__/security-lints.test.ts` and dedicated files).

Hard compatibility constraints:

1. **Lint names, `cacheKey` formats, `detail` strings, severities, and the
   per-lint `context.<x>Accesses` keys are public behavior** — pinned by
   tests and by users' suppression habits. The refactor must be
   byte-identical on outputs.
2. Codegen golden output must not change (`pnpm --filter "@lunora/codegen" run test`
   includes golden assertions).

Conventions: no `.js` extensions in package source imports (codegen's
**emitted strings** keep theirs — don't touch emit templates); a lint file's
default export is its sole export; enforced commit type: `refactor`.

## Commands you will need

| Purpose                      | Command                                        | Expected on success |
| ---------------------------- | ---------------------------------------------- | ------------------- |
| Build deps                   | `pnpm --filter "@lunora/codegen..." run build` | exit 0              |
| Codegen tests (incl. golden) | `pnpm --filter "@lunora/codegen" run test`     | all pass            |
| Advisor tests                | `pnpm --filter "@lunora/advisor" run test`     | all pass            |
| Types / lint                 | per-package `lint:types` / `lint:eslint`       | exit 0              |

## Scope

**In scope**:

- `packages/codegen/src/discover-arg-derived-accesses.ts` (create — the factory)
- The six `discover-*-accesses.ts` feeders (shrink to config + factory call,
  or delete if the factory is invoked centrally)
- `packages/codegen/src/ir.ts` (optionally a shared base type; keep the six
  named aliases exported — they may be imported elsewhere: grep first)
- `packages/codegen/src/run-codegen.ts` (wiring)
- `packages/advisor/src/lints/arg-derived-sink.ts` (create — the lint factory)
- The six lint files (shrink to a factory call each — the files must continue
  to exist and default-export the same lint name, so the lint registry and
  imports stay stable)
- The six advisor access-interface files (optionally alias a shared interface)

**Out of scope**:

- `argument-taint.ts` (already shared — do not modify).
- Any lint message/severity/cacheKey change.
- Feeders that are NOT in the six-file family (e.g. `discover-raw-row-returns`,
  `discover-normalize-id-authorization` have different shapes — leave them).
- `emit.ts` and any codegen emit templates.

## Git workflow

- Branch: `advisor/125-arg-derived-factories`
- Suggested commits: `refactor(codegen): generic arg-derived-access discovery factory`,
  `refactor(advisor): arg-derived sink lint factory`.

## Steps

### Step 1: Inventory the six-way diff

Read all six feeders and all six lints side by side. Produce a table of the
config axes: sink matcher (receiver prefix + method set vs other shapes),
key-argument index, extra IR fields, scoping predicate differences, lint
name/cacheKey/detail templates. The vector-namespace and browser-url variants
are the most likely to deviate (122/99 lines) — if any feeder's logic differs
**semantically** (not just naming), keep that one hand-written and factory
only the true clones; record the decision.

**Verify**: the table is in your report before any code change.

### Step 2: Codegen factory

Create `discoverArgDerivedAccesses(project, lunoraDirectory, config)` in the
new file, where `config` covers the axes from Step 1 (e.g.
`{ receiver: "ctx.kv", methods: Set<string>, keyArgIndex: 0 }`). Reimplement
each clone feeder as a thin module that builds its config and delegates —
**keeping each feeder's exported function name and signature identical** so
`run-codegen.ts` wiring and tests don't churn (change the wiring only if the
feeders' exports were only ever used by `run-codegen.ts` — grep each name).

**Verify**: `pnpm --filter "@lunora/codegen" run test` → all pass, golden
byte-identical (the suite fails loudly if not).

### Step 3: Advisor lint factory

Create `makeArgDerivedSinkLint(config)` returning a `Lint`, with config for
`name`, `title`, `description`, `remediation`, `level`, the `context` key to
read, and the `cacheKey`/`detail` template functions. Rewrite each of the six
lint files as `export default makeArgDerivedSinkLint({ … })`. The templates
must reproduce the current strings **exactly** — copy them from each file
verbatim into the config.

**Verify**: `pnpm --filter "@lunora/advisor" run test` → all pass — these
suites assert names, cacheKeys, levels, and `toMatchObject` on findings, so
string drift fails.

### Step 4: Dead-weight sweep

If the six access interfaces are now structurally one type, add a shared
`ArgDerivedAccess` interface and alias the six names to it (keep the names
exported). Delete any now-unused local helpers in the shrunken files.

**Verify**: `lint:types` + `lint:eslint` exit 0 for codegen and advisor;
`pnpm --filter "@lunora/studio" run lint:types` → exit 0 (studio consumes
advisor types).

## Test plan

No new behavior → no new tests required; the existing suites are the
byte-stability lock. Add exactly one new test: a factory-level unit test in
`packages/advisor/__tests__/` asserting `makeArgDerivedSinkLint` returns `[]`
for `undefined` and empty evidence (generalizing plan 124's negatives).

## Done criteria

- [ ] Six feeders delegate to one factory (or documented exceptions from
      Step 1); six lints are factory calls
- [ ] `wc -l` of the 12 refactored files drops by ≥50% in aggregate
- [ ] Codegen tests (golden included) + advisor tests all pass with **zero
      expectation changes** (`git diff --stat` shows no `__tests__` edits
      except the one new factory test)
- [ ] `lint:types`/`lint:eslint` exit 0 for codegen, advisor, studio
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 shows fewer than 4 of the 6 are true clones (the factory wouldn't
  pay for itself — report the table and recommend REJECTED).
- Any golden codegen fixture changes (the factory altered discovery output —
  find the diff, and if it isn't a trivial ordering artifact you can make
  deterministic, stop).
- Any advisor test needs an expectation change (strings drifted — fix the
  template, never the test).
- The six feeder exports are imported anywhere beyond `run-codegen.ts` and
  tests in a way that constrains the refactor (grep first; report if so).

## Maintenance notes

- The next binding sink lint should be one codegen config + one advisor
  config (+ its tests). If someone adds a seventh hand-written quadruplet,
  point them here.
- Reviewers: diff each lint config's strings against the pre-refactor file —
  the tests catch asserted strings, but `remediation`/`description` prose may
  be un-asserted; it must still match.
