/**
 * The shared engine behind `sync-auth-ui-registry.mjs` and
 * `sync-saas-ui-registry.mjs`.
 *
 * Both families have the same shape: a `private: true` package holds the source
 * of truth (where it type-checks and tests against real workspace deps), and one
 * registry item per framework distributes a verbatim copy of `core/` plus that
 * framework's view layer. This module owns the mirroring, the orphan sweep, the
 * `files[]` regeneration and the `--check` drift guard; each caller supplies the
 * paths and the framework table.
 *
 * It exists because a second family exists — `auth-ui` alone did not justify the
 * indirection, and `CLAUDE.md` says as much. What it deliberately does NOT
 * absorb is anything one family has and the other does not (auth's `emails`
 * item, say): a caller keeps its own special cases, because folding a
 * one-of-a-kind branch in here is how a shared engine turns into a config
 * language.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "registry");

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

/**
 * Create a run bound to one family. Returns the primitives a caller needs for
 * its own special cases (`emit`, `writeManifest`) plus `syncFrameworks`, which
 * does the whole standard pass, and `finish`, which reports.
 * @param {object} options
 * @param {boolean} options.check Drift-guard mode: record staleness, write nothing.
 * @param {{item: string, view: string}[]} options.frameworks Item ⇄ view-directory table.
 * @param {Set<string>} [options.handAuthored] Item-local files kept as-is and still listed in `files[]`.
 * @param {string} options.label Family name used in messages (e.g. `"auth-ui"`).
 * @param {string} options.prefix Destination prefix in a consumer project (e.g. `"lunora/auth-ui"`).
 * @param {string} options.src Absolute path to the package's `src/`.
 * @param {string} options.stylesheet Path of the stylesheet under `src/`, relative and posix.
 * @param {string} options.syncCommand The command a stale check tells the reader to run.
 * @param {(views: string[]) => string} options.onViewDrift Message for view dirs with no table row.
 * @param {Set<string>} [options.nonViewDirectories] `src/` directories that are not framework views.
 */
const createUiRegistrySync = (options) => {
    const {
        check,
        frameworks,
        handAuthored = new Set(),
        label,
        nonViewDirectories = new Set(["core", "styles"]),
        onViewDrift,
        prefix,
        src,
        stylesheet,
        syncCommand,
    } = options;
    const pending = [];

    /*
     * A view directory with no table row would never be distributed, and this
     * gate would stay green while it happened — so the drift check is on the
     * declared list rather than a marker file, which would SKIP what it does not
     * match instead of failing on it.
     */
    const declared = new Set(frameworks.map((entry) => entry.view));
    const drift = readdirSync(src, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !nonViewDirectories.has(entry.name) && !declared.has(entry.name))
        .map((entry) => entry.name);

    if (drift.length > 0) {
        process.stderr.write(onViewDrift(drift));
        process.exit(1);
    }

    /** Record an intended write; apply it now (write mode) or flag drift (check mode). */
    const emit = (absolutePath, content) => {
        const current = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : undefined;

        if (current === content) {
            return;
        }

        pending.push(relative(ROOT, absolutePath));

        if (!check) {
            mkdirSync(dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, content);
        }
    };

    /** Copy one src tree into an item subdir, returning the item-relative file list. */
    const syncTree = (srcDir, itemDir, subdir) => {
        const files = walk(srcDir);

        /*
         * Drop files that no longer exist in src. The sweep runs in BOTH modes: an
         * orphan is drift, and gating it on write mode made `--check` blind to the
         * one kind of staleness `emit` cannot see (it only compares files that
         * still exist in src). Check mode records the orphan instead of deleting it.
         */
        const targetDir = join(itemDir, subdir);

        for (const existing of existsSync(targetDir) ? walk(targetDir) : []) {
            if (files.includes(existing)) {
                continue;
            }

            pending.push(relative(ROOT, join(targetDir, existing)));

            if (!check) {
                rmSync(join(targetDir, existing));
            }
        }

        for (const file of files) {
            emit(join(itemDir, subdir, file), readFileSync(join(srcDir, file), "utf8"));
        }

        return files.map((file) => posix.join(subdir, file));
    };

    /**
     * Rewrite an item's manifest with a regenerated `files[]`, formatted through
     * Prettier (repo config) so the generated manifest matches repo style
     * exactly — otherwise `prettier --check` and this `--check` would disagree
     * (Prettier collapses short arrays that `JSON.stringify` expands).
     */
    const writeManifest = async (manifestPath, files) => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const prettierOptions = await prettier.resolveConfig(manifestPath);

        emit(manifestPath, await prettier.format(JSON.stringify({ ...manifest, files }), { ...prettierOptions, parser: "json" }));
    };

    /** The standard pass: mirror core + each view + the stylesheet, then rebuild every manifest. */
    const syncFrameworks = async () => {
        for (const { item, view } of frameworks) {
            const itemDir = join(REGISTRY, item);
            const manifestPath = join(itemDir, "registry.json");

            if (!existsSync(manifestPath)) {
                throw new Error(`Missing ${relative(ROOT, manifestPath)} — create the registry item shell first.`);
            }

            const coreFiles = syncTree(join(src, "core"), itemDir, "core");
            const viewFiles = syncTree(join(src, view), itemDir, view);

            emit(join(itemDir, "styles.css"), readFileSync(join(src, stylesheet), "utf8"));

            // files[] = hand-authored item files + everything just synced.
            // to = `${prefix}/${from}` — a clean 1:1 prefix, no import rewriting.
            const synced = [...coreFiles, ...viewFiles, "styles.css"];
            const local = readdirSync(itemDir).filter((name) => handAuthored.has(name) && name !== "registry.json" && name !== "README.md");
            const froms = [...local, ...synced].sort();

            await writeManifest(
                manifestPath,
                froms.map((from) => ({ from, merge: "create-or-skip", to: posix.join(prefix, from) })),
            );
        }
    };

    /** Report, and exit non-zero when `--check` found drift. */
    const finish = () => {
        if (check && pending.length > 0) {
            process.stderr.write(`${label} registry is stale — run \`${syncCommand}\`:\n${pending.map((path) => `  ${path}`).join("\n")}\n`);
            process.exit(1);
        }

        process.stdout.write(check ? `${label} registry is up to date.\n` : `Synced ${label} registry (${pending.length} file(s) changed).\n`);
    };

    return { emit, finish, registryRoot: REGISTRY, syncFrameworks, writeManifest };
};

export { createUiRegistrySync, ROOT };
