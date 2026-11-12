# Plan 607 — Schema discovery resolves a table defined outside the `defineSchema` literal, or says it cannot

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report — do
> not improvise. A reviewer dispatched you and maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git log --oneline -1` → `90c9b63f4`. `git diff --stat 90c9b63f4..HEAD -- packages/codegen/src/discover/schema` → empty.

**Baseline:** `90c9b63f4` (origin/alpha, 2026-11-12)
**Status:** DONE — APPROVED; PR https://github.com/anolilab/lunora/pull/1589 (commit `a7537ee43`). No in-repo app uses an affected shape.
**Source:** found during the 2026-11-11 audit (advisor lints), while adding source locations to schema findings (plan 596).

## Status

- **Priority**: P1 · **Effort**: M · **Risk**: MED (changes generated types and metadata for apps that use these shapes) · **Depends on**: none · **Category**: bug

## 0. Headline and blast radius (verified by the reviewer at `90c9b63f4`)

Codegen reads the schema syntactically. In `defineSchema({...})` only an inline `defineTable(...)` chain is read.
Probe app (all tables `defineTable({ <col>: v.string() })`), result per property shape:

| Property shape                                          | Result today                                        |
| ------------------------------------------------------- | --------------------------------------------------- |
| `inlineT: defineTable({...})`                           | correct                                             |
| `localT: localTable` (same-file `const`)                | table present, **no columns**                       |
| `importedT: importedTable` (imported `const`)           | table present, **no columns**                       |
| `factoryT: makeTable()` (factory call)                  | table present, **no columns**                       |
| `condT: flag ? defineTable(a) : defineTable(b)`         | table present, **no columns**                       |
| `castT: defineTable({...}) as X`                        | table present, **no columns**                       |
| `shorthandT,` (shorthand property)                      | **table missing entirely**                          |
| `...localTables` (spread of a same-file object literal) | correct (followed)                                  |
| `...authTables(options)` (spread of a call)             | skipped by design (documented in `parseBaseTables`) |

No error or warning is produced. What depends on the wrong IR:

- **Emitted TypeScript**: `_generated/dataModel.ts` `Doc_<table>` has only `_id`/`_creationTime`; the shorthand table is absent from `DataModel` (and so from typed `ctx.db` access).
- **Generated Drizzle tables** (`_generated/drizzle.shard.ts` / `.global.ts`): no columns.
- **Generated runtime metadata in `_generated/shard.ts`**: the per-table column list (Studio/admin introspection) and `LUNORA_SCHEMA_SNAPSHOT` (recorded by `packages/shard-engine/src/ctx-db-migrations.ts:642-654` as the schema version hash/json).
- **Advisor**: schema lints see no columns (silent).
- NOT affected: the stored data and DDL — `shard.ts` imports the app's real `schema` (`import schema from "../schema.js"`).

Code: `packages/codegen/src/discover/schema/internal/table-builder.ts`

- `parseTableBuilder(expression, name)` (~828): unwinds `.method(...)` calls; on the base `defineTable` identifier call reads argument 0 (an object literal, else a `diagnosticAt` throw — precedent for this plan's diagnostic); on anything else **breaks silently** with an empty shape.
- `parseBaseTables(object, …)` (~924): follows `SpreadAssignment` via `resolveObjectLiteral`; handles only `PropertyAssignment` (a `ShorthandPropertyAssignment` falls through `continue`).

## 1. Design decisions

- **Resolve, bounded.** Before and during the chain unwind, resolve the current expression: `unwrapExpression` (`discover/ast.ts`: parens, `as`, `satisfies`, `!`); an identifier → its `const` variable declaration's initializer, following an import alias with the type checker's symbol (`getSymbol()`, then `getAliasedSymbol()` when it is an alias), same file or another file in the project; at most 4 hops in total. Resolution also applies when the chain's base turns out to be an identifier (`users: base.index(...)` with `const base = defineTable(...)`).
- **Shorthand** `{ users }` → resolve the name identifier the same way.
- **Unresolvable shapes are a diagnostic, not an empty table**: a call that is not `defineTable` (a factory), a conditional, a `let`/parameter, or a hop limit reached → `throw diagnosticAt(<node>, 'table "<name>" … codegen can only read a defineTable(...) chain …')`, worded like the existing `defineTable(identifier)` diagnostic, naming the table and the shape, and saying how to fix it (inline the `defineTable(...)` or bind it to a `const`). Rejected: a warning plus an empty table (keeps silently wrong types); evaluating factories (codegen is syntactic).
- Spreads of calls stay skipped (documented, `@lunora/auth`'s path) — unchanged.

## 2. Steps

1. Implement the resolver as a small function in `table-builder.ts` (or `discover/ast.ts` if a same-purpose helper exists there — check `isConstDeclaration`, `unwrapExpression`, `declarationOf` first and reuse them), use it in `parseBaseTables` (PropertyAssignment initializer and ShorthandPropertyAssignment) and inside `parseTableBuilder`'s loop when `current` is not a call.
   **Verify**: `pnpm --filter "@lunora/codegen" run lint:types` exit 0.
2. Tests in `packages/codegen/__tests__/discover/schema.test.ts` (follow its fixture style): same-file const, imported const (two-file fixture), chain on a const base (`base.index(...)`), `as` cast, shorthand, and a const-to-const hop → each table has its columns (and its index for the chained case). Diagnostics: factory call, conditional, `let` binding → `runCodegen`/`discoverSchema` throws an error whose message names the table. Spread of a call stays skipped (existing test, if any, unchanged).
   **Verify**: the file passes. Red: restore `table-builder.ts` from `90c9b63f4`, the new tests FAIL; restore; pass.
3. `pnpm --filter "@lunora/codegen" run test`, `lint:eslint`, `lint:types` → exit 0. If a golden fixture changes, STOP and report (reviewer regenerates via `packages/codegen/__tests__/capture-expected.ts`). If an existing test expected a silent empty table, STOP and report its name.
4. Commit: `fix(codegen): resolve tables defined outside the defineSchema literal`. Do not run codegen in `examples/`.

## Scope

In: `packages/codegen/src/discover/schema/internal/table-builder.ts` (and `discover/ast.ts` only to reuse/extend an existing helper), `packages/codegen/__tests__/discover/schema.test.ts`. Out: extensions (`internal/extensions.ts` keeps its own path unless it calls `parseTableBuilder`, which then benefits automatically), emitters, every app.

## STOP conditions

- A golden fixture or an existing test changes.
- Resolving an import needs a project/type-checker setup the schema discoverer does not have (report what is missing).
- A verification fails twice.

## 6. Platform parity

Not applicable.

## Maintenance notes

- Rollout (reviewer): before/after codegen over all 34 in-repo apps; any app using these shapes gets columns (types, Drizzle, Studio metadata, schema-snapshot hash change) or a new codegen error — both called out in the PR body.
