/**
 * The file reconcile engine: `schema-extension` AST-merge and the lock-aware
 * `create-or-skip` 3-way upgrade (base = last-written hash, yours = on-disk,
 * theirs = incoming). `--diff` previews; `--overwrite` force-takes theirs.
 *
 * Also handles `entrypointReexports` — injecting `export * from "./lunora/<module>"`
 * into the class-B/C worker entry file.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";
import { LunoraError } from "@lunora/errors";
import { dirname, join, relative } from "@visulima/path";

import { insertSchemaExtension } from "../../util/insert-schema-extension";
import type { Logger } from "../../util/logger";
import type { RegistryLock } from "../../util/registry-lock";
import { hashContent, readLock, recordedHash, recordFile, writeLock } from "../../util/registry-lock";
import renderDiff from "../../util/text-diff";
import { applyItemResources, projectUsesUmbrella, rewriteUmbrellaImports } from "./apply";
import type { EntrypointReexport, ReconcileOptions, ReconcileOutcome, RegistryFile, ResolvedItem } from "./types";

/** Code files whose `@lunora/*` base imports are rewritten to `lunorash/*` for umbrella projects. */
const CODE_FILE_RE = /\.[cm]?[jt]sx?$/u;

/**
 * Read an item's source file, rewriting base `@lunora/*` imports to the
 * `lunorash/*` umbrella subpaths when the target project uses the umbrella and
 * the file is code. Non-umbrella projects (and non-code files) get the bytes
 * verbatim. Centralizes the read so the written content and the lock hash are
 * always the post-rewrite form (3-way upgrades stay consistent across runs).
 *
 * Refuses to read through a symlink: a hostile registry source could ship a
 * symlink at a manifest-declared `file.from` path and have the CLI read
 * through it — printing (`view`) or writing into the project (`add`) whatever
 * host file the link targets, e.g. `~/.ssh/id_rsa`. Registry manifests declare
 * each file explicitly, so refusing (rather than `init`'s silent skip) is
 * correct here: skipping would silently produce a broken install.
 *
 * Exported so `registry view` reads item files through the same guard — a
 * pasted copy of it drifted from this one once already.
 */
const readItemFile = (itemDirectory: string, file: RegistryFile, useUmbrella: boolean, itemKey: string): string => {
    const sourcePath = join(itemDirectory, file.from);

    if (lstatSync(sourcePath).isSymbolicLink()) {
        throw new LunoraError("INTERNAL", `registry item "${itemKey}": refusing to read "${file.from}" — it is a symlink, not a regular file`);
    }

    const source = readFileSync(sourcePath, "utf8");

    return useUmbrella && CODE_FILE_RE.test(file.to) ? rewriteUmbrellaImports(source) : source;
};

/**
 * Reconcile a `schema-extension` file: copy the extension source (if absent)
 * and AST-merge the item's `.extend(...)` into `lunora/schema.ts`. In diff
 * mode, just describe the intended merge.
 */
const reconcileSchemaExtension = (
    file: RegistryFile,
    itemKey: string,
    itemDirectory: string,
    projectRoot: string,
    logger: Logger,
    diff: boolean,
    useUmbrella: boolean,
): ReconcileOutcome => {
    const schemaPath = join(projectRoot, "lunora", "schema.ts");

    if (diff) {
        logger.info(`~ would merge .extend(${itemKey}.extension) into lunora/schema.ts (and create ${file.to} if absent)`);

        return { kind: "skipped", path: schemaPath };
    }

    // The item's `to` points at where its extension *source* lives; copy that
    // (create-if-absent) AND wire it into the shared lunora/schema.ts.
    const destinationPath = join(projectRoot, file.to);

    if (!existsSync(destinationPath)) {
        mkdirSync(dirname(destinationPath), { recursive: true });
        writeFileSync(destinationPath, readItemFile(itemDirectory, file, useUmbrella, itemKey), "utf8");
    }

    const baseModule = useUmbrella ? "lunorash/server" : "@lunora/server";
    const existingSchema = existsSync(schemaPath)
        ? readFileSync(schemaPath, "utf8")
        : `import { defineSchema } from "${baseModule}";\n\nexport const schema = defineSchema({});\n`;

    const result = insertSchemaExtension(existingSchema, itemKey);

    if (result.ok) {
        mkdirSync(dirname(schemaPath), { recursive: true });
        writeFileSync(schemaPath, result.text, "utf8");
        logger.success(`merged .extend(${itemKey}.extension) into lunora/schema.ts`);

        return { kind: "written", path: schemaPath };
    }

    if (result.reason === "already-applied") {
        logger.warn(`lunora/schema.ts already extends "${itemKey}" — skipping`);

        return { kind: "skipped", path: schemaPath };
    }

    if (result.reason === "invalid-identifier") {
        throw new LunoraError(
            "INTERNAL",
            `schema-extension item "${itemKey}" is not a valid JS identifier — it is spliced into lunora/schema.ts as \`import { ${itemKey} }\` / \`.extend(${itemKey}.extension)\`. Rename the item to a valid identifier (no leading digit, no "-").`,
        );
    }

    throw new LunoraError("INTERNAL", `schema-extension merge failed for "${itemKey}": ${result.reason}`);
};

/** Print a `--diff` preview for one whole-file destination; writes nothing. */
const previewWholeFile = (file: RegistryFile, current: string, incoming: string, exists: boolean, logger: Logger): void => {
    const lines = renderDiff(current, incoming);

    if (lines.length === 0) {
        logger.info(`= ${file.to} (unchanged)`);

        return;
    }

    logger.info(`${exists ? "~" : "+"} ${file.to}`);

    for (const line of lines) {
        logger.info(`    ${line}`);
    }
};

/**
 * Reconcile a `create-or-skip` whole file via the lock-aware 3-way rule.
 * `--diff` previews; `--overwrite` force-takes theirs.
 */
const reconcileWholeFile = (
    file: RegistryFile,
    itemKey: string,
    itemDirectory: string,
    projectRoot: string,
    logger: Logger,
    lock: RegistryLock,
    reconcileOptions: ReconcileOptions,
    useUmbrella: boolean,
): ReconcileOutcome => {
    const destinationPath = join(projectRoot, file.to);
    const incoming = readItemFile(itemDirectory, file, useUmbrella, itemKey);
    const exists = existsSync(destinationPath);
    const current = exists ? readFileSync(destinationPath, "utf8") : "";

    const write = (message: string): ReconcileOutcome => {
        mkdirSync(dirname(destinationPath), { recursive: true });
        writeFileSync(destinationPath, incoming, "utf8");
        recordFile(lock, itemKey, file.to, incoming);
        logger.success(`${message}: ${file.to}`);

        return { kind: "written", path: destinationPath };
    };

    if (reconcileOptions.diff) {
        previewWholeFile(file, current, incoming, exists, logger);

        return { kind: "skipped", path: destinationPath };
    }

    if (!exists) {
        return write("write");
    }

    const currentHash = hashContent(current);

    if (currentHash === hashContent(incoming)) {
        // Already byte-identical — record provenance (in case it was untracked) and skip.
        recordFile(lock, itemKey, file.to, incoming);
        logger.warn(`skip (exists): ${file.to}`);

        return { kind: "skipped", path: destinationPath };
    }

    if (reconcileOptions.overwrite) {
        return write("overwrite");
    }

    const base = recordedHash(lock, itemKey, file.to);

    if (base === undefined) {
        // No provenance — leave a file `add` never wrote untouched.
        logger.warn(`skip (exists, untracked): ${file.to} — refusing to overwrite a file lunora didn't add (use --overwrite to force)`);

        return { kind: "skipped", path: destinationPath };
    }

    if (base === currentHash) {
        // Unedited since the last add → a clean upgrade.
        return write("update");
    }

    if (base === hashContent(incoming)) {
        // Only the user changed it; upstream is exactly what they started from.
        // A `.new` here would just be a copy of their pre-edit file — pure noise
        // on every re-add, and the conflict warning below would be a lie.
        logger.warn(`skip (locally edited): ${file.to}`);

        return { kind: "skipped", path: destinationPath };
    }

    // Changed on both sides — never clobber; drop the incoming copy for manual merge.
    writeFileSync(`${destinationPath}.new`, incoming, "utf8");
    logger.warn(`conflict: ${file.to} has local edits and an upstream update — wrote ${file.to}.new (use --overwrite to take theirs)`);

    return { kind: "skipped", path: destinationPath };
};

/**
 * Reconcile one file into the project. `create-or-skip` writes whole files
 * (lock-aware upgrades); `schema-extension` AST-merges into `lunora/schema.ts`.
 */
const reconcileFile = (
    file: RegistryFile,
    itemKey: string,
    itemDirectory: string,
    projectRoot: string,
    logger: Logger,
    lock: RegistryLock,
    reconcileOptions: ReconcileOptions = {},
    useUmbrella = false,
): ReconcileOutcome => {
    if (file.merge === "schema-extension") {
        return reconcileSchemaExtension(file, itemKey, itemDirectory, projectRoot, logger, reconcileOptions.diff === true, useUmbrella);
    }

    return reconcileWholeFile(file, itemKey, itemDirectory, projectRoot, logger, lock, reconcileOptions, useUmbrella);
};

/**
 * Conventional worker-entry locations probed when wrangler `main` doesn't
 * resolve. Mirrors `.vis/templates/_helpers/wire-worker-entry.ts` (the
 * scaffolder's own candidate order) and, past that, the additional
 * `src/server/index.tsx` candidate `@lunora/config`'s (binding-inference)
 * `resolveWorkerEntry` also probes — kept in sync by hand since sharing a
 * single exported constant would mean changing `@lunora/config`'s resolver
 * surface, which is out of scope here.
 */
const WORKER_ENTRY_FALLBACKS = ["src/server.ts", "src/server/index.ts", "src/server/index.tsx", "src/index.ts", "src/worker.ts"];

/**
 * Read wrangler `main` via `@lunora/config`'s comment-safe JSONC reader
 * (`findWranglerFile` + `readWranglerJsonc`) — real JSONC parsing, so a
 * commented-out `"main"` (or one inside a string) is correctly ignored,
 * unlike a regex match against the raw file text.
 */
const readWranglerMain = (projectRoot: string): string | undefined => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (wranglerPath === undefined) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<{ main?: string }>(wranglerPath);

    return typeof parsed?.main === "string" ? parsed.main : undefined;
};

/**
 * Find the class-B/C worker entry file (the file calling `createShardDO`).
 * Returns `{ entryPath, source }` or `undefined` when class-A / not found.
 *
 * Probes every candidate — a fallback guess lacking the marker just means
 * "not the entry", so it must not stop the search (a marker-less
 * `src/server.ts` existing alongside a real `src/index.ts` entry must still
 * resolve to `src/index.ts`). Only the wrangler-*declared* `main` lacking the
 * marker is a decisive signal (it names the actual worker entry, so a
 * fallback guess can't override it) — that alone stops the search early.
 */
const findWorkerEntry = (projectRoot: string): { entryPath: string; main: string; source: string } | undefined => {
    const main = readWranglerMain(projectRoot);
    const candidates = main === undefined ? WORKER_ENTRY_FALLBACKS : [main, ...WORKER_ENTRY_FALLBACKS];

    for (const candidate of candidates) {
        const absolute = join(projectRoot, candidate);

        if (!existsSync(absolute)) {
            continue;
        }

        const content = readFileSync(absolute, "utf8");

        // Only touch class-B/C workers (contain `createShardDO(`).
        if (!content.includes("createShardDO(")) {
            if (candidate === main) {
                break;
            }

            continue;
        }

        return { entryPath: absolute, main: candidate, source: content };
    }

    return undefined;
};

/**
 * Compute the relative import specifier from a worker entry file to
 * `lunora/<module>`. E.g. for `src/server/index.ts` the result is
 * `../../lunora/<module>`.
 */
const computeRelativeSpecifier = (entryPath: string, projectRoot: string, moduleName: string): string => {
    const importPath = relative(dirname(entryPath), join(projectRoot, "lunora", moduleName)).replaceAll("\\", "/");

    return importPath.startsWith(".") ? importPath : `./${importPath}`;
};

/**
 * Log instructions for class-A projects where entrypoint re-exports must be
 * added by hand. Returns 0 (no re-exports injected).
 */
const logClassAFallback = (entrypointReexports: ReadonlyArray<EntrypointReexport>, logger: Logger): 0 => {
    for (const reexport of entrypointReexports) {
        // Class-A fallback cannot know the worker entry path, so show the
        // project-root-relative specifier as a clear starting point.
        const specifier = `./lunora/${reexport.module}.js`;
        const instruction = `Add \`export * from "${specifier}"\` to your worker entry`;
        const suffix = reexport.comment ? ` (${reexport.comment})` : "";

        logger.warn(`${instruction}${suffix}`);
    }

    return 0;
};

/** Build the re-export lines to append, skipping modules already present. */
const buildReexportLines = (entrypointReexports: ReadonlyArray<EntrypointReexport>, entryPath: string, projectRoot: string, source: string): string[] => {
    const lines: string[] = [];

    for (const reexport of entrypointReexports) {
        const specifier = computeRelativeSpecifier(entryPath, projectRoot, reexport.module);
        const escapedSpecifier = specifier.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
        // Quote-bounded exact match so a longer path (e.g. `../../lunora/foo-bar`)
        // is not mistaken for an existing `../../lunora/foo` re-export.
        const existingRe = new RegExp(String.raw`export\s+\*\s+from\s+["']${escapedSpecifier}\.js["']`, "u");

        if (existingRe.test(source)) {
            continue;
        }

        if (reexport.comment) {
            lines.push(`\n// ${reexport.comment}`);
        }

        // Generated code uses `.js` extension (NodeNext).
        lines.push(`export * from "${specifier}.js";`);
    }

    return lines;
};

/**
 * Apply an item's declared entrypoint re-exports: inject `export * from
 * "./lunora/<module>"` lines into the class-B/C worker entry (the file that
 * calls `createShardDO`). For class-A (Vite plugin / no such file), log a
 * post-add instruction instead. Idempotent — skips a module whose re-export
 * already exists.
 *
 * Returns the number of re-export lines injected, or 0 when class-A / none.
 */
const applyEntrypointReexports = (entrypointReexports: ReadonlyArray<EntrypointReexport>, projectRoot: string, logger: Logger, diff: boolean): number => {
    if (entrypointReexports.length === 0) {
        return 0;
    }

    const entry = findWorkerEntry(projectRoot);

    if (entry === undefined) {
        return logClassAFallback(entrypointReexports, logger);
    }

    const linesToAppend = buildReexportLines(entrypointReexports, entry.entryPath, projectRoot, entry.source);

    if (linesToAppend.length === 0) {
        return 0;
    }

    if (diff) {
        for (const line of linesToAppend) {
            if (line !== "") {
                logger.info(`~ entrypoint: ${line}`);
            }
        }

        return linesToAppend.length;
    }

    const separator = entry.source.endsWith("\n") ? "" : "\n";

    writeFileSync(entry.entryPath, `${entry.source}${separator}${linesToAppend.join("\n")}\n`, "utf8");
    logger.success(`wrote ${String(linesToAppend.length)} entrypoint re-export(s) to ${relative(projectRoot, entry.entryPath)}`);

    return linesToAppend.length;
};

/** Run the reconcile phase across every resolved item; returns the aggregate outcome. */
const reconcileItems = (
    items: ReadonlyArray<ResolvedItem>,
    cwd: string,
    logger: Logger,
    reconcileOptions: ReconcileOptions = {},
): { bindings: string[]; deps: string[]; skipped: string[]; written: string[] } => {
    const written: string[] = [];
    const skipped: string[] = [];
    const depsAdded: string[] = [];
    const bindingsApplied: string[] = [];

    // The whole-file reconcile lock (records last-written hashes for the 3-way
    // upgrade check). Read once, mutated as files are reconciled, persisted below.
    const lock = readLock(cwd);

    // Route base-package deps + imports through the `lunorash` umbrella when the
    // target project depends on it, so an add never reintroduces a granular
    // `@lunora/server` next to the umbrella's copy. Detected once per run.
    const useUmbrella = projectUsesUmbrella(cwd);

    // Sequential by design: reconciling lunora/schema.ts is read-modify-write,
    // so two items extending the schema must not interleave their edits.
    //
    // `finally`, not a trailing statement: a throw part-way down the plan
    // (an unreadable source file, a symlinked item) still leaves every file
    // written before it on disk. Discarding the lock there recorded no
    // provenance for them, so the next run saw an untracked file it "didn't
    // add" and refused — permanently, short of `--overwrite` (which discards
    // local edits) or hand-editing the lock.
    try {
        for (const { directory, manifest } of items) {
            for (const file of manifest.files) {
                const outcome = reconcileFile(file, manifest.name, directory, cwd, logger, lock, reconcileOptions, useUmbrella);

                (outcome.kind === "written" ? written : skipped).push(outcome.path);
            }

            // Entrypoint re-exports must be shown in diff mode too (before the
            // "skip resources" guard), since they modify a source file.
            if (manifest.entrypointReexports !== undefined) {
                applyEntrypointReexports(manifest.entrypointReexports, cwd, logger, reconcileOptions.diff === true);
            }

            // --diff is a read-only preview: don't mutate package.json / wrangler / .dev.vars.
            if (reconcileOptions.diff) {
                continue;
            }

            const applied = applyItemResources(manifest, cwd, logger, useUmbrella);

            depsAdded.push(...applied.deps);
            bindingsApplied.push(...applied.bindings);
        }
    } finally {
        // Persist the lock only once it has something to track — items that ship
        // nothing but a schema extension leave no whole-file provenance.
        if (!reconcileOptions.diff && Object.keys(lock.items).length > 0) {
            writeLock(cwd, lock);
        }
    }

    return { bindings: bindingsApplied, deps: depsAdded, skipped, written };
};

export { readItemFile, reconcileItems };
