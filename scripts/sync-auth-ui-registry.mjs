#!/usr/bin/env node
/**
 * Sync the @lunora/auth-ui source-of-truth into the `auth-ui-*` registry items.
 *
 * The components are authored once in `packages/auth-ui/src` (where they
 * type-check + test against the real workspace deps). This script mirrors that
 * source verbatim into each `registry/auth-ui-<framework>/` payload and
 * regenerates each item's `registry.json` `files[]` array, so the copy that
 * `lunora add auth-ui` distributes never drifts from what's tested.
 *
 * The mirroring itself lives in `sync-ui-registry.mjs`, shared with the SaaS kit
 * family. What stays here is what only this family has: the framework table and
 * the `auth-emails` item.
 *
 * Layout in a consumer project (every file `create-or-skip`, user-owned):
 *   lunora/auth-ui/core/*        (framework-agnostic controllers — identical across frameworks)
 *   lunora/auth-ui/<view>/*      (react|vue|svelte|solid|angular view layer)
 *   lunora/auth-ui/styles.css
 *   lunora/auth/emails.tsx        (the auth-emails item — rendered server-side)
 *   lunora/auth-ui/client.ts     (hand-authored per item; the createAuthClient seam)
 *
 * Usage:
 *   node scripts/sync-auth-ui-registry.mjs           # write the payloads + manifests
 *   node scripts/sync-auth-ui-registry.mjs --check   # CI drift guard: fail if stale
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { createUiRegistrySync, ROOT } from "./sync-ui-registry.mjs";

const SRC = join(ROOT, "packages", "auth-ui", "src");

// Which registry item maps to which view directory under src/.
const FRAMEWORKS = [
    { item: "auth-ui-react", view: "react" },
    { item: "auth-ui-vue", view: "vue" },
    { item: "auth-ui-svelte", view: "svelte" },
    { item: "auth-ui-solid", view: "solid" },
    // The Solid 2 port is a separate item, not a variant of the one above: these
    // are copy-in source files, and the two majors' spellings are mutually
    // exclusive at the source level (`@solidjs/web` JSX, `onSettled`,
    // split-phase effects). `detectAuthUiItem` picks between them.
    { item: "auth-ui-solid-v2", view: "solid-v2" },
    { item: "auth-ui-angular", view: "angular" },
];

const sync = createUiRegistrySync({
    check: new Set(process.argv.slice(2)).has("--check"),
    frameworks: FRAMEWORKS,
    // Item-local files that are hand-authored (not synced from src) — kept as-is
    // and still listed in files[].
    handAuthored: new Set(["registry.json", "README.md", "client.ts"]),
    label: "auth-ui",
    nonViewDirectories: new Set(["core", "emails", "styles"]),
    onViewDrift: (views) =>
        `packages/auth-ui/src holds ${String(views.length)} view director(y|ies) with no FRAMEWORKS row, so \`lunora add auth-ui\`\n` +
        `would never distribute them and this gate would stay green: ${views.join(", ")}\n` +
        `Add a { item, view } row in scripts/sync-auth-ui-registry.mjs, create registry/<item>/registry.json, and\n` +
        `teach detectAuthUiItem (packages/cli/src/commands/add/features.ts) to pick it.\n`,
    prefix: "lunora/auth-ui",
    src: SRC,
    stylesheet: "styles/auth-ui.css",
    syncCommand: "pnpm --filter @lunora/auth-ui sync:registry",
});

await sync.syncFrameworks();

/*
 * The email templates are their own item: they are rendered by the Worker, not
 * by any view layer, so they belong to every framework equally and to none of
 * them in particular. Mirrored here anyway so the same drift check covers them —
 * otherwise `src/emails/` and the registry copy diverge silently.
 */
{
    const itemDir = join(sync.registryRoot, "auth-emails");
    const manifestPath = join(itemDir, "registry.json");

    if (!existsSync(manifestPath)) {
        throw new Error(`Missing ${relative(ROOT, manifestPath)} — create the registry item shell first.`);
    }

    sync.emit(join(itemDir, "emails.tsx"), readFileSync(join(SRC, "emails", "index.tsx"), "utf8"));
    await sync.writeManifest(manifestPath, [{ from: "emails.tsx", merge: "create-or-skip", to: "lunora/auth/emails.tsx" }]);
}

sync.finish();
