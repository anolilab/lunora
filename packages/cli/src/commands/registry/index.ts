/**
 * The component-registry command set (`lunora registry add | list | view | build`).
 *
 * Mirrors `lunora init`'s `giget`-fetch pipeline but operates on *registry
 * items* (fetched from `gh:anolilab/lunora/registry`) instead of whole-project
 * templates. An item is a directory shipping a `registry.json` manifest plus the
 * files it scaffolds into the user's `lunora/` tree. The model is shadcn/kitcn:
 * the code is copied into the project and becomes the user's to own and edit.
 *
 * Modules (this is the barrel):
 *
 * - `types`     — manifest / option / result shapes.
 * - `manifest`  — `parseManifest` (validation; pure).
 * - `resolve`   — `--source` gate + giget fetch/staging + `resolvePlan`.
 * - `reconcile` — schema-extension merge + lock-aware 3-way whole-file upgrade.
 * - `apply`     — package.json deps, wrangler bindings, `.dev.vars` env vars.
 * - `catalog`   — `index.json` read/build + item enumeration.
 * - `commands`  — the four orchestrators + plan/report rendering.
 *
 * Heavy deps (giget, ts-morph, jsonc-parser) load lazily inside the functions
 * that need them, so e.g. `registry list` never pulls ts-morph.
 */
export { buildRegistryIndex } from "./catalog";
export { runAddCommand, runBuildIndexCommand, runRegistryViewCommand } from "./commands";
export { default as parseManifest } from "./manifest";
export type { AddCommandOptions, AddCommandResult, RegistryBinding, RegistryFile, RegistryManifest } from "./types";
