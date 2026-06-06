/**
 * `cirrus add &lt;name>` — the component-registry command (MVP).
 *
 * Mirrors `cirrus init`'s `giget`-fetch pipeline but operates on *registry
 * items* (`gh:anolilab/cirrus/registry/&lt;name>#alpha`) instead of whole-project
 * templates. An item is a directory shipping a `registry.json` manifest plus the
 * files it scaffolds into the user's `cirrus/` tree. The model is shadcn/kitcn:
 * the code is copied into the project and becomes the user's to own and edit.
 *
 * Pipeline (see COMPONENT-REGISTRY.md):
 *
 * 1. resolve — fetch the item via giget (or `--from &lt;localdir>` offline).
 * 2. plan — read the manifest, transitively resolve `requires`, print the files / deps / bindings; `--dry-run` stops here.
 * 3. reconcile — per file, by `merge` strategy. `create-or-skip` writes if absent (warn-skip if present); `schema-extension` AST-merges `.extend(&lt;key>.extension)` into `cirrus/schema.ts` (idempotent managed block).
 * 4. apply — deps to package.json (confirm first), bindings to wrangler.jsonc (structural jsonc edit preserving comments).
 * 5. report — next steps.
 *
 * Heavy deps (giget, ts-morph, jsonc-parser) are imported lazily so they only
 * load when this command actually runs.
 */
import { createInterface } from "node:readline";

import type { Logger } from "../util/logger.js";

/** A single file the item scaffolds into the project. */
interface RegistryFile {
    /** Source path inside the item dir (e.g. `schema.ts`). */
    from: string;
    /** Merge strategy. `create-or-skip` writes whole files; `schema-extension` AST-merges schema.ts. */
    merge: "create-or-skip" | "schema-extension";
    /** Destination relative to the project root (e.g. `cirrus/ratelimit/index.ts`). */
    to: string;
}

/** A wrangler.jsonc binding addition. `path` is the jsonc key path; `value` the value to set. */
interface RegistryBinding {
    path: ReadonlyArray<string>;
    value: unknown;
}

/** The `registry.json` manifest shape. */
interface RegistryManifest {
    /** wrangler.jsonc additions (best-effort structural edits). */
    bindings?: ReadonlyArray<RegistryBinding>;
    /** npm deps to add to the project package.json (name → version range). */
    deps?: Readonly<Record<string, string>>;
    description?: string;
    files: ReadonlyArray<RegistryFile>;
    name: string;
    /** Other registry items this one depends on (resolved transitively, deps first). */
    requires?: ReadonlyArray<string>;
}

interface AddCommandOptions {
    /** Bypass the `--source` safety gate (matches init). */
    allowUnsafeSource?: boolean;
    /** Inject a confirmer for non-interactive callers / tests. */
    confirm?: (prompt: string) => Promise<boolean>;
    cwd?: string;
    /** Print the plan and stop without writing anything. */
    dryRun?: boolean;
    /** Local registry root (offline / tests). Expects `&lt;name>/` subdirs each with `registry.json`. */
    from?: string;
    /** Emit a JSON snapshot of the plan/result. */
    json?: boolean;
    /** `--list`: enumerate available items instead of adding. */
    list?: boolean;
    logger: Logger;
    /** Item names to add (positional args). */
    names: ReadonlyArray<string>;
    /** Override the remote registry source base (default gh:anolilab/cirrus/registry). */
    source?: string;
    /** Skip the package.json mutation confirmation prompt. */
    yes?: boolean;
}

interface AddCommandResult {
    /** Bindings written to wrangler.jsonc. */
    bindings: ReadonlyArray<string>;
    code: number;
    /** Deps added to package.json. */
    deps: ReadonlyArray<string>;
    /** Files skipped because they already existed. */
    skipped: ReadonlyArray<string>;
    /** Files written (absolute paths). */
    written: ReadonlyArray<string>;
}

const DEFAULT_SOURCE_BASE = "gh:anolilab/cirrus/registry";
const DEFAULT_SOURCE_REF = "alpha";

/** Mirror init's `--source` gate. */
const isSafeSource = (source: string): boolean => {
    if (source.includes("..")) {
        return false;
    }

    return source.startsWith("gh:") || source.startsWith("github:") || source.startsWith("https://");
};

const promptYesNo = async (prompt: string): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(prompt, (input) => {
                resolve(input);
            });
        });

        const normalised = answer.trim().toLowerCase();

        return normalised === "y" || normalised === "yes";
    } finally {
        rl.close();
    }
};

/** Validate + narrow a parsed JSON value into a {@link RegistryManifest}. */
const parseManifest = (raw: unknown, itemName: string): RegistryManifest => {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`registry.json for "${itemName}" is not an object`);
    }

    const record = raw as Record<string, unknown>;
    const { name } = record;

    if (typeof name !== "string" || name.length === 0) {
        throw new Error(`registry.json for "${itemName}" is missing a string "name"`);
    }

    const filesRaw = record.files;

    if (!Array.isArray(filesRaw)) {
        throw new TypeError(`registry.json for "${itemName}" is missing a "files" array`);
    }

    const files: RegistryFile[] = filesRaw.map((entry, index) => {
        if (typeof entry !== "object" || entry === null) {
            throw new Error(`registry.json "${itemName}": files[${String(index)}] is not an object`);
        }

        const fileRecord = entry as Record<string, unknown>;
        const { from } = fileRecord;
        const { to } = fileRecord;
        const { merge } = fileRecord;

        if (typeof from !== "string" || typeof to !== "string") {
            throw new TypeError(`registry.json "${itemName}": files[${String(index)}] needs string "from" and "to"`);
        }

        if (merge !== "create-or-skip" && merge !== "schema-extension") {
            throw new Error(`registry.json "${itemName}": files[${String(index)}].merge must be "create-or-skip" or "schema-extension"`);
        }

        // Reject path traversal in destinations: items must stay inside the project.
        if (to.includes("..") || to.startsWith("/")) {
            throw new Error(`registry.json "${itemName}": files[${String(index)}].to "${to}" must be a relative path without ".."`);
        }

        return { from, merge, to };
    });

    const deps = typeof record.deps === "object" && record.deps !== null ? (record.deps as Record<string, string>) : undefined;
    const requires = Array.isArray(record.requires) ? record.requires.filter((value): value is string => typeof value === "string") : undefined;
    const bindings = Array.isArray(record.bindings)
        ? (record.bindings as unknown[]).filter((value): value is RegistryBinding => {
              if (typeof value !== "object" || value === null) {
                  return false;
              }

              const bindingRecord = value as Record<string, unknown>;

              return Array.isArray(bindingRecord.path) && bindingRecord.path.every((segment) => typeof segment === "string");
          })
        : undefined;

    return {
        bindings,
        deps,
        description: typeof record.description === "string" ? record.description : undefined,
        files,
        name,
        requires,
    };
};

/**
 * Resolve an item's directory: either straight from `--from` (offline) or by
 * fetching it via giget into a staging dir. Returns the directory + a cleanup
 * callback the caller runs once it's finished reading the item.
 */
const resolveItemDirectory = async (name: string, options: AddCommandOptions): Promise<{ cleanup: () => void; directory: string }> => {
    if (options.from !== undefined) {
        const { join } = await import("@visulima/path");
        const { existsSync } = await import("node:fs");
        const directory = join(options.from, name);

        if (!existsSync(directory)) {
            throw new Error(`registry item not found in local source: ${directory}`);
        }

        return { cleanup: () => {}, directory };
    }

    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("@visulima/path");
    const { downloadTemplate } = await import("giget");

    const base = options.source ?? DEFAULT_SOURCE_BASE;
    const remote = `${base}/${name}#${DEFAULT_SOURCE_REF}`;

    const stagingRoot = mkdtempSync(join(tmpdir(), "cirrus-add-fetch-"));
    const stagingDirectory = join(stagingRoot, "item");

    options.logger.info(`fetching registry item from ${remote}`);

    try {
        const downloaded = (await downloadTemplate(remote, {
            cwd: stagingRoot,
            dir: stagingDirectory,
            force: true,
            install: false,
            silent: true,
        })) as { commit?: string; source: string };

        if (downloaded.commit) {
            options.logger.info(`resolved ${downloaded.source} @ ${downloaded.commit}`);
        } else {
            options.logger.info(`resolved ${downloaded.source}`);
        }

        return {
            cleanup: () => {
                rmSync(stagingRoot, { force: true, recursive: true });
            },
            directory: stagingDirectory,
        };
    } catch (error) {
        rmSync(stagingRoot, { force: true, recursive: true });

        throw error;
    }
};

/** Read + parse a manifest from an item directory. */
const readManifest = async (itemDirectory: string, name: string): Promise<RegistryManifest> => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("@visulima/path");

    const manifestPath = join(itemDirectory, "registry.json");
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;

    return parseManifest(raw, name);
};

/**
 * Resolve the full set of items to install, depth-first so dependencies come
 * before dependents. Returns each item's manifest + resolved directory + a
 * cleanup callback. Detects cycles and de-dupes already-seen items.
 */
const resolvePlan = async (
    names: ReadonlyArray<string>,
    options: AddCommandOptions,
): Promise<{ cleanups: (() => void)[]; items: { directory: string; manifest: RegistryManifest }[] }> => {
    const items: { directory: string; manifest: RegistryManifest }[] = [];
    const cleanups: (() => void)[] = [];
    const seen = new Set<string>();
    const inProgress = new Set<string>();

    const visit = async (name: string): Promise<void> => {
        if (seen.has(name)) {
            return;
        }

        if (inProgress.has(name)) {
            throw new Error(`cyclic registry dependency detected at "${name}"`);
        }

        inProgress.add(name);

        const { cleanup, directory } = await resolveItemDirectory(name, options);

        cleanups.push(cleanup);

        const manifest = await readManifest(directory, name);

        // Resolve dependencies first so they land earlier in `items`. Sequential
        // by design — fetch order + cycle detection rely on it, so a parallel
        // map would break correctness.
        for (const requirement of manifest.requires ?? []) {
            // eslint-disable-next-line no-await-in-loop
            await visit(requirement);
        }

        inProgress.delete(name);
        seen.add(name);
        items.push({ directory, manifest });
    };

    for (const name of names) {
        // eslint-disable-next-line no-await-in-loop
        await visit(name);
    }

    return { cleanups, items };
};

/** Render the human-readable plan for one item. */
const printPlan = (logger: Logger, manifest: RegistryManifest): void => {
    logger.info(`plan: ${manifest.name}${manifest.description ? ` — ${manifest.description}` : ""}`);

    for (const file of manifest.files) {
        logger.info(`  file  ${file.to}  (${file.merge})`);
    }

    for (const [dep, range] of Object.entries(manifest.deps ?? {})) {
        logger.info(`  dep   ${dep}@${range}`);
    }

    for (const binding of manifest.bindings ?? []) {
        logger.info(`  bind  ${binding.path.join(".")}`);
    }
};

/**
 * Reconcile one file into the project, returning whether it was written /
 * skipped. `create-or-skip` writes whole files; `schema-extension` AST-merges
 * into `cirrus/schema.ts`.
 */
const reconcileFile = async (
    file: RegistryFile,
    itemKey: string,
    itemDirectory: string,
    projectRoot: string,
    logger: Logger,
): Promise<{ kind: "skipped" | "written"; path: string }> => {
    const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { dirname, join } = await import("@visulima/path");

    const sourcePath = join(itemDirectory, file.from);
    const destinationPath = join(projectRoot, file.to);

    if (file.merge === "schema-extension") {
        const { insertSchemaExtension } = await import("../util/insert-schema-extension.js");

        // The schema-extension strategy targets the project's shared schema.ts.
        // The item's `to` points at where its extension *source* lives (e.g.
        // cirrus/<key>/schema.ts) — we both copy that source (create-or-skip
        // semantics) AND wire it into cirrus/schema.ts.
        if (!existsSync(destinationPath)) {
            mkdirSync(dirname(destinationPath), { recursive: true });
            writeFileSync(destinationPath, readFileSync(sourcePath, "utf8"), "utf8");
        }

        const schemaPath = join(projectRoot, "cirrus", "schema.ts");
        const existingSchema = existsSync(schemaPath)
            ? readFileSync(schemaPath, "utf8")
            : 'import { defineSchema } from "@cirrus/server";\n\nexport const schema = defineSchema({});\n';

        const result = insertSchemaExtension(existingSchema, itemKey);

        if (result.ok) {
            mkdirSync(dirname(schemaPath), { recursive: true });
            writeFileSync(schemaPath, result.text, "utf8");
            logger.success(`merged .extend(${itemKey}.extension) into cirrus/schema.ts`);

            return { kind: "written", path: schemaPath };
        }

        if (result.reason === "already-applied") {
            logger.warn(`cirrus/schema.ts already extends "${itemKey}" — skipping`);

            return { kind: "skipped", path: schemaPath };
        }

        throw new Error(`schema-extension merge failed for "${itemKey}": ${result.reason}`);
    }

    // create-or-skip
    if (existsSync(destinationPath)) {
        logger.warn(`skip (exists): ${file.to}`);

        return { kind: "skipped", path: destinationPath };
    }

    mkdirSync(dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, readFileSync(sourcePath, "utf8"), "utf8");
    logger.success(`write: ${file.to}`);

    return { kind: "written", path: destinationPath };
};

/** Add deps to the project package.json (structural, preserving formatting). Returns added names. */
const applyDeps = async (deps: Readonly<Record<string, string>>, projectRoot: string, logger: Logger): Promise<ReadonlyArray<string>> => {
    const entries = Object.entries(deps);

    if (entries.length === 0) {
        return [];
    }

    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("@visulima/path");
    const { applyEdits, modify } = await import("jsonc-parser");

    const packageJsonPath = join(projectRoot, "package.json");

    if (!existsSync(packageJsonPath)) {
        logger.warn(`package.json not found at ${packageJsonPath} — skipping dependency updates`);

        return [];
    }

    let text = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(text) as { dependencies?: Record<string, string> };
    const added: string[] = [];

    for (const [name, range] of entries) {
        if (parsed.dependencies?.[name] !== undefined) {
            logger.info(`dep already present: ${name}`);

            continue;
        }

        const edits = modify(text, ["dependencies", name], range, {
            formattingOptions: { insertSpaces: true, tabSize: 4 },
        });

        text = applyEdits(text, edits);
        added.push(name);
    }

    if (added.length > 0) {
        writeFileSync(packageJsonPath, text, "utf8");
        logger.success(`added ${String(added.length)} dependency(ies) to package.json: ${added.join(", ")}`);
    }

    return added;
};

/** Apply wrangler.jsonc bindings (structural jsonc edits preserving comments). Returns applied paths. */
const applyBindings = async (bindings: ReadonlyArray<RegistryBinding>, projectRoot: string, logger: Logger): Promise<ReadonlyArray<string>> => {
    if (bindings.length === 0) {
        return [];
    }

    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("@visulima/path");
    const { applyEdits, modify } = await import("jsonc-parser");

    const candidates = ["wrangler.jsonc", "wrangler.json"];
    const wranglerPath = candidates.map((candidate) => join(projectRoot, candidate)).find((candidate) => existsSync(candidate));

    if (!wranglerPath) {
        logger.warn("wrangler.jsonc not found — skipping binding updates");

        return [];
    }

    let text = readFileSync(wranglerPath, "utf8");
    const applied: string[] = [];

    for (const binding of bindings) {
        const edits = modify(text, [...binding.path], binding.value, {
            formattingOptions: { insertSpaces: true, tabSize: 4 },
        });

        if (edits.length === 0) {
            continue;
        }

        text = applyEdits(text, edits);
        applied.push(binding.path.join("."));
    }

    if (applied.length > 0) {
        writeFileSync(wranglerPath, text, "utf8");
        logger.success(`applied ${String(applied.length)} binding(s) to ${wranglerPath}: ${applied.join(", ")}`);
    }

    return applied;
};

/** `cirrus list` / `cirrus add --list`: enumerate available registry items. */
const runListCommand = async (options: AddCommandOptions): Promise<AddCommandResult> => {
    const empty: AddCommandResult = { bindings: [], code: 0, deps: [], skipped: [], written: [] };

    if (options.from === undefined) {
        // Listing the remote registry requires an index endpoint we don't ship
        // in the MVP. Point the user at `--from` / the docs instead of guessing.
        options.logger.info("cirrus list: remote registry index is not available yet — pass --from <dir> to list a local registry");

        return empty;
    }

    const { existsSync, readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("@visulima/path");

    if (!existsSync(options.from)) {
        options.logger.error(`registry root not found: ${options.from}`);

        return { ...empty, code: 1 };
    }

    const names = readdirSync(options.from).filter((entry) => {
        const full = join(options.from as string, entry);

        return statSync(full).isDirectory() && existsSync(join(full, "registry.json"));
    });

    if (options.json) {
        const records = names.map((name) => {
            const raw = JSON.parse(readFileSync(join(options.from as string, name, "registry.json"), "utf8")) as { description?: string };

            return { description: raw.description, name };
        });

        process.stdout.write(`${JSON.stringify(records, undefined, 2)}\n`);

        return empty;
    }

    options.logger.info(`available registry items (${String(names.length)}):`);

    for (const name of names) {
        const raw = JSON.parse(readFileSync(join(options.from, name, "registry.json"), "utf8")) as { description?: string };

        options.logger.info(`  ${name}${raw.description ? ` — ${raw.description}` : ""}`);
    }

    return empty;
};

/**
 * Gate the package.json mutation behind a confirmation when any item adds deps.
 * Returns `true` to proceed, `false` to abort (after logging the reason).
 */
const confirmDepMutation = async (items: ReadonlyArray<{ manifest: RegistryManifest }>, options: AddCommandOptions): Promise<boolean> => {
    const hasDeps = items.some(({ manifest }) => Object.keys(manifest.deps ?? {}).length > 0);

    if (!hasDeps || options.yes) {
        return true;
    }

    if (!process.stdin.isTTY && options.confirm === undefined) {
        options.logger.error("add: stdin is not a TTY and items add dependencies — re-run with --yes to confirm editing package.json");

        return false;
    }

    const confirmer = options.confirm ?? promptYesNo;
    const confirmed = await confirmer("Some items add dependencies to package.json. Continue? [y/N] ");

    if (!confirmed) {
        options.logger.info("add: aborted");
    }

    return confirmed;
};

/** Run the reconcile phase across every resolved item; returns the aggregate outcome. */
const reconcileItems = async (
    items: ReadonlyArray<{ directory: string; manifest: RegistryManifest }>,
    cwd: string,
    logger: Logger,
): Promise<{ bindings: string[]; deps: string[]; skipped: string[]; written: string[] }> => {
    const written: string[] = [];
    const skipped: string[] = [];
    const depsAdded: string[] = [];
    const bindingsApplied: string[] = [];

    // Sequential by design: reconciling cirrus/schema.ts is read-modify-write,
    // so two items extending the schema must not interleave their edits.
    for (const { directory, manifest } of items) {
        for (const file of manifest.files) {
            // eslint-disable-next-line no-await-in-loop
            const outcome = await reconcileFile(file, manifest.name, directory, cwd, logger);

            if (outcome.kind === "written") {
                written.push(outcome.path);
            } else {
                skipped.push(outcome.path);
            }
        }

        if (manifest.deps) {
            // eslint-disable-next-line no-await-in-loop
            depsAdded.push(...(await applyDeps(manifest.deps, cwd, logger)));
        }

        if (manifest.bindings) {
            // eslint-disable-next-line no-await-in-loop
            bindingsApplied.push(...(await applyBindings(manifest.bindings, cwd, logger)));
        }
    }

    return { bindings: bindingsApplied, deps: depsAdded, skipped, written };
};

const runAddCommand = async (options: AddCommandOptions): Promise<AddCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const empty: AddCommandResult = { bindings: [], code: 0, deps: [], skipped: [], written: [] };

    if (options.list) {
        return runListCommand(options);
    }

    if (options.names.length === 0) {
        options.logger.error("add requires at least one item name. Usage: cirrus add <name> [...names]");

        return { ...empty, code: 1 };
    }

    // Mirror init's --source gate.
    if (
        options.from === undefined &&
        options.source !== undefined &&
        options.source.length > 0 &&
        !options.allowUnsafeSource &&
        !isSafeSource(options.source)
    ) {
        options.logger.error(
            `add: refusing --source ${options.source} — only gh:, github:, or https:// sources are allowed (and may not contain "..").` +
                " Re-run with --allow-unsafe-source if you really want this.",
        );

        return { ...empty, code: 1 };
    }

    let cleanups: (() => void)[] = [];

    try {
        const { cleanups: planCleanups, items } = await resolvePlan(options.names, options);

        cleanups = planCleanups;

        // --- Plan ---
        for (const { manifest } of items) {
            printPlan(options.logger, manifest);
        }

        if (options.json) {
            const planSnapshot = items.map(({ manifest }) => {
                return {
                    bindings: (manifest.bindings ?? []).map((binding) => binding.path.join(".")),
                    deps: Object.keys(manifest.deps ?? {}),
                    files: manifest.files.map((file) => {
                        return { merge: file.merge, to: file.to };
                    }),
                    name: manifest.name,
                    requires: manifest.requires ?? [],
                };
            });

            process.stdout.write(`${JSON.stringify({ items: planSnapshot }, undefined, 2)}\n`);
        }

        if (options.dryRun) {
            options.logger.info("dry-run: stopping before any files are written");

            return empty;
        }

        // --- Confirm package.json mutation (if any item adds deps) ---
        if (!(await confirmDepMutation(items, options))) {
            return { ...empty, code: 1 };
        }

        // --- Reconcile ---
        const { bindings, deps, skipped, written } = await reconcileItems(items, cwd, options.logger);

        // --- Report ---
        options.logger.success(`add complete: ${String(written.length)} written, ${String(skipped.length)} skipped`);
        options.logger.info("next steps:");
        options.logger.info("  cirrus codegen   # regenerate _generated/ so the new tables/functions appear");

        if (deps.length > 0) {
            options.logger.info("  pnpm install     # install newly-added dependencies");
        }

        return { bindings, code: 0, deps, skipped, written };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.error(`add failed: ${message}`);

        return { ...empty, code: 1 };
    } finally {
        for (const cleanup of cleanups) {
            cleanup();
        }
    }
};

export type { AddCommandOptions, AddCommandResult, RegistryBinding, RegistryFile, RegistryManifest };
export { parseManifest, runAddCommand };
