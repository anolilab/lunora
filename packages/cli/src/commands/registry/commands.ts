/**
 * The four registry command orchestrators — thin shells over the manifest /
 * resolve / reconcile / apply / catalog modules: `add`, `list`, `view`, and
 * `build`. Plus the small plan/report renderers they share.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "@visulima/path";

import { detectPackageManager, installArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import { confirmDepMutation, resolveDepRange } from "./apply";
import { buildRegistryIndex, collectCatalog } from "./catalog";
import { safe, safeLine } from "./display";
import { readItemFile, reconcileItems } from "./reconcile";
import { readManifest, resolveItemDirectory, resolvePlan, resolveRegistryRoot, sourceGateError } from "./resolve";
import type { AddCommandOptions, AddCommandResult, RegistryManifest } from "./types";
import { emptyResult } from "./types";

/** Render the human-readable plan for one item. */
const printPlan = (logger: Logger, manifest: RegistryManifest): void => {
    const label = manifest.title ?? manifest.description;

    logger.info(`plan: ${safeLine(manifest.name)}${label ? ` — ${safeLine(label)}` : ""}`);

    for (const file of manifest.files) {
        logger.info(`  file  ${safeLine(file.to)}  (${safeLine(file.merge)})`);
    }

    // Show the range that will actually be WRITTEN, not the manifest's internal
    // one. Registry manifests pin siblings with `workspace:*` so development
    // resolves to the local checkout, but that protocol is meaningless in a
    // consumer's package.json — printing it raw made the plan look like it was
    // about to break `pnpm install`.
    // `resolveDepRange` resolves the CLI's dist-tag for every bare `workspace:`
    // specifier, so it is memoised across the whole plan rather than re-resolved
    // per dependency line.
    const renderedRange = new Map<string, string>();
    const rangeFor = (range: string): string => {
        const cached = renderedRange.get(range);

        if (cached !== undefined) {
            return cached;
        }

        const resolved = resolveDepRange(range);

        renderedRange.set(range, resolved);

        return resolved;
    };

    for (const [dep, range] of Object.entries(manifest.deps ?? {})) {
        logger.info(`  dep   ${safeLine(dep)}@${safeLine(rangeFor(range))}`);
    }

    for (const [dep, range] of Object.entries(manifest.devDependencies ?? {})) {
        logger.info(`  dev   ${safeLine(dep)}@${safeLine(rangeFor(range))}`);
    }

    for (const binding of manifest.bindings ?? []) {
        // Render the concrete value so a reviewer can audit what gets written into
        // wrangler.jsonc (e.g. an attempt to set an exec/entrypoint key) before it
        // is applied — a bare key path hides the payload.
        // `JSON.stringify` escapes control bytes but NOT the BIDI overrides that
        // reorder the rendered line, so the serialized value is sanitized too.
        logger.info(`  bind  ${safeLine(binding.path.join("."))} = ${safeLine(JSON.stringify(binding.value))}`);
    }

    for (const variable of manifest.envVars ?? []) {
        // Show non-secret values; secrets are scaffolded as empty placeholders so
        // there is nothing to leak.
        const valueSuffix = variable.secret ? " (secret)" : ` = ${safeLine(JSON.stringify(variable.value ?? ""))}`;

        logger.info(`  env   ${safeLine(variable.name)}${valueSuffix}`);
    }

    for (const reexport of manifest.entrypointReexports ?? []) {
        const specifier = `./lunora/${safeLine(reexport.module)}`;
        const suffix = reexport.comment ? `  // ${safeLine(reexport.comment)}` : "";

        logger.info(`  entry ${specifier}${suffix}`);
    }
};

/** Emit the `--json` plan snapshot for the resolved items to stdout. */
const printJsonPlan = (items: ReadonlyArray<{ manifest: RegistryManifest }>): void => {
    const planSnapshot = items.map(({ manifest }) => {
        return {
            // Include the concrete value so a JSON-plan consumer can audit the
            // mutation (not just the key path) before it is applied.
            bindings: (manifest.bindings ?? []).map((binding) => {
                return { path: binding.path.join("."), value: binding.value };
            }),
            deps: Object.keys(manifest.deps ?? {}),
            devDependencies: Object.keys(manifest.devDependencies ?? {}),
            entrypointReexports: (manifest.entrypointReexports ?? []).map((reexport) => {
                return { module: reexport.module, ...(reexport.comment ? { comment: reexport.comment } : {}) };
            }),
            envVars: (manifest.envVars ?? []).map((variable) => {
                return { name: variable.name, ...(variable.secret ? { secret: true } : { value: variable.value ?? "" }) };
            }),
            files: manifest.files.map((file) => {
                return { merge: file.merge, to: file.to };
            }),
            name: manifest.name,
            requires: manifest.requires ?? [],
            title: manifest.title,
        };
    });

    process.stdout.write(`${JSON.stringify({ items: planSnapshot }, undefined, 2)}\n`);
};

/**
 * The copy-pastable "install what was just added" command for `cwd`'s project.
 * `deps` are already written into package.json by `reconcileItems` — this is a
 * plain re-install, not an add, so it goes through `installArgsFor`, not
 * `addArgsFor`. Falls back to a manager-neutral placeholder when
 * `detectPackageManager` itself can't resolve one.
 */
const installHint = (cwd: string): string => {
    try {
        const { args, command } = installArgsFor(detectPackageManager(cwd));

        return `${command} ${args.join(" ")}`;
    } catch {
        return "<your-package-manager> install";
    }
};

/** Print the post-reconcile report: summary, next steps, and per-item `docs` guidance. */
const reportAddResult = (
    items: ReadonlyArray<{ manifest: RegistryManifest }>,
    deps: ReadonlyArray<string>,
    written: number,
    skipped: number,
    logger: Logger,
    cwd: string,
): void => {
    logger.success(`add complete: ${String(written)} written, ${String(skipped)} skipped`);
    logger.info("next steps:");
    logger.info("  lunora codegen   # regenerate _generated/ so the new tables/functions appear");

    if (deps.length > 0) {
        logger.info(`  ${installHint(cwd)}  # install newly-added dependencies`);
    }

    for (const { manifest } of items) {
        if (manifest.docs) {
            logger.info(`${safeLine(manifest.name)}: ${safeLine(manifest.docs)}`);
        }
    }
};

/** `lunora registry list`: enumerate available registry items (local `--from` or remote). */
const runListCommand = async (options: AddCommandOptions): Promise<AddCommandResult> => {
    const empty = emptyResult();
    const gate = sourceGateError("list", options);

    if (gate) {
        options.logger.error(gate);

        return { ...empty, code: 1 };
    }

    let cleanup: () => void = () => {};

    try {
        const resolved = await resolveRegistryRoot(options);

        cleanup = resolved.cleanup;

        const items = collectCatalog(resolved.root);

        if (options.json) {
            process.stdout.write(`${JSON.stringify(items, undefined, 2)}\n`);

            return empty;
        }

        options.logger.info(`available registry items (${String(items.length)}):`);

        for (const item of items) {
            options.logger.info(`  ${item.name}${item.description ? ` — ${item.description}` : ""}`);
        }

        return empty;
    } catch (error) {
        // The message can quote the untrusted manifest back (a rejected env-var
        // name, a bad path), so it is sanitized like every other render site.
        options.logger.error(safe(`list failed: ${error instanceof Error ? error.message : String(error)}`));

        return { ...empty, code: 1 };
    } finally {
        cleanup();
    }
};

/** `lunora registry add` (one or more item names): scaffold items into the project. */
const runAddCommand = async (options: AddCommandOptions): Promise<AddCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const empty = emptyResult();

    if (options.list) {
        return runListCommand(options);
    }

    if (options.names.length === 0) {
        options.logger.error("add requires at least one item name. Usage: lunora registry add <name> [...names]");

        return { ...empty, code: 1 };
    }

    const gate = sourceGateError("add", options);

    if (gate) {
        options.logger.error(gate);

        return { ...empty, code: 1 };
    }

    let cleanups: (() => void)[] = [];

    try {
        const { cleanups: planCleanups, items: resolvedItems } = await resolvePlan(options.names, options);

        cleanups = planCleanups;

        // Let the caller inject user-chosen values into the static manifests (e.g.
        // the R2 bucket_name the init storage prompt asks for) before anything is
        // printed or written, so the plan preview and the wrangler edits agree.
        const { transformManifest } = options;
        const items = transformManifest
            ? resolvedItems.map((item) => {
                  return { ...item, manifest: transformManifest(item.manifest) };
              })
            : resolvedItems;

        // --- Plan ---
        for (const { manifest } of items) {
            printPlan(options.logger, manifest);
        }

        if (options.json) {
            printJsonPlan(items);
        }

        if (options.dryRun) {
            options.logger.info("dry-run: stopping before any files are written");

            return empty;
        }

        // --- Diff preview: show file-level changes, mutate nothing ---
        if (options.diff) {
            reconcileItems(items, cwd, options.logger, { diff: true });
            options.logger.info("diff: preview only — re-run without --diff to apply");

            return empty;
        }

        // --- Confirm package.json mutation (if any item adds deps) ---
        if (!(await confirmDepMutation(items, options))) {
            return { ...empty, code: 1 };
        }

        // --- Reconcile ---
        const { bindings, deps, skipped, written } = reconcileItems(items, cwd, options.logger, { overwrite: options.overwrite });

        reportAddResult(items, deps, written.length, skipped.length, options.logger, cwd);

        return { bindings, code: 0, deps, skipped, written };
    } catch (error) {
        // The message can quote the untrusted manifest back (a rejected env-var
        // name, a bad path), so it is sanitized like every other render site.
        options.logger.error(safe(`add failed: ${error instanceof Error ? error.message : String(error)}`));

        return { ...empty, code: 1 };
    } finally {
        for (const cleanup of cleanups) {
            cleanup();
        }
    }
};

/**
 * `lunora registry view` — inspect a registry item without installing it:
 * print its plan (files / deps / env vars) followed by the full contents of each
 * file it would scaffold. Resolves only the named item — no `requires` expansion.
 */
const runRegistryViewCommand = async (options: AddCommandOptions): Promise<AddCommandResult> => {
    const empty = emptyResult();

    if (options.names.length === 0) {
        options.logger.error("view requires an item name. Usage: lunora registry view <name>");

        return { ...empty, code: 1 };
    }

    const gate = sourceGateError("view", options);

    if (gate) {
        options.logger.error(gate);

        return { ...empty, code: 1 };
    }

    const cleanups: (() => void)[] = [];

    try {
        for (const name of options.names) {
            // eslint-disable-next-line no-await-in-loop -- each item is fetched + printed before the next; cleanup ordering depends on it
            const { cleanup, directory } = await resolveItemDirectory(name, options);

            cleanups.push(cleanup);

            const manifest = readManifest(directory, name);

            printPlan(options.logger, manifest);

            for (const file of manifest.files) {
                options.logger.info(`--- ${safe(file.to)} (${safe(file.merge)}) ---`);

                // Shared with `add` so both read paths carry the same symlink
                // refusal. `useUmbrella: false` — `view` shows the item's source
                // verbatim, not the per-project umbrella rewrite `add` writes.
                const content = readItemFile(directory, file, false, name);

                for (const line of content.split("\n")) {
                    options.logger.info(safe(line));
                }
            }
        }

        return empty;
    } catch (error) {
        // The message can quote the untrusted manifest back (a rejected env-var
        // name, a bad path), so it is sanitized like every other render site.
        options.logger.error(safe(`view failed: ${error instanceof Error ? error.message : String(error)}`));

        return { ...empty, code: 1 };
    } finally {
        for (const cleanup of cleanups) {
            cleanup();
        }
    }
};

/**
 * `lunora registry build` — regenerate `index.json` from the item directories
 * (the catalog `list` reads). With `--check`, verify the committed index matches
 * instead of rewriting it (exits non-zero on drift) — a CI guard.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- uniform async command contract; the body (buildRegistryIndex) is synchronous
const runBuildIndexCommand = async (options: AddCommandOptions): Promise<AddCommandResult> => {
    const empty = emptyResult();
    const root = options.from;

    if (root === undefined) {
        options.logger.error("registry build requires --from <registry root>");

        return { ...empty, code: 1 };
    }

    if (!existsSync(root)) {
        options.logger.error(`registry root not found: ${root}`);

        return { ...empty, code: 1 };
    }

    const index = buildRegistryIndex(root);
    const outputPath = options.out ?? join(root, "index.json");

    if (options.check) {
        const current = existsSync(outputPath) ? (JSON.parse(readFileSync(outputPath, "utf8")) as { items?: unknown }) : { items: [] };
        // Compare normalized item arrays so formatting/comment differences don't matter.
        const drift = JSON.stringify(current.items ?? []) !== JSON.stringify(index.items);

        if (drift) {
            options.logger.error(`registry: ${outputPath} is stale — run \`lunora registry build\` to regenerate it`);

            return { ...empty, code: 1 };
        }

        options.logger.success(`registry: ${outputPath} is up to date (${String(index.items.length)} items)`);

        return empty;
    }

    writeFileSync(outputPath, `${JSON.stringify({ $schema: "./schema/registry.schema.json", ...index }, undefined, 4)}\n`, "utf8");
    options.logger.success(`registry: wrote ${outputPath} (${String(index.items.length)} items)`);

    return empty;
};

export { runAddCommand, runBuildIndexCommand, runRegistryViewCommand };
