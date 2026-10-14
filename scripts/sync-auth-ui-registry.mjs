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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "packages", "auth-ui", "src");
const REGISTRY = join(ROOT, "registry");

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

/**
 * Directories under `packages/auth-ui/src/` that are not a framework view. An
 * explicit list rather than a marker-file heuristic, for the same reason the SDK
 * scripts use one: a marker SKIPS what it does not match, so a seventh port that
 * forgot it would be absent from both this list and FRAMEWORKS — no drift, and
 * silently never mirrored into `registry/`.
 */
const NON_VIEW_SRC_DIRS = new Set(["core", "emails", "styles"]);

const declaredViews = new Set(FRAMEWORKS.map(({ view }) => view));
const viewDrift = readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NON_VIEW_SRC_DIRS.has(entry.name) && !declaredViews.has(entry.name))
    .map((entry) => entry.name);

if (viewDrift.length > 0) {
    process.stderr.write(
        `packages/auth-ui/src holds ${String(viewDrift.length)} view director(y|ies) with no FRAMEWORKS row, so \`lunora add auth-ui\`
` +
            `would never distribute them and this gate would stay green: ${viewDrift.join(", ")}
` +
            `Add a { item, view } row in scripts/sync-auth-ui-registry.mjs, create registry/<item>/registry.json, and
` +
            `teach detectAuthUiItem (packages/cli/src/commands/add/features.ts) to pick it.
`,
    );
    process.exit(1);
}

// Item-local files that are hand-authored (not synced from src) — kept as-is and
// still listed in files[].
const HAND_AUTHORED = new Set(["registry.json", "README.md", "client.ts"]);

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");

/** All files under `dir`, as paths relative to `dir` (posix, sorted). */
const walk = (dir, base = dir) => {
    if (!existsSync(dir)) {
        return [];
    }

    const out = [];

    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);

        if (statSync(full).isDirectory()) {
            out.push(...walk(full, base));
        } else {
            out.push(relative(base, full).split(/[/\\]/).join(posix.sep));
        }
    }

    return out.sort();
};

const pending = [];

/** Record an intended write; apply it now (write mode) or flag drift (check mode). */
const emit = (absolutePath, content) => {
    const current = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : undefined;

    if (current === content) {
        return;
    }

    pending.push(relative(ROOT, absolutePath));

    if (!CHECK) {
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, content);
    }
};

/** Copy one src tree into an item subdir, returning the item-relative file list. */
const syncTree = (srcDir, itemDir, subdir) => {
    const files = walk(srcDir);

    // Drop files that no longer exist in src. The sweep runs in BOTH modes: an
    // orphan is drift, and gating it on write mode made `--check` blind to the one
    // kind of staleness `emit` cannot see (it only compares files that still exist
    // in src). Check mode records the orphan instead of deleting it.
    const targetDir = join(itemDir, subdir);

    for (const existing of existsSync(targetDir) ? walk(targetDir) : []) {
        if (files.includes(existing)) {
            continue;
        }

        pending.push(relative(ROOT, join(targetDir, existing)));

        if (!CHECK) {
            rmSync(join(targetDir, existing));
        }
    }

    for (const file of files) {
        emit(join(itemDir, subdir, file), readFileSync(join(srcDir, file), "utf8"));
    }

    return files.map((file) => posix.join(subdir, file));
};

for (const { item, view } of FRAMEWORKS) {
    const itemDir = join(REGISTRY, item);
    const manifestPath = join(itemDir, "registry.json");

    if (!existsSync(manifestPath)) {
        throw new Error(`Missing ${relative(ROOT, manifestPath)} — create the registry item shell first.`);
    }

    // 1. Mirror the shared core + this framework's view layer + the stylesheet.
    const coreFiles = syncTree(join(SRC, "core"), itemDir, "core");
    const viewFiles = syncTree(join(SRC, view), itemDir, view);
    emit(join(itemDir, "styles.css"), readFileSync(join(SRC, "styles", "auth-ui.css"), "utf8"));

    // 2. Rebuild files[] = hand-authored item files + everything just synced.
    //    to = "lunora/auth-ui/" + from (a clean 1:1 prefix, no import rewriting).
    const synced = [...coreFiles, ...viewFiles, "styles.css"];
    const handAuthored = readdirSync(itemDir).filter((name) => HAND_AUTHORED.has(name) && name !== "registry.json" && name !== "README.md");
    const froms = [...handAuthored, ...synced].sort();

    const files = froms.map((from) => ({ from, merge: "create-or-skip", to: posix.join("lunora/auth-ui", from) }));

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Format through Prettier (repo config) so the generated manifest matches
    // repo style exactly — otherwise `prettier --check` and this `--check` would
    // disagree (Prettier collapses short arrays that JSON.stringify expands).
    const prettierOptions = await prettier.resolveConfig(manifestPath);
    const next = await prettier.format(JSON.stringify({ ...manifest, files }), { ...prettierOptions, parser: "json" });

    emit(manifestPath, next);
}

// The email templates are their own item: they are rendered by the Worker, not
// by any view layer, so they belong to every framework equally and to none of
// them in particular. Mirrored here anyway so the same drift check covers them —
// otherwise `src/emails/` and the registry copy diverge silently.
{
    const itemDir = join(REGISTRY, "auth-emails");
    const manifestPath = join(itemDir, "registry.json");

    if (!existsSync(manifestPath)) {
        throw new Error(`Missing ${relative(ROOT, manifestPath)} — create the registry item shell first.`);
    }

    emit(join(itemDir, "emails.tsx"), readFileSync(join(SRC, "emails", "index.tsx"), "utf8"));

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const files = [{ from: "emails.tsx", merge: "create-or-skip", to: "lunora/auth/emails.tsx" }];
    const prettierOptions = await prettier.resolveConfig(manifestPath);

    emit(manifestPath, await prettier.format(JSON.stringify({ ...manifest, files }), { ...prettierOptions, parser: "json" }));
}

if (CHECK && pending.length > 0) {
    process.stderr.write(`auth-ui registry is stale — run \`pnpm --filter @lunora/auth-ui sync:registry\`:\n${pending.map((p) => `  ${p}`).join("\n")}\n`);
    process.exit(1);
}

process.stdout.write(CHECK ? "auth-ui registry is up to date.\n" : `Synced auth-ui registry (${pending.length} file(s) changed).\n`);
