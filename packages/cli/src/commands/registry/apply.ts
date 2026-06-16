/**
 * Applying an item's non-file resources into the project: npm deps /
 * devDependencies + wrangler.jsonc bindings (structural jsonc edits) and
 * `.dev.vars` env-var scaffolding, plus the package.json mutation confirmation.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { DEV_VARS_FILE, parseDevVariableEntries, promptYesNo } from "@lunora/config";
import { join } from "@visulima/path";
import { applyEdits, modify, parse } from "jsonc-parser";

import type { Logger } from "../../util/logger";
import type { AddCommandOptions, RegistryBinding, RegistryEnvVariable, RegistryManifest } from "./types";

/**
 * Add deps to a `package.json` section (`dependencies` or `devDependencies`),
 * structurally so formatting/comments are preserved. Returns the added names.
 */
const applyDeps = (
    deps: Readonly<Record<string, string>>,
    projectRoot: string,
    logger: Logger,
    section: "dependencies" | "devDependencies" = "dependencies",
): ReadonlyArray<string> => {
    const entries = Object.entries(deps);

    if (entries.length === 0) {
        return [];
    }

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
const applyEnvVariables = (envVariables: ReadonlyArray<RegistryEnvVariable>, projectRoot: string, logger: Logger): ReadonlyArray<string> => {
    if (envVariables.length === 0) {
        return [];
    }

    const devVariablesPath = join(projectRoot, DEV_VARS_FILE);
    const existing = existsSync(devVariablesPath) ? readFileSync(devVariablesPath, "utf8") : "";
    // Keys already present (the shared grammar ignores comments/blank lines).
    const present = new Set(parseDevVariableEntries(existing).map((entry) => entry.key));

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

/**
 * The wrangler.jsonc top-level keys a registry binding is allowed to write. These
 * are pure resource/config bindings — none of them runs code on `wrangler dev`/
 * `deploy`. Exec-or-entrypoint keys (`build`, `main`, `node_compat`, …) are NOT
 * here, so a hostile manifest can't repoint the worker entry or smuggle a
 * `build.command` that runs arbitrary code on the next dev/deploy.
 */
const ALLOWED_BINDING_ROOTS = new Set([
    "ai",
    "analytics_engine_datasets",
    "browser",
    "d1_databases",
    "durable_objects",
    "hyperdrive",
    "kv_namespaces",
    "mtls_certificates",
    "queues",
    "r2_buckets",
    "send_email",
    "services",
    "vars",
    "vectorize",
    "version_metadata",
    "workflows",
]);

/** Apply wrangler.jsonc bindings (structural jsonc edits preserving comments). Returns applied paths. */
const applyBindings = (bindings: ReadonlyArray<RegistryBinding>, projectRoot: string, logger: Logger): ReadonlyArray<string> => {
    if (bindings.length === 0) {
        return [];
    }

    const candidates = ["wrangler.jsonc", "wrangler.json"];
    const wranglerPath = candidates.map((candidate) => join(projectRoot, candidate)).find((candidate) => existsSync(candidate));

    if (!wranglerPath) {
        logger.warn("wrangler.jsonc not found — skipping binding updates");

        return [];
    }

    let text = readFileSync(wranglerPath, "utf8");
    const applied: string[] = [];

    /** Narrowing guard that yields `unknown[]` (not `any[]`) from `Array.isArray`. */
    const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

    /** Read the current value at a jsonc key path (comments tolerated). */
    const readAt = (path: ReadonlyArray<string>): unknown => {
        let node: unknown = parse(text);

        for (const segment of path) {
            if (typeof node !== "object" || node === null) {
                return undefined;
            }

            node = (node as Record<string, unknown>)[segment];
        }

        return node;
    };

    for (const binding of bindings) {
        // Refuse to write any key outside the safe resource-binding allowlist. A
        // remote/attacker-influenceable manifest could otherwise set
        // `build.command`/`main`/`node_compat` to run code on the next dev/deploy.
        const root = binding.path[0];

        if (root === undefined || !ALLOWED_BINDING_ROOTS.has(root)) {
            logger.warn(`skipping binding "${binding.path.join(".")}" — only resource bindings (${[...ALLOWED_BINDING_ROOTS].join(", ")}) may be written, not exec/entrypoint keys`);

            continue;
        }

        // `RegistryBinding.value` is `unknown`; destructure then narrow below.
        let { value } = binding;

        // Array bindings (e.g. `r2_buckets`) MERGE into any existing array rather
        // than replacing it — otherwise adding `storage` then `backup` (or adding
        // into a project that already has buckets) would silently drop the
        // earlier entries. Dedupe by structural equality so re-runs are idempotent.
        if (isUnknownArray(value)) {
            const existing = readAt(binding.path);

            if (isUnknownArray(existing)) {
                const seen = new Set(existing.map((entry) => JSON.stringify(entry)));
                // `value` is the narrowed incoming array; evaluated before reassignment.
                value = [...existing, ...value.filter((entry) => !seen.has(JSON.stringify(entry)))];
            }
        }

        const edits = modify(text, [...binding.path], value, {
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

/** Apply one item's non-file resources (deps, devDeps, bindings, env vars). Returns the deps + bindings added. */
const applyItemResources = (manifest: RegistryManifest, cwd: string, logger: Logger): { bindings: string[]; deps: string[] } => {
    const deps: string[] = [];
    const bindings: string[] = [];

    if (manifest.deps) {
        deps.push(...applyDeps(manifest.deps, cwd, logger));
    }

    if (manifest.devDependencies) {
        deps.push(...applyDeps(manifest.devDependencies, cwd, logger, "devDependencies"));
    }

    if (manifest.bindings) {
        bindings.push(...applyBindings(manifest.bindings, cwd, logger));
    }

    if (manifest.envVars) {
        applyEnvVariables(manifest.envVars, cwd, logger);
    }

    return { bindings, deps };
};

/**
 * Gate the privileged project mutations behind a confirmation when any item adds
 * dependencies OR wrangler.jsonc bindings, or when the items came from a
 * non-default `--source` (an attacker-influenceable origin can ship binding/file
 * writes that fire on `wrangler dev`/`deploy` without the victim importing
 * anything). Returns `true` to proceed, `false` to abort (after logging).
 */
const confirmDepMutation = async (items: ReadonlyArray<{ manifest: RegistryManifest }>, options: AddCommandOptions): Promise<boolean> => {
    const hasDeps = items.some(({ manifest }) => Object.keys(manifest.deps ?? {}).length > 0 || Object.keys(manifest.devDependencies ?? {}).length > 0);
    const hasBindings = items.some(({ manifest }) => (manifest.bindings ?? []).length > 0);
    // A non-default `--source` is untrusted: require a conscious confirmation even
    // for a files-only item, so attacker-controlled source files aren't written silently.
    const nonDefaultSource = options.source !== undefined && options.source.length > 0;

    if ((!hasDeps && !hasBindings && !nonDefaultSource) || options.yes) {
        return true;
    }

    const reasons: string[] = [];

    if (hasDeps) {
        reasons.push("add dependencies to package.json");
    }

    if (hasBindings) {
        reasons.push("write wrangler.jsonc bindings");
    }

    if (nonDefaultSource) {
        reasons.push(`come from a non-default source (${String(options.source)})`);
    }

    const reasonText = reasons.join(", ");

    if (!process.stdin.isTTY && options.confirm === undefined) {
        options.logger.error(`add: stdin is not a TTY and the requested items ${reasonText} — re-run with --yes to confirm`);

        return false;
    }

    const confirmer = options.confirm ?? promptYesNo;
    const confirmed = await confirmer(`The requested items ${reasonText}. Continue? [y/N] `);

    if (!confirmed) {
        options.logger.info("add: aborted");
    }

    return confirmed;
};

export { applyBindings, applyDeps, applyEnvVariables, applyItemResources, confirmDepMutation };
