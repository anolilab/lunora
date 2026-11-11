# Plan 550 — Stop mixing a default export with named value exports (7 files; Nuxt module needs a decision)

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):** `git diff --stat 4a7c48bfd..HEAD -- packages/cli/src/util/lazy-smoke-load.ts packages/codegen/src/assert-required-packages.ts packages/react/src/use-preloaded-query.ts packages/solid/src/shared-context.ts packages/studio/src/features/api`
> must print nothing. Any change is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** DONE for 7 files (review APPROVED; branch `refactor/improve-550-split-mixed-exports`, 5 commits, head b68da26f8; api:check clean after full build; not merged). Nuxt module BLOCKED on owner (§4).
**Priority / effort / risk:** P3 / S / LOW. **Category:** tech-debt. **Depends on:** none.

## 0. Headline finding

`AGENTS.md`: "Never mix a default export with named exports in the same file. More than one export ⇒
named only. A `default` is allowed only as a file's sole export." Eight `src` files export a default
alongside named VALUE exports (re-derived with a TypeScript AST scan at the baseline). Eleven more
pair a default with TYPE-only exports; those are out of scope here (§4).

## 1. Current state (audit) — the files and their importers

| File                                                                     | Default                  | Named value exports                                                                            | Importers to update                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/util/lazy-smoke-load.ts` (`:1209-1210`)                | `runLazySmokeLoad`       | `killWindowsTreeOnExit`, `taskkillEndedTree`                                                   | `packages/cli/src/commands/deploy/handler.ts:50` (`import runSmokeLoad from "../../util/lazy-smoke-load"`); `packages/cli/__tests__/util/lazy-smoke-load.test.ts:11`; `packages/cli/__tests__/commands/lazy-deployment.test.ts:17` and its `vi.mock(import("../../src/util/lazy-smoke-load"), () => { return { default: vi.fn(...) }; })` at `:21-23` |
| `packages/codegen/src/assert-required-packages.ts` (`:198-200`)          | `assertRequiredPackages` | `requiredPackagesFor` (+ types)                                                                | `packages/codegen/src/declaration-surface.ts:39`; `packages/codegen/__tests__/assert-required-packages.test.ts:3`                                                                                                                                                                                                                                     |
| `packages/react/src/use-preloaded-query.ts` (`:137-138`)                 | `usePreloadedQuery`      | `hydratePreloaded`                                                                             | `packages/react/src/index.ts:128` (`export { hydratePreloaded, default as usePreloadedQuery } from "./use-preloaded-query";`); tests `use-preloaded-query.test.tsx:8`, `client-swap.test.tsx:8`, `identity-change.test.tsx:9`, `use-preloaded-query-types.test.ts:3` (`import type usePreloadedQuery from …`)                                         |
| `packages/solid/src/shared-context.ts` (`:68-69`)                        | `sharedContext`          | `sharedContextFor`                                                                             | `packages/solid/src/context.ts:6` (`import sharedContext from "./shared-context"`). NOTE: `packages/react/src/shared-context.*` is a DIFFERENT file; do not touch React's.                                                                                                                                                                            |
| `packages/studio/src/features/api/api-docs-panel.tsx` (`:406-408`)       | `ApiDocsPanel`           | `buildClientSnippet`, `buildCliSnippet`, `buildReactSnippet`, `buildTableSnippet`, `splitPath` | `packages/studio/__tests__/features/api/api-docs-panel.test.tsx:6`; `packages/studio/src/index.ts:21` (`export { default as ApiDocsPanel } …` — unchanged)                                                                                                                                                                                            |
| `packages/studio/src/features/api/openapi/json-highlight.tsx` (`:91-92`) | `JsonHighlight`          | `tokenize`                                                                                     | `packages/studio/__tests__/features/api/openapi/json-highlight.test.ts:3`                                                                                                                                                                                                                                                                             |
| `packages/studio/src/features/api/openapi/method-badge.tsx` (`:84-85`)   | `MethodBadge`            | `kindTone`, `methodTone` (used only inside the file, line 75; no importer)                     | none                                                                                                                                                                                                                                                                                                                                                  |
| `packages/nuxt/src/module.ts` (`:243, 346, 472`)                         | `lunoraNuxtModule`       | `checkWorkerEntry`, `checkClientOnlyProvider` (+ `ResolvedNuxtPlugin`, `ModuleOptions` types)  | **excluded — see §4**                                                                                                                                                                                                                                                                                                                                 |

Re-derive importers yourself before editing each file:
`grep -rn "<basename-without-extension>\"" packages --include='*.ts' --include='*.tsx' --include='*.vue' | grep -v node_modules | grep -v /dist/`
and also `grep -rn "import(\".*<basename>\")"`. Resolve each hit's relative path — a same-named file in
another package is not an importer.

## 2-3. Seams and contract

- Public surfaces must not change: `@lunora/react` still exports `usePreloadedQuery` and
  `hydratePreloaded`; `@lunora/studio` still exports `ApiDocsPanel` (default re-export in its index is
  fine — the rule is per file, and `index.ts` has only named exports).
- Behaviour unchanged; this is a pure module-shape refactor.

## 4. Design decisions

- **Hooks/functions** (cli, codegen, react, solid): make the default a named export and update every
  importer. Chosen over moving helpers to a sibling file: these files' "default" is just one of several
  functions.
- **React components** (studio): keep the component as the sole default export and MOVE the helpers:
  `api-docs-panel.tsx` helpers → new `packages/studio/src/features/api/api-docs-snippets.ts`;
  `tokenize` (and the `Token` type it needs) → new `packages/studio/src/features/api/openapi/json-tokenize.ts`;
  `method-badge.tsx` simply stops exporting `kindTone`/`methodTone` (no importer).
- **Type-only companions** (11 files, mostly studio `*Props` types next to a default component) are out
  of scope: the rule's interop rationale does not apply to erased type exports. Owner question §9.1.
- **Nuxt module — BLOCKED, owner decides:** Nuxt requires the module as the default export, and
  `checkWorkerEntry` / `checkClientOnlyProvider` / `ResolvedNuxtPlugin` / `ModuleOptions` are public
  (`api-snapshots/nuxt.api.md`). Options: (a) move the two checks to `module-checks.ts` and drop them
  from the public surface (alpha-acceptable break; `ModuleOptions` stays as a type-only companion);
  (b) add a written AGENTS.md exception for Nuxt modules, like the Worker-entry one. Not for the
  executor.

## 5. Workstream — steps

**Commands** (each package as you touch it):

| Purpose             | Command                                                                                                                                                                  | Expected                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Install             | `pnpm install`                                                                                                                                                           | exit 0                                        |
| Build deps          | `pnpm --filter "@lunora/<pkg>..." run build` for cli, codegen, react, solid, studio (cli's closure includes studio; build codegen, react, solid, studio first, then cli) | exit 0                                        |
| Tests               | `pnpm --filter "@lunora/<pkg>" run test` for the five packages                                                                                                           | all pass                                      |
| Types               | `pnpm --filter "@lunora/<pkg>" run lint:types` for the five packages                                                                                                     | exit 0                                        |
| Format              | `pnpm exec oxfmt <changed files>`                                                                                                                                        | exit 0                                        |
| Lint (after format) | `pnpm --filter "@lunora/<pkg>" run lint:eslint` for the five packages                                                                                                    | exit 0                                        |
| Mixed-export scan   | see Step 8                                                                                                                                                               | only the nuxt file and type-only files remain |

**Scope.** In scope: the seven files in §1 (not nuxt), their importers listed in §1 (and any further
importer your grep finds inside the same package), and the two new studio files. Out of scope:
`packages/nuxt/**`, any type-only companion export, `api-snapshots/*`, every other package.

**Step 1 — install, build, baseline tests.** Run each package's tests once and record failures (expect none).

**Steps 2-8 — one file per step, one commit per package** (a commit per package keeps review simple):

2. cli `lazy-smoke-load.ts`: `export { killWindowsTreeOnExit, runLazySmokeLoad, taskkillEndedTree };`;
   update `deploy/handler.ts` to `import { runLazySmokeLoad as runSmokeLoad } …` or rename the local use;
   update both tests, including the `vi.mock` factory to `return { runLazySmokeLoad: vi.fn<…>(async () => undefined) };`
   and the test's import. Verify: `pnpm --filter "@lunora/cli" exec vitest run __tests__/util/lazy-smoke-load.test.ts __tests__/commands/lazy-deployment.test.ts` passes.
3. codegen `assert-required-packages.ts`: named `assertRequiredPackages`; update `declaration-surface.ts`
   and the test. Verify: codegen test file passes.
4. react `use-preloaded-query.ts`: named `usePreloadedQuery`; `index.ts:128` → `export { hydratePreloaded, usePreloadedQuery } from "./use-preloaded-query";`;
   update the four tests (`import type { usePreloadedQuery }` in the types test). Verify: react tests pass.
5. solid `shared-context.ts`: named `sharedContext`; update `solid/src/context.ts`. Verify: solid tests pass.
6. studio `api-docs-panel.tsx`: move the five helpers (and any private helpers only they use) into
   `api-docs-snippets.ts` with named exports; the panel imports them; the test imports helpers from the
   new file and the panel default from the old. Verify: studio test file passes.
7. studio `json-highlight.tsx` → `json-tokenize.ts` (`tokenize`, plus `Token` as a named type export);
   update the component and the test. `method-badge.tsx`: delete the `export { kindTone, methodTone };`
   line. Verify: studio tests pass.
8. Scan: run
   `node -e` is not required — use this grep, which must print only `packages/nuxt/src/module.ts`:
   `for f in $(git ls-files 'packages/*/src/*.ts' 'packages/*/src/**/*.ts' 'packages/*/src/*.tsx' 'packages/*/src/**/*.tsx'); do grep -q "^export default" "$f" && grep -qE "^export \{[^}]*[a-z][A-Za-z]* *[,}]|^export const |^export function " "$f" && echo "$f"; done`
   Verify: output is `packages/nuxt/src/module.ts` only. (If the grep is noisy, list each hit and explain
   why it is a type-only or false positive.)

**Step 9 — gates.** For each of the five packages: format, lint, types, tests. Verify: all exit 0.

**Commits** (one per package, staged by path). Messages:
`refactor(cli): export runLazySmokeLoad by name`,
`refactor(codegen): export assertRequiredPackages by name`,
`refactor(react): export usePreloadedQuery by name`,
`refactor(solid): export sharedContext by name`,
`refactor(studio): move panel helpers out of component modules`.
Each body: one line naming the AGENTS.md rule ("never mix a default export with named exports"), then
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

No red-without-fix step applies (no behaviour change); the existing tests are the gate, plus the scan.

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase         | Work                                    | Gate                                      |
| ------------- | --------------------------------------- | ----------------------------------------- |
| 0             | Steps 1-9                               | five packages green; scan shows only nuxt |
| 1 (reviewer)  | `pnpm run api:check` after a full build | no snapshot diff (public names unchanged) |
| later (owner) | nuxt §4 decision                        | —                                         |

## 8. STOP conditions

- **STOP** on drift.
- **STOP** if a file in §1 has an importer outside its own package (other than the listed public index
  re-exports) — a cross-package import of a deep path.
- **STOP** if any package's tests fail after its step and the fix is not an import path/name.
- **STOP** if you find yourself editing `packages/nuxt`.
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

1. (Owner) Does the rule cover type-only companions (`export type { Props }` next to a default
   component)? If yes, a follow-up plan for the 11 files.
2. (Owner) Nuxt module: option (a) or (b) in §4.

## Done criteria

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only in-scope files; nothing under `packages/nuxt`.
- [ ] Step 8 scan prints only `packages/nuxt/src/module.ts`.
- [ ] cli, codegen, react, solid, studio: `test`, `lint:types`, `lint:eslint` exit 0.
- [ ] Five commits as listed.
