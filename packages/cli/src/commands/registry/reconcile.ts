/**
 * The file reconcile engine: `schema-extension` AST-merge and the lock-aware
 * `create-or-skip` 3-way upgrade (base = last-written hash, yours = on-disk,
 * theirs = incoming). `--diff` previews; `--overwrite` force-takes theirs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { dirname, join } from "@visulima/path";

import { insertSchemaExtension } from "../../util/insert-schema-extension";
import type { Logger } from "../../util/logger";
import type { RegistryLock } from "../../util/registry-lock";
import { hashContent, readLock, recordedHash, recordFile, writeLock } from "../../util/registry-lock";
import renderDiff from "../../util/text-diff";
import { applyItemResources } from "./apply";
import type { ReconcileOptions, ReconcileOutcome, RegistryFile, ResolvedItem } from "./types";

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
        writeFileSync(destinationPath, readFileSync(join(itemDirectory, file.from), "utf8"), "utf8");
    }

    const existingSchema = existsSync(schemaPath)
        ? readFileSync(schemaPath, "utf8")
        : 'import { defineSchema } from "@lunora/server";\n\nexport const schema = defineSchema({});\n';

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
        throw new Error(
            `schema-extension item "${itemKey}" is not a valid JS identifier — it is spliced into lunora/schema.ts as \`import { ${itemKey} }\` / \`.extend(${itemKey}.extension)\`. Rename the item to a valid identifier (no leading digit, no "-").`,
        );
    }

    throw new Error(`schema-extension merge failed for "${itemKey}": ${result.reason}`);
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
): ReconcileOutcome => {
    const destinationPath = join(projectRoot, file.to);
    const incoming = readFileSync(join(itemDirectory, file.from), "utf8");
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
): ReconcileOutcome => {
    if (file.merge === "schema-extension") {
        return reconcileSchemaExtension(file, itemKey, itemDirectory, projectRoot, logger, reconcileOptions.diff === true);
    }

    return reconcileWholeFile(file, itemKey, itemDirectory, projectRoot, logger, lock, reconcileOptions);
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

    // Sequential by design: reconciling lunora/schema.ts is read-modify-write,
    // so two items extending the schema must not interleave their edits.
    for (const { directory, manifest } of items) {
        for (const file of manifest.files) {
            const outcome = reconcileFile(file, manifest.name, directory, cwd, logger, lock, reconcileOptions);

            (outcome.kind === "written" ? written : skipped).push(outcome.path);
        }

        // --diff is a read-only preview: don't mutate package.json / wrangler / .dev.vars.
        if (reconcileOptions.diff) {
            continue;
        }

        const applied = applyItemResources(manifest, cwd, logger);

        depsAdded.push(...applied.deps);
        bindingsApplied.push(...applied.bindings);
    }

    // Persist the lock only once it has something to track — items that ship
    // nothing but a schema extension leave no whole-file provenance.
    if (!reconcileOptions.diff && Object.keys(lock.items).length > 0) {
        writeLock(cwd, lock);
    }

    return { bindings: bindingsApplied, deps: depsAdded, skipped, written };
};

export default reconcileItems;
