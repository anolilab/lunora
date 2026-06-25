# Plan 056: Resolve schema extensions defined inside published packages (`node_modules`)

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat fbc3ae55..HEAD -- packages/codegen/src/discover-schema.ts packages/codegen/src/ir.ts packages/codegen/src/schema-ir.ts packages/server/src/plugin.ts packages/server/src/schema.ts packages/values/src/to-json-schema.ts packages/values/src/json-schema-core.ts`. If the `.extend(...)` resolver in `discover-schema.ts`, the `SchemaExtension`/`TableBuilder` runtime shapes, or the validator-introspection surface differ from what this plan cites, STOP and re-read.

## Status

- **Priority**: P3 (deferred). No shipping registry item needs it — every `lunora add` item copies a local `lunora/<key>/schema.ts` that defines its extension inline via `definePlugin(...)`, which the AST path already resolves (commit `fbc3ae55`, Plan-less fix). This plan covers the _future_ case: a package that ships its own `defineSchemaExtension` value and expects an app to `.extend(pkg.extension)` without a local copy.
- **Effort**: M (the validator-runtime→IR bridge is the bulk; the import + access-path mapping is small).
- **Risk**: MEDIUM (dynamically importing a feature package at codegen time can trigger module-load side effects / Cloudflare-only globals; the validator→IR bridge must cover every `v.*` kind or extension columns silently degrade).
- **Depends on**: none. Strictly additive — a _fallback_ taken only when the existing AST resolution bails.
- **Category**: feature (codegen schema discovery — cross-package extension tables in generated types).
- **Planned at**: commit `fbc3ae55`, 2026-06-25.

## Verdict

When `.extend(X.extension)` resolves to a declaration that lives in `node_modules`/`.d.ts` (the branch `discover-schema.ts` currently bails on, emitting the "deferred phase" warning), fall back to **runtime introspection of the extension value** — NOT `.d.ts` type reconstruction and NOT `.mjs` AST parsing.

This is the right approach because **the runtime `SchemaExtension` value already carries everything codegen needs**:

- `defineSchemaExtension(key, { tables, vectorIndexes })` returns `{ key, tables, vectorIndexes }` verbatim (`packages/server/src/plugin.ts:187-200`) — the `tables` are the live `TableBuilder` objects.
- `defineTable({...}).index(...)` returns a builder exposing its `indexes` via a getter (`packages/server/src/schema.ts:189-258`) and its column validators (the `shape` passed in).
- `v.*` validators are runtime-introspectable: they expose `.kind` + `._meta`, and `@lunora/values` already reads exactly that to produce JSON Schema (`packages/values/src/to-json-schema.ts:5-20`, `packages/values/src/json-schema-core.ts:42-84`).

So codegen can import the module that exports the extension, read the runtime `{ key, tables, vectorIndexes }`, and convert each runtime `TableDefinition` → `TableIR` (the same IR `parseTableBuilder` produces from AST), then feed it into the existing `MergedExtension` prefixing/merge path. Downstream emit is unchanged.

Rejected alternatives:

- **`.d.ts` type reconstruction** — validators erase to structural TS types; index lists and `_meta` (index hints, `unique`, sharding) aren't recoverable from types. Lossy and fragile.
- **`.mjs` AST parsing** — published output is bundled/minified; `defineTable`/`defineSchemaExtension` call sites are not reliably present. Fragile.
- **Require packages to ship a JSON manifest** — works, but adds a publishing burden and duplicates the source of truth. Runtime introspection needs nothing extra from package authors.

## Current state

- **Resolver bail-out**: `packages/codegen/src/discover-schema.ts` — `resolveSchemaExtensionCall` follows symbols and returns `undefined` when `declarationFile.isInNodeModules() || declarationFile.isDeclarationFile()` (the `// Cross-package … defer` branch). `mergeOneExtension` then `console.warn`s the "skipping `.extend(...)` … deferred phase" line and drops the extension's tables.
- **AST path (just shipped, `fbc3ae55`)**: local `definePlugin("key", { extension: defineSchemaExtension(...) })` — same-file and sibling-local-file — is now resolved by following the receiver + unwrapping the `definePlugin` config object (`pluginConfigObject`, `extensionTargetIdentifier`, `nextExpressionFromDeclaration`). This plan does NOT change that path; it only adds a fallback for the genuinely-cross-package case.
- **IR target**: `TableIR`/`SchemaIR` in `packages/codegen/src/ir.ts`; `parseTableBuilder`/`parseExtensionTables`/`parseExtensionVectorIndexes` in `discover-schema.ts` produce them from AST. `MergedExtension` (prefixed tables + standalone vector indexes) is the merge unit.
- **Validator bridges that exist**: `validatorIrToJsonSchema` (IR→JSON, `packages/codegen/src/schema-ir.ts:77`) and `schemaFromIr` (IR→runtime `Schema`, `packages/codegen/src/schema-from-ir.ts:113`). **Missing**: the reverse — a runtime `Validator` → `ValidatorIR`. The reader the new code must mirror lives in `@lunora/values` (`json-schema-core.ts` `reader.kind`, `to-json-schema.ts` `metaOf`).
- **Existing runtime introspection precedent**: `packages/do/src/introspect.ts` introspects a live schema for the studio; `buildSchemaSnapshot` (`packages/codegen/src/schema-drift.ts:164`) serializes `SchemaIR`. Neither currently ingests a runtime `SchemaExtension`, but they confirm a runtime→serializable path is normal.
- **Missing**: (a) runtime-`Validator`→`ValidatorIR`; (b) runtime-`TableDefinition`→`TableIR`; (c) `.extend(arg)` AST → runtime access-path mapping; (d) the dynamic-import + module-resolution glue; (e) wiring the fallback into the bail-out branch.

## Approach (runtime introspection)

1. **Map the AST argument to a runtime access path.** For the bailed `.extend(arg)`, derive `{ moduleSpecifier, exportName, propertyPath }` from the import that introduced the receiver identifier:
    - `import { ratelimit } from "@lunora/ratelimit"` + `.extend(ratelimit.extension)` → `{ "@lunora/ratelimit", "ratelimit", ["extension"] }`.
    - `import { myExt } from "pkg"` + `.extend(myExt)` → `{ "pkg", "myExt", [] }`.
    - Only support identifier / single property-access shapes (the same shapes the AST path supports). Anything else → keep current warn+skip.
2. **Resolve + import the module.** Resolve `moduleSpecifier` against the project root's `node_modules` honoring package `exports` (prefer a dedicated side-effect-free subpath if the package exposes one — see Open Q2). Published packages ship ESM `.mjs` → dynamic `import()`. Cache by resolved path. Wrap in try/catch — any failure falls back to the existing warn+skip (never throws codegen).
3. **Read the runtime extension value**: walk `exportName` + `propertyPath` on the imported namespace to get the `SchemaExtension` (`{ key, tables, vectorIndexes? }`). Validate shape; bail to warn+skip if it isn't one.
4. **Convert to IR**:
    - `runtimeValidatorToIR(validator): ValidatorIR` — new; mirror `@lunora/values`' `kind`/`_meta` reader. Cover every `v.*` kind (object/array/record/union/optional/id/literal/number/string/boolean/bytes/bigint/date/timestamp/null) + relevant `_meta` (index hints, `unique`, sharding, `externallyManaged`). This is the bulk of the work and the main correctness surface.
    - `runtimeTableToIR(tableBuilder, bareName): TableIR` — read the builder's column shape (→ columns via `runtimeValidatorToIR`) and `.indexes` (→ index IR). Produce the same `TableIR` as `parseTableBuilder`.
    - Assemble a `MergedExtension` (prefixed tables + standalone vector indexes) identical to the AST path's output.
5. **Wire the fallback** into the node_modules/`.d.ts` bail branch: before returning `undefined`/warning, attempt steps 1–4; on success, merge; on any failure, fall through to today's warn+skip.

Keep the new logic in a separate module (e.g. `packages/codegen/src/resolve-package-extension.ts`) so `discover-schema.ts` only gains a small call at the bail point, and the runtime-import surface is isolated + independently testable.

## Steps

- [ ] **S1 — `runtimeValidatorToIR`** (new file `packages/codegen/src/runtime-validator-ir.ts`). Mirror the `@lunora/values` introspection (`kind` + `_meta`) to produce `ValidatorIR`. Unit-test every `v.*` kind against the IR `parseTableBuilder` would produce for the same column, so the two paths agree.
- [ ] **S2 — `runtimeTableToIR` + `runtimeExtensionToMergedExtension`** (`packages/codegen/src/resolve-package-extension.ts`). Read `TableBuilder` columns + `.indexes` + the extension's `vectorIndexes`; emit the same `MergedExtension` shape the AST path builds.
- [ ] **S3 — access-path mapping** — given the `.extend(arg)` AST node + the source file, compute `{ moduleSpecifier, exportName, propertyPath }` from the import declaration that bound the receiver. Return `undefined` for unsupported shapes.
- [ ] **S4 — module resolution + dynamic import** — resolve the specifier against `projectRoot/node_modules` (honor `exports`), `import()` it (cache by resolved path), walk the access path to the `SchemaExtension`. All failures → `undefined`.
- [ ] **S5 — wire fallback** into `discover-schema.ts` at the `isInNodeModules() || isDeclarationFile()` branch (and the final `undefined` return of `resolveSchemaExtensionCall`): try the package path; only warn+skip if it returns `undefined`. Keep the warning text accurate (drop "deferred phase"; say what actually failed — unresolved specifier / un-importable / not-an-extension).
- [ ] **S6 — tests**: a fixture package under a temp `node_modules` exporting a real `defineSchemaExtension` value; assert the merged `SchemaIR` carries the prefixed extension tables + indexes. Plus the S1 validator-coverage matrix. Plus a regression asserting the local `definePlugin` path (Plan `fbc3ae55`) is untouched (still AST-resolved, no import).
- [ ] **S7 — verify**: `pnpm --filter "@lunora/codegen" run build && pnpm --filter "@lunora/codegen" exec vitest run && pnpm --filter "@lunora/codegen" run lint:types`. Then a real-scaffold smoke: a project that `.extend(pkg.extension)` from an installed package shows the extension tables in `_generated/dataModel.ts` and emits no skip warning.

## Risks & mitigations

- **Module-load side effects / Workers-only globals** (MEDIUM): importing a feature package at codegen time may execute code referencing `cloudflare:workers`, `env`, or other runtime-only bindings, throwing on import. Mitigation: prefer importing a **dedicated side-effect-free schema subpath** (Open Q2); always try/catch → warn+skip so codegen never breaks; document the contract that extension exports must be import-safe.
- **TS vs JS loading** (LOW for node_modules): published packages ship `.mjs` (directly importable). A local sibling TS file does NOT need this path (the AST path already covers it). If a non-`node_modules`, non-AST-resolvable TS case ever arises, it needs a TS loader (jiti — available to `@lunora/vite`/`@lunora/cli` but not guaranteed when codegen runs standalone). Scope this plan to `node_modules` `.mjs` only; leave standalone-TS out.
- **Validator→IR fidelity** (MEDIUM): an uncovered `v.*` kind or `_meta` flag silently drops/garbles an extension column. Mitigation: the S1 coverage matrix asserts parity with the AST `parseTableBuilder` for every kind; fail-loud (warn) on an unknown kind rather than emit a wrong column.
- **Determinism** (LOW): dynamic `import()` is cached by resolved path within a codegen run; no nondeterminism introduced into emitted output.

## Open questions (resolve before S4)

- **Q1**: Should the runtime fallback be automatic (whenever AST bails) or opt-in (e.g. a flag / a marker on the import)? Recommendation: automatic — it only runs when the AST path already failed, and fails safe to today's behavior.
- **Q2**: Should we require extension-shipping packages to expose the extension from a **side-effect-free subpath** (e.g. `@lunora/foo/schema`) and only import that, to avoid pulling middleware/runtime deps? Recommendation: yes — prefer `<specifier>/schema` if it resolves, else fall back to the main entry. Document it as the authoring contract.
- **Q3**: Where does codegen get a working `import()` in every context it runs (Vite plugin, CLI, standalone test)? Confirm the node context can `import()` ESM from the project's `node_modules` without a bundler. If not, the fallback must detect the unsupported environment and warn+skip.

## STOP conditions

- If `defineSchemaExtension` / `defineTable` stop returning their inputs verbatim (i.e. the runtime value no longer carries the table builders) — the whole approach is invalidated; STOP and reconsider a manifest-based design.
- If importing the test fixture package throws despite a side-effect-free subpath — STOP and revisit Q2/Q3 before widening.
