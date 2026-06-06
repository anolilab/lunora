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
import type { RegistryLock } from "../util/registry-lock.js";
import { hashContent, readLock, recordedHash, recordFile, writeLock } from "../util/registry-lock.js";

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

/**
 * An environment variable an item needs. Scaffolded into `.dev.vars` (Workers'
 * local-secrets file) on add — non-secrets get their `value`; secrets get an
 * empty placeholder and a reminder to run `wrangler secret put` for production.
 */
interface RegistryEnvVariable {
    /** Human note on what the variable is for. */
    description?: string;
    /** The variable name (e.g. `RESEND_API_KEY`). */
    name: string;
    /** Mark as a secret: never write a value, only a placeholder, and remind about prod. Defaults to `true` when no `value` is given. */
    secret?: boolean;
    /** A default/example value for non-secret vars. */
    value?: string;
}

/** The `registry.json` manifest shape. */
interface RegistryManifest {
    /** wrangler.jsonc additions (best-effort structural edits). */
    bindings?: ReadonlyArray<RegistryBinding>;
    /** npm deps to add to the project package.json (name → version range). */
    deps?: Readonly<Record<string, string>>;
    description?: string;
    /** npm devDependencies to add to the project package.json. */
    devDependencies?: Readonly<Record<string, string>>;
    /** Post-install guidance printed after the item is added (per-item next steps). */
    docs?: string;
    /** Environment variables the item needs; scaffolded into `.dev.vars`. */
    envVars?: ReadonlyArray<RegistryEnvVariable>;
    files: ReadonlyArray<RegistryFile>;
    name: string;
    /** Other registry items this one depends on (resolved transitively, deps first). */
    requires?: ReadonlyArray<string>;
    /** Short human-readable label (distinct from the longer `description`). */
    title?: string;
}

interface AddCommandOptions {
    /** Bypass the `--source` safety gate (matches init). */
    allowUnsafeSource?: boolean;
    /** `registry build --check`: verify the index is current instead of rewriting it. */
    check?: boolean;
    /** Inject a confirmer for non-interactive callers / tests. */
    confirm?: (prompt: string) => Promise<boolean>;
    cwd?: string;
    /** Preview the file-level changes (a content diff) and write nothing. */
    diff?: boolean;
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
    /** `registry build` output path for the generated catalog (defaults to the root's `index.json`). */
    out?: string;
    /** Force-overwrite existing files (take the incoming copy) instead of skipping/conflicting. */
    overwrite?: boolean;
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

/** Splits `.dev.vars` / file text into lines (CRLF or LF). */
const NEWLINE_SPLIT = /\r?\n/u;

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

    const asStringMap = (value: unknown): Record<string, string> | undefined =>
        typeof value === "object" && value !== null ? (value as Record<string, string>) : undefined;

    const deps = asStringMap(record.deps);
    const devDependencies = asStringMap(record.devDependencies);
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

    const envVariables = Array.isArray(record.envVars)
        ? (record.envVars as unknown[])
              .filter(
                  (value): value is Record<string, unknown> & { name: string } =>
                      typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string",
              )
              .map((entry) => {
                  const hasValue = typeof entry.value === "string";

                  return {
                      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
                      name: entry.name,
                      // Default to secret unless a concrete value is provided.
                      secret: typeof entry.secret === "boolean" ? entry.secret : !hasValue,
                      ...(hasValue ? { value: entry.value as string } : {}),
                  };
              })
        : undefined;

    return {
        bindings,
        deps,
        description: typeof record.description === "string" ? record.description : undefined,
        devDependencies,
        docs: typeof record.docs === "string" ? record.docs : undefined,
        envVars: envVariables,
        files,
        name,
        requires,
        title: typeof record.title === "string" ? record.title : undefined,
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
    const label = manifest.title ?? manifest.description;

    logger.info(`plan: ${manifest.name}${label ? ` — ${label}` : ""}`);

    for (const file of manifest.files) {
        logger.info(`  file  ${file.to}  (${file.merge})`);
    }

    for (const [dep, range] of Object.entries(manifest.deps ?? {})) {
        logger.info(`  dep   ${dep}@${range}`);
    }

    for (const [dep, range] of Object.entries(manifest.devDependencies ?? {})) {
        logger.info(`  dev   ${dep}@${range}`);
    }

    for (const binding of manifest.bindings ?? []) {
        logger.info(`  bind  ${binding.path.join(".")}`);
    }

    for (const variable of manifest.envVars ?? []) {
        logger.info(`  env   ${variable.name}${variable.secret ? " (secret)" : ""}`);
    }
};

type ReconcileOutcome = { kind: "skipped" | "written"; path: string };
type ReconcileOptions = { diff?: boolean; overwrite?: boolean };

/**
 * Reconcile a `schema-extension` file: copy the extension source (if absent)
 * and AST-merge the item's `.extend(...)` into `cirrus/schema.ts`. In diff
 * mode, just describe the intended merge.
 */
const reconcileSchemaExtension = async (
    file: RegistryFile,
    itemKey: string,
    itemDirectory: string,
    projectRoot: string,
    logger: Logger,
    diff: boolean,
): Promise<ReconcileOutcome> => {
    const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { dirname, join } = await import("@visulima/path");

    const schemaPath = join(projectRoot, "cirrus", "schema.ts");

    if (diff) {
        logger.info(`~ would merge .extend(${itemKey}.extension) into cirrus/schema.ts (and create ${file.to} if absent)`);

        return { kind: "skipped", path: schemaPath };
    }

    const { insertSchemaExtension } = await import("../util/insert-schema-extension.js");

    // The item's `to` points at where its extension *source* lives; copy that
    // (create-if-absent) AND wire it into the shared cirrus/schema.ts.
    const destinationPath = join(projectRoot, file.to);

    if (!existsSync(destinationPath)) {
        mkdirSync(dirname(destinationPath), { recursive: true });
        writeFileSync(destinationPath, readFileSync(join(itemDirectory, file.from), "utf8"), "utf8");
    }

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
};

/** Print a `--diff` preview for one whole-file destination; writes nothing. */
const previewWholeFile = async (file: RegistryFile, current: string, incoming: string, exists: boolean, logger: Logger): Promise<void> => {
    const { default: renderDiff } = await import("../util/text-diff.js");
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
 * Reconcile a `create-or-skip` whole file via the lock-aware 3-way rule (base =
 * last-written hash in the lock, yours = on-disk, theirs = incoming registry
 * copy). `--diff` previews; `--overwrite` force-takes theirs.
 */
const reconcileWholeFile = async (
    file: RegistryFile,
    itemKey: string,
    itemDirectory: string,
    projectRoot: string,
    logger: Logger,
    lock: RegistryLock,
    reconcileOptions: ReconcileOptions,
): Promise<ReconcileOutcome> => {
    const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { dirname, join } = await import("@visulima/path");

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
        await previewWholeFile(file, current, incoming, exists, logger);

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
        logger.warn(`skip (exists, untracked): ${file.to} — refusing to overwrite a file cirrus didn't add (use --overwrite to force)`);

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
 * (lock-aware upgrades); `schema-extension` AST-merges into `cirrus/schema.ts`.
 */
const reconcileFile = async (
    file: RegistryFile,
    itemKey: string,
    itemDirectory: string,
    projectRoot: string,
    logger: Logger,
    lock: RegistryLock,
    reconcileOptions: ReconcileOptions = {},
): Promise<ReconcileOutcome> => {
    if (file.merge === "schema-extension") {
        return reconcileSchemaExtension(file, itemKey, itemDirectory, projectRoot, logger, reconcileOptions.diff === true);
    }

    return reconcileWholeFile(file, itemKey, itemDirectory, projectRoot, logger, lock, reconcileOptions);
};

/**
 * Add deps to a `package.json` section (`dependencies` or `devDependencies`),
 * structurally so formatting/comments are preserved. Returns the added names.
 */
const applyDeps = async (
    deps: Readonly<Record<string, string>>,
    projectRoot: string,
    logger: Logger,
    section: "dependencies" | "devDependencies" = "dependencies",
): Promise<ReadonlyArray<string>> => {
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
    const parsed = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    const added: string[] = [];

    for (const [name, range] of entries) {
        // A dep already pinned in either section is left as the project has it.
        if (parsed.dependencies?.[name] !== undefined || parsed.devDependencies?.[name] !== undefined) {
            logger.info(`dep already present: ${name}`);

            continue;
        }

        const edits = modify(text, [section, name], range, {
            formattingOptions: { insertSpaces: true, tabSize: 4 },
        });

        text = applyEdits(text, edits);
        added.push(name);
    }

    if (added.length > 0) {
        writeFileSync(packageJsonPath, text, "utf8");
        logger.success(
            `added ${String(added.length)} ${section === "devDependencies" ? "devDependency(ies)" : "dependency(ies)"} to package.json: ${added.join(", ")}`,
        );
    }

    return added;
};

/**
 * Scaffold an item's environment variables into `.dev.vars` (Workers' local
 * secrets file), idempotently — existing keys are left as the project has them.
 * Non-secret vars get their declared `value`; secrets get an empty placeholder
 * and a reminder to set them (locally and via `wrangler secret put` for prod).
 * Returns the variable names newly written.
 */
const applyEnvVariables = async (envVariables: ReadonlyArray<RegistryEnvVariable>, projectRoot: string, logger: Logger): Promise<ReadonlyArray<string>> => {
    if (envVariables.length === 0) {
        return [];
    }

    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("@visulima/path");

    const devVariablesPath = join(projectRoot, ".dev.vars");
    const existing = existsSync(devVariablesPath) ? readFileSync(devVariablesPath, "utf8") : "";
    // Keys already present (ignore comments/blank lines).
    const present = new Set(
        existing
            .split(NEWLINE_SPLIT)
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#"))
            .map((line) => line.slice(0, line.indexOf("=")).trim())
            .filter((key) => key !== ""),
    );

    const appended: string[] = [];
    const secretsToSet: string[] = [];
    const lines: string[] = [];

    for (const variable of envVariables) {
        if (variable.secret) {
            secretsToSet.push(variable.name);
        }

        if (present.has(variable.name)) {
            continue;
        }

        if (variable.description) {
            lines.push(`# ${variable.description}`);
        }

        lines.push(`${variable.name}=${variable.secret ? "" : (variable.value ?? "")}`);
        appended.push(variable.name);
    }

    if (appended.length > 0) {
        const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;

        writeFileSync(devVariablesPath, `${prefix}${lines.join("\n")}\n`, "utf8");
        logger.success(`scaffolded ${String(appended.length)} env var(s) into .dev.vars: ${appended.join(", ")}`);
    }

    if (secretsToSet.length > 0) {
        logger.info(`set secret value(s) locally in .dev.vars, then for production: ${secretsToSet.map((name) => `wrangler secret put ${name}`).join("; ")}`);
    }

    return appended;
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

/** One catalog entry as `cirrus list` reports it. */
interface CatalogItem {
    description?: string;
    name: string;
}

/**
 * Collect the catalog from a resolved registry root. Prefers a top-level
 * `index.json` (`{ items: [{ name, description }] }`) — the curated, single-file
 * catalog the remote ships — and falls back to enumerating each subdirectory's
 * `registry.json` when no index is present (e.g. an ad-hoc local `--from` root).
 */
const collectCatalog = async (root: string): Promise<CatalogItem[]> => {
    const { existsSync, readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("@visulima/path");

    const indexPath = join(root, "index.json");

    if (existsSync(indexPath)) {
        const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as { items?: unknown };

        if (Array.isArray(parsed.items)) {
            return parsed.items
                .filter((entry): entry is CatalogItem => typeof entry === "object" && entry !== null && typeof (entry as CatalogItem).name === "string")
                .map((entry) => {
                    return { description: entry.description, name: entry.name };
                });
        }
    }

    return readdirSync(root)
        .filter((entry) => {
            const full = join(root, entry);

            return statSync(full).isDirectory() && existsSync(join(full, "registry.json"));
        })
        .map((name) => {
            const raw = JSON.parse(readFileSync(join(root, name, "registry.json"), "utf8")) as { description?: string };

            return { description: raw.description, name };
        });
};

/**
 * Resolve the registry root for listing: a local `--from` dir (offline), or a
 * giget-fetched copy of the remote registry base. Returns the root plus a
 * cleanup callback the caller runs when finished.
 */
const resolveRegistryRoot = async (options: AddCommandOptions): Promise<{ cleanup: () => void; root: string }> => {
    if (options.from !== undefined) {
        const { existsSync } = await import("node:fs");

        if (!existsSync(options.from)) {
            throw new Error(`registry root not found: ${options.from}`);
        }

        return { cleanup: () => {}, root: options.from };
    }

    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("@visulima/path");
    const { downloadTemplate } = await import("giget");

    const base = options.source ?? DEFAULT_SOURCE_BASE;
    const remote = `${base}#${DEFAULT_SOURCE_REF}`;

    const stagingRoot = mkdtempSync(join(tmpdir(), "cirrus-list-fetch-"));
    const stagingDirectory = join(stagingRoot, "registry");

    options.logger.info(`fetching registry catalog from ${remote}`);

    try {
        await downloadTemplate(remote, { cwd: stagingRoot, dir: stagingDirectory, force: true, install: false, silent: true });

        return {
            cleanup: () => {
                rmSync(stagingRoot, { force: true, recursive: true });
            },
            root: stagingDirectory,
        };
    } catch (error) {
        rmSync(stagingRoot, { force: true, recursive: true });

        throw error;
    }
};

/** `cirrus list` / `cirrus add --list`: enumerate available registry items (local `--from` or remote). */
const runListCommand = async (options: AddCommandOptions): Promise<AddCommandResult> => {
    const empty: AddCommandResult = { bindings: [], code: 0, deps: [], skipped: [], written: [] };

    // Mirror init's --source gate for the remote-fetch path.
    if (
        options.from === undefined &&
        options.source !== undefined &&
        options.source.length > 0 &&
        !options.allowUnsafeSource &&
        !isSafeSource(options.source)
    ) {
        options.logger.error(`list: refusing --source ${options.source} — only gh:, github:, or https:// sources are allowed (and may not contain "..").`);

        return { ...empty, code: 1 };
    }

    let cleanup: () => void = () => {};

    try {
        const resolved = await resolveRegistryRoot(options);

        cleanup = resolved.cleanup;

        const items = await collectCatalog(resolved.root);

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
        options.logger.error(`list failed: ${error instanceof Error ? error.message : String(error)}`);

        return { ...empty, code: 1 };
    } finally {
        cleanup();
    }
};

/**
 * Gate the package.json mutation behind a confirmation when any item adds deps.
 * Returns `true` to proceed, `false` to abort (after logging the reason).
 */
const confirmDepMutation = async (items: ReadonlyArray<{ manifest: RegistryManifest }>, options: AddCommandOptions): Promise<boolean> => {
    const hasDeps = items.some(({ manifest }) => Object.keys(manifest.deps ?? {}).length > 0 || Object.keys(manifest.devDependencies ?? {}).length > 0);

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

/** Apply one item's non-file resources (deps, devDeps, bindings, env vars). Returns the deps + bindings added. */
const applyItemResources = async (manifest: RegistryManifest, cwd: string, logger: Logger): Promise<{ bindings: string[]; deps: string[] }> => {
    const deps: string[] = [];
    const bindings: string[] = [];

    if (manifest.deps) {
        deps.push(...(await applyDeps(manifest.deps, cwd, logger)));
    }

    if (manifest.devDependencies) {
        deps.push(...(await applyDeps(manifest.devDependencies, cwd, logger, "devDependencies")));
    }

    if (manifest.bindings) {
        bindings.push(...(await applyBindings(manifest.bindings, cwd, logger)));
    }

    if (manifest.envVars) {
        await applyEnvVariables(manifest.envVars, cwd, logger);
    }

    return { bindings, deps };
};

/** Run the reconcile phase across every resolved item; returns the aggregate outcome. */
const reconcileItems = async (
    items: ReadonlyArray<{ directory: string; manifest: RegistryManifest }>,
    cwd: string,
    logger: Logger,
    reconcileOptions: ReconcileOptions = {},
): Promise<{ bindings: string[]; deps: string[]; skipped: string[]; written: string[] }> => {
    const written: string[] = [];
    const skipped: string[] = [];
    const depsAdded: string[] = [];
    const bindingsApplied: string[] = [];

    // The whole-file reconcile lock (records last-written hashes for the 3-way
    // upgrade check). Read once, mutated as files are reconciled, persisted below.
    const lock = readLock(cwd);

    // Sequential by design: reconciling cirrus/schema.ts is read-modify-write,
    // so two items extending the schema must not interleave their edits.
    for (const { directory, manifest } of items) {
        for (const file of manifest.files) {
            // eslint-disable-next-line no-await-in-loop
            const outcome = await reconcileFile(file, manifest.name, directory, cwd, logger, lock, reconcileOptions);

            (outcome.kind === "written" ? written : skipped).push(outcome.path);
        }

        // --diff is a read-only preview: don't mutate package.json / wrangler / .dev.vars.
        if (reconcileOptions.diff) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- sequential per item (schema/package.json edits are read-modify-write)
        const applied = await applyItemResources(manifest, cwd, logger);

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

/** True when a remote `--source` is set but fails the gh:/github:/https: safety gate. */
const isBlockedRemoteSource = (options: AddCommandOptions): boolean =>
    options.from === undefined && options.source !== undefined && options.source.length > 0 && !options.allowUnsafeSource && !isSafeSource(options.source);

/** Emit the `--json` plan snapshot for the resolved items to stdout. */
const printJsonPlan = (items: ReadonlyArray<{ manifest: RegistryManifest }>): void => {
    const planSnapshot = items.map(({ manifest }) => {
        return {
            bindings: (manifest.bindings ?? []).map((binding) => binding.path.join(".")),
            deps: Object.keys(manifest.deps ?? {}),
            devDependencies: Object.keys(manifest.devDependencies ?? {}),
            envVars: (manifest.envVars ?? []).map((variable) => variable.name),
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

/** Print the post-reconcile report: summary, next steps, and per-item `docs` guidance. */
const reportAddResult = (
    items: ReadonlyArray<{ manifest: RegistryManifest }>,
    deps: ReadonlyArray<string>,
    written: number,
    skipped: number,
    logger: Logger,
): void => {
    logger.success(`add complete: ${String(written)} written, ${String(skipped)} skipped`);
    logger.info("next steps:");
    logger.info("  cirrus codegen   # regenerate _generated/ so the new tables/functions appear");

    if (deps.length > 0) {
        logger.info("  pnpm install     # install newly-added dependencies");
    }

    for (const { manifest } of items) {
        if (manifest.docs) {
            logger.info(`${manifest.name}: ${manifest.docs}`);
        }
    }
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

    if (isBlockedRemoteSource(options)) {
        options.logger.error(
            `add: refusing --source ${String(options.source)} — only gh:, github:, or https:// sources are allowed (and may not contain "..").` +
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
            printJsonPlan(items);
        }

        if (options.dryRun) {
            options.logger.info("dry-run: stopping before any files are written");

            return empty;
        }

        // --- Diff preview: show file-level changes, mutate nothing ---
        if (options.diff) {
            await reconcileItems(items, cwd, options.logger, { diff: true });
            options.logger.info("diff: preview only — re-run without --diff to apply");

            return empty;
        }

        // --- Confirm package.json mutation (if any item adds deps) ---
        if (!(await confirmDepMutation(items, options))) {
            return { ...empty, code: 1 };
        }

        // --- Reconcile ---
        const { bindings, deps, skipped, written } = await reconcileItems(items, cwd, options.logger, { overwrite: options.overwrite });

        reportAddResult(items, deps, written.length, skipped.length, options.logger);

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

/**
 * `cirrus registry view` — inspect a registry item without installing it: print
 * its plan (files / deps / env vars) followed by the full contents of each file
 * it would scaffold. Resolves the item the same way `add` does (local `--from`
 * or remote giget fetch), but only this named item — no `requires` expansion.
 */
const runRegistryViewCommand = async (options: AddCommandOptions): Promise<AddCommandResult> => {
    const empty: AddCommandResult = { bindings: [], code: 0, deps: [], skipped: [], written: [] };

    if (options.names.length === 0) {
        options.logger.error("view requires an item name. Usage: cirrus view <name>");

        return { ...empty, code: 1 };
    }

    if (
        options.from === undefined &&
        options.source !== undefined &&
        options.source.length > 0 &&
        !options.allowUnsafeSource &&
        !isSafeSource(options.source)
    ) {
        options.logger.error(`view: refusing --source ${options.source} — only gh:, github:, or https:// sources are allowed (and may not contain "..").`);

        return { ...empty, code: 1 };
    }

    const { readFileSync } = await import("node:fs");
    const { join } = await import("@visulima/path");

    const cleanups: (() => void)[] = [];

    try {
        for (const name of options.names) {
            // eslint-disable-next-line no-await-in-loop -- each item is fetched + printed before the next; cleanup ordering depends on it
            const { cleanup, directory } = await resolveItemDirectory(name, options);

            cleanups.push(cleanup);

            // eslint-disable-next-line no-await-in-loop -- sequential per item (see above)
            const manifest = await readManifest(directory, name);

            printPlan(options.logger, manifest);

            for (const file of manifest.files) {
                options.logger.info(`--- ${file.to} (${file.merge}) ---`);

                const content = readFileSync(join(directory, file.from), "utf8");

                for (const line of content.split("\n")) {
                    options.logger.info(line);
                }
            }
        }

        return empty;
    } catch (error) {
        options.logger.error(`view failed: ${error instanceof Error ? error.message : String(error)}`);

        return { ...empty, code: 1 };
    } finally {
        for (const cleanup of cleanups) {
            cleanup();
        }
    }
};

/**
 * Build the catalog (`index.json` contents) from a local registry root by
 * reading every item's `registry.json`. Pure-ish (fs reads only); used by both
 * `cirrus registry build` and the registry tests so the committed index can't
 * drift from the item directories.
 */
const buildRegistryIndex = async (root: string): Promise<{ items: { description?: string; name: string; title?: string }[] }> => {
    const { existsSync, readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("@visulima/path");

    const items = readdirSync(root)
        .filter((entry) => {
            const full = join(root, entry);

            return statSync(full).isDirectory() && existsSync(join(full, "registry.json"));
        })
        .map((name) => {
            const manifest = parseManifest(JSON.parse(readFileSync(join(root, name, "registry.json"), "utf8")), name);

            return {
                ...(manifest.description === undefined ? {} : { description: manifest.description }),
                name: manifest.name,
                ...(manifest.title === undefined ? {} : { title: manifest.title }),
            };
        })
        .toSorted((a, b) => a.name.localeCompare(b.name));

    return { items };
};

/**
 * `cirrus registry build` — regenerate `index.json` from the item directories
 * (the catalog `cirrus list` reads). With `--check`, verify the committed index
 * matches instead of rewriting it (exits non-zero on drift) — a CI guard.
 */
const runBuildIndexCommand = async (options: AddCommandOptions): Promise<AddCommandResult> => {
    const empty: AddCommandResult = { bindings: [], code: 0, deps: [], skipped: [], written: [] };
    const root = options.from;

    if (root === undefined) {
        options.logger.error("registry build requires --from <registry root>");

        return { ...empty, code: 1 };
    }

    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("@visulima/path");

    if (!existsSync(root)) {
        options.logger.error(`registry root not found: ${root}`);

        return { ...empty, code: 1 };
    }

    const index = await buildRegistryIndex(root);
    const outputPath = options.out ?? join(root, "index.json");

    if (options.check) {
        const current = existsSync(outputPath) ? (JSON.parse(readFileSync(outputPath, "utf8")) as { items?: unknown }) : { items: [] };
        // Compare normalized item arrays so formatting/comment differences don't matter.
        const drift = JSON.stringify(current.items ?? []) !== JSON.stringify(index.items);

        if (drift) {
            options.logger.error(`registry: ${outputPath} is stale — run \`cirrus registry build\` to regenerate it`);

            return { ...empty, code: 1 };
        }

        options.logger.success(`registry: ${outputPath} is up to date (${String(index.items.length)} items)`);

        return empty;
    }

    writeFileSync(outputPath, `${JSON.stringify({ $schema: "./schema/registry.schema.json", ...index }, undefined, 4)}\n`, "utf8");
    options.logger.success(`registry: wrote ${outputPath} (${String(index.items.length)} items)`);

    return empty;
};

export type { AddCommandOptions, AddCommandResult, RegistryBinding, RegistryEnvVariable, RegistryFile, RegistryManifest };
export { buildRegistryIndex, parseManifest, runAddCommand, runBuildIndexCommand, runRegistryViewCommand };
