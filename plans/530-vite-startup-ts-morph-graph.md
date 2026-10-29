# Plan 530 — Keep ts-morph out of the Vite and cloudflare config-load graph

**Baseline:** `50679c5ab` (2026-10-16)
**Status:** BLOCKED — needs a choice between two options (§4)

## 0. Headline finding

Loading the `@lunora/vite` root entry pulls ts-morph (1020 modules). Loading
`@lunora/config/cloudflare` pulls it too (690 modules). `@lunora/config/light`, added in #1224,
does not (100 modules). The cost is paid once per config load, not per request: about 0.5–1 s
of module load on the measuring machine, noisy ±50%.

## 1. Current state (audit)

- `packages/vite/src/index.ts:136-137`: the factory `lunora()` resolves the target synchronously
  through `resolveOptions`, then `resolveTargetOrThrow` (`packages/config/src/project-config.ts:104`),
  then codegen's `readProjectConfigLiterals`, which uses ts-morph.
- Vite imports codegen directly in five files.
- `packages/config/src/cloudflare/wrangler-project.ts:386` calls `validateWranglerProject`, which
  calls `discoverSchemaInfo` synchronously (`:430`) and therefore codegen.
- `assert-wrangler.ts:38` and `wrangler-codegen-inputs.ts:42` call codegen synchronously too.
- Codegen's `exports` map has only an `import` condition, so `createRequire` cannot reach it
  (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
- `collectExportGaps` has only a type-level import of infer-bindings. The edge in the bundle is
  packem chunk sharing, not a real dependency.

## 2. Existing seams (do not reinvent)

- `@lunora/config/light` (#1224): the ts-morph-free leaf for string helpers.
- The codegen package already splits its own ts-morph usage across modules.

## 3. The behavioural contract to preserve

- Every public export of `@lunora/vite`, `@lunora/config` and `@lunora/config/cloudflare` is
  unchanged (`api:check`).
- Vite config resolution returns the same targets and errors for the same project.

## 4. Design decisions (owner input needed)

- **Option 1: make codegen's ts-morph import lazy** across its ~130 files, so a light config load
  never reaches it. Public API unchanged. Large mechanical change, and the sync call sites above
  must become async or use a pre-resolved target.
- **Option 2: make `lunora()` defer target resolution** to `configResolved` or an async hook.
  Smaller, but it changes the public factory's timing and possibly its type.

Recommendation: option 1, sized as a stacked series of PRs by package, because it keeps the public
API stable and the cost is startup-only.

## 5. Workstreams

- **W1 (M):** measure the per-process gain of removing ts-morph from the Vite root on a real app
  build, so the option is chosen on numbers.
- **W2 (L):** option 1 or option 2, as chosen.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding changes.

## 7. Phasing & ordering

| Phase | Work          | Gate                                                                                       |
| ----- | ------------- | ------------------------------------------------------------------------------------------ |
| 0     | Choose option | Written choice in §4.                                                                      |
| 1     | W1            | Gain recorded in this file.                                                                |
| 2     | W2            | Static import walk: no ts-morph in vite root or config/cloudflare dist; `api:check` clean. |
