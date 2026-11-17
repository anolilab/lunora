#!/usr/bin/env node
/**
 * Sync the @lunora/saas-ui source-of-truth into the `saas-ui-*` registry items.
 *
 * The kit's screens are authored once in `packages/saas-ui/src` (where they
 * type-check and test against the real workspace deps) and mirrored verbatim
 * into each `registry/saas-ui-<framework>/` payload, so the copy a user installs
 * never drifts from what is tested. The mirroring lives in
 * `sync-ui-registry.mjs`, shared with the auth-ui family.
 *
 * Layout in a consumer project (every file `create-or-skip`, user-owned):
 *   lunora/saas-ui/core/*      (framework-agnostic view model — identical across frameworks)
 *   lunora/saas-ui/<view>/*    (react|svelte view layer)
 *   lunora/saas-ui/styles.css  (one stylesheet; every port renders the same DOM)
 *
 * Usage:
 *   node scripts/sync-saas-ui-registry.mjs           # write the payloads + manifests
 *   node scripts/sync-saas-ui-registry.mjs --check   # CI drift guard: fail if stale
 */
import { join } from "node:path";

import { createUiRegistrySync, ROOT } from "./sync-ui-registry.mjs";

// Which registry item maps to which view directory under src/. Four more ports
// (Vue, Solid, Solid 2, Angular) are planned; each lands as a row here plus its
// item shell, and the drift guard below fails the build if a view is added
// without one.
const FRAMEWORKS = [
    { item: "saas-ui-react", view: "react" },
    { item: "saas-ui-svelte", view: "svelte" },
];

const sync = createUiRegistrySync({
    check: new Set(process.argv.slice(2)).has("--check"),
    frameworks: FRAMEWORKS,
    handAuthored: new Set(["registry.json", "README.md"]),
    label: "saas-ui",
    onViewDrift: (views) =>
        `packages/saas-ui/src holds ${String(views.length)} view director(y|ies) with no FRAMEWORKS row, so\n` +
        `\`lunora registry add saas-ui-<view>\` would never distribute them and this gate would stay green: ${views.join(", ")}\n` +
        `Add a { item, view } row in scripts/sync-saas-ui-registry.mjs and create registry/<item>/registry.json.\n`,
    prefix: "lunora/saas-ui",
    src: join(ROOT, "packages", "saas-ui", "src"),
    stylesheet: "styles/saas-ui.css",
    syncCommand: "pnpm --filter @lunora/saas-ui sync:registry",
});

await sync.syncFrameworks();
sync.finish();
