/**
 * Applying an item's non-file resources into the project: npm deps /
 * devDependencies + wrangler.jsonc bindings (structural jsonc edits) and
 * `.dev.vars` env-var scaffolding, plus the package.json mutation confirmation.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { DEV_VARS_FILE, parseDevVariableEntries, writeDevVariablesFileAtomically } from "@lunora/config";
import { join } from "@visulima/path";
import { applyEdits, modify, parse } from "jsonc-parser";

import type { Logger } from "../../util/logger";
import { resolveDistTag } from "../../util/source-ref";
import { tuiConfirm } from "../../util/tui-prompts";
import type { AddCommandOptions, RegistryBinding, RegistryEnvVariable, RegistryManifest } from "./types";

/**
 * Translate a pnpm `workspace:` protocol range into a publishable one.
 *
 * Registry manifests live inside the monorepo and pin sibling `@lunora/*`
 * packages with `workspace:*` so development resolves to the local checkout.
 * But `add` writes these ranges into a *consumer's* package.json, where the
 * workspace protocol is meaningless — pnpm aborts with
 * `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. So when the range carries an explicit
 * version (`workspace:^1.2.3` → `^1.2.3`) we strip the prefix; the bare alias
 * forms (`workspace:*` / `^` / `~`) have no version to recover, so they pin to
 * the CLI's release-channel dist-tag (the packages are independently versioned —
 * there is no single version to pin to from here, and on a pre-release channel
 * the `latest` tag is a placeholder, so the channel tag is what actually
 * resolves to installable code). See {@link resolveDistTag}.
 */
const resolveDepRange = (range: string): string => {
    if (!range.startsWith("workspace:")) {
        return range;
    }

    const rest = range.slice("workspace:".length);

    if (rest === "" || rest === "*" || rest === "^" || rest === "~") {
        return resolveDistTag();
    }

    return rest;
};

/**
 * The base `@lunora/*` packages the unscoped `lunorash` umbrella re-exports
 * through subpaths (`lunorash/server`, `lunorash/values`, …). A project that
 * depends on `lunorash` already has these — so a registry item must NOT add them
 * as separate deps (it would reintroduce a parallel `@lunora/server` next to the
 * umbrella's, and once the floating channel tag drifts past the version
 * `lunorash` pins, two copies → two module instances → schema/builder identity
 * breakage). Add-ons the umbrella does not re-export (`@lunora/auth`,
 * `@lunora/mail`, framework adapters, …) stay granular `@lunora/*` installs.
 */
const UMBRELLA_REEXPORTED_DEPS = new Set(["@lunora/client", "@lunora/do", "@lunora/ratelimit", "@lunora/runtime", "@lunora/server", "@lunora/values"]);

/** Quoted module specifier for an umbrella-re-exported base package (with optional subpath). */
const UMBRELLA_IMPORT_RE = /(['"])@lunora\/(client|do|ratelimit|runtime|server|values)(\/[^'"]*)?\1/gu;

/**
 * True when the project at `projectRoot` depends on the `lunorash` umbrella
 * (in either dependency section). Drives the umbrella-aware add path: such a
 * project gets base imports/deps routed through `lunorash/*` instead of the
 * granular `@lunora/*` packages. Returns false when package.json is absent or
 * unreadable (the safe granular default).
 */
const projectUsesUmbrella = (projectRoot: string): boolean => {
    const packageJsonPath = join(projectRoot, "package.json");

    if (!existsSync(packageJsonPath)) {
        return false;
    }

    try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        return parsed.dependencies?.lunorash !== undefined || parsed.devDependencies?.lunorash !== undefined;
    } catch {
        return false;
    }
};

/**
 * Rewrite a registry item's `@lunora/{server,values,runtime,do,client}` import
 * specifiers to the matching `lunorash/*` umbrella subpath, preserving any
 * subpath (`@lunora/server/types` → `lunorash/server/types`) and quote style.
 * Add-on scopes are left untouched. Applied to a copied file only when the
 * target project depends on the umbrella so the shipped code imports the base
 * surface from the same package the rest of the app does (one instance).
 */
const rewriteUmbrellaImports = (source: string): string =>
    source.replaceAll(UMBRELLA_IMPORT_RE, (_match, quote: string, base: string, subpath?: string) => `${quote}lunorash/${base}${subpath ?? ""}${quote}`);

/**
 * Add deps to a `package.json` section (`dependencies` or `devDependencies`),
 * structurally so formatting/comments are preserved. Returns the added names.
 * When `useUmbrella` is set, base packages the `lunorash` umbrella re-exports
 * ({@link UMBRELLA_REEXPORTED_DEPS}) are skipped — the umbrella already provides
 * them, and adding a parallel copy risks a second instance.
 */
const applyDeps = (
    deps: Readonly<Record<string, string>>,
    projectRoot: string,
    logger: Logger,
    section: "dependencies" | "devDependencies" = "dependencies",
    useUmbrella = false,
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
        // The umbrella already re-exports this base package via a `lunorash/*`
        // subpath — adding it granularly would duplicate the install.
        if (useUmbrella && UMBRELLA_REEXPORTED_DEPS.has(name)) {
            logger.info(`dep provided by the lunorash umbrella, skipping: ${name}`);

            continue;
        }

        // A dep already pinned in either section is left as the project has it.
        if (parsed.dependencies?.[name] !== undefined || parsed.devDependencies?.[name] !== undefined) {
            logger.info(`dep already present: ${name}`);

            continue;
        }

        const edits = modify(text, [section, name], resolveDepRange(range), {
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

        writeDevVariablesFileAtomically(devVariablesPath, `${prefix}${lines.join("\n")}\n`);
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

/**
 * The `binding` name a wrangler resource entry claims, when it has one. Every
 * array-shaped wrangler binding (`d1_databases`, `r2_buckets`, `kv_namespaces`,
 * …) keys on this field, and two entries sharing it is always a
 * misconfiguration.
 */
const BINDING_KEY_FIELDS = ["binding", "name", "queue", "pattern"] as const;

const bindingNameOf = (entry: unknown): string | undefined => {
    if (typeof entry !== "object" || entry === null) {
        return undefined;
    }

    // Not every array-shaped wrangler binding keys on `binding`: a queue
    // consumer keys on `queue`, a migration on `tag`-adjacent `name`, a route on
    // `pattern`. Keying only on `binding` let those collide silently, which is
    // the same failure this guard exists to stop.
    for (const field of BINDING_KEY_FIELDS) {
        const value = (entry as Record<string, unknown>)[field];

        if (typeof value === "string" && value.length > 0) {
            return `${field}:${value}`;
        }
    }

    return undefined;
};

/**
 * The incoming array entries that should actually be appended to `existing`.
 *
 * Drops structural duplicates (so a re-run is idempotent) and — the part that
 * matters — drops any entry whose `binding` name the project already claims.
 * Structural dedupe alone let a manifest's placeholder sit ALONGSIDE a real
 * entry under the same name: two `DB` bindings, one pointing at
 * `replace-me-db`. Wrangler then picks one and the app can deploy against a
 * database that does not exist. The project's entry wins,
 * and the skip is reported rather than silent.
 */
const freshArrayEntries = (existing: ReadonlyArray<unknown>, incoming: ReadonlyArray<unknown>, path: string, logger: Logger): unknown[] => {
    const seen = new Set(existing.map((entry) => JSON.stringify(entry)));
    const claimed = new Set(existing.map((entry) => bindingNameOf(entry)).filter((name): name is string => name !== undefined));
    const fresh: unknown[] = [];

    for (const entry of incoming) {
        if (seen.has(JSON.stringify(entry))) {
            continue;
        }

        const name = bindingNameOf(entry);

        if (name !== undefined && claimed.has(name)) {
            logger.warn(
                `${name.replace(":", " ")} already exists in ${path} — keeping the project's entry and skipping the registry item's. Reconcile by hand if the item needs different settings.`,
            );

            continue;
        }

        if (name !== undefined) {
            claimed.add(name);
        }

        fresh.push(entry);
    }

    return fresh;
};

/** Narrowing guard that yields `unknown[]` (not `any[]`) from `Array.isArray`. */
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

/** Read the current value at a jsonc key path in `text` (comments tolerated). */
const readAt = (text: string, path: ReadonlyArray<string>): unknown => {
    let node: unknown = parse(text);

    for (const segment of path) {
        if (typeof node !== "object" || node === null) {
            return undefined;
        }

        node = (node as Record<string, unknown>)[segment];
    }

    return node;
};

/**
 * Whether a binding's key path may be written.
 *
 * Refuses anything outside the resource-binding allowlist: a
 * remote/attacker-influenceable manifest could otherwise set
 * `build.command`/`main`/`node_compat` and run code on the next dev/deploy.
 */
const isWritableBindingPath = (path: ReadonlyArray<string>, logger: Logger): boolean => {
    const root = path[0];

    if (root !== undefined && ALLOWED_BINDING_ROOTS.has(root)) {
        return true;
    }

    logger.warn(
        `skipping binding "${path.join(".")}" — only resource bindings (${[...ALLOWED_BINDING_ROOTS].join(", ")}) may be written, not exec/entrypoint keys`,
    );

    return false;
};

/** Sentinel distinguishing "nothing to write" from a legitimate `undefined` binding value. */
const SKIP_BINDING = Symbol("skip-binding");

/**
 * The value to write for one binding, or {@link SKIP_BINDING} when there is
 * nothing new.
 *
 * Array bindings (e.g. `r2_buckets`) MERGE into any existing array rather than
 * replacing it — otherwise adding `storage` then `backup` (or adding into a
 * project that already has buckets) would silently drop the earlier entries.
 */
// Returns `unknown` because a union with the sentinel collapses to `unknown`
// anyway (`typeof SKIP_BINDING | unknown` is just `unknown`), so the caller
// compares against SKIP_BINDING by identity rather than narrowing.
const mergedBindingValue = (text: string, binding: RegistryBinding, logger: Logger): unknown => {
    const { value } = binding;

    if (!isUnknownArray(value)) {
        return value;
    }

    const existing = readAt(text, binding.path);

    if (!isUnknownArray(existing)) {
        return value;
    }

    const fresh = freshArrayEntries(existing, value, binding.path.join("."), logger);

    return fresh.length === 0 ? SKIP_BINDING : [...existing, ...fresh];
};

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

    for (const binding of bindings) {
        if (!isWritableBindingPath(binding.path, logger)) {
            continue;
        }

        const value = mergedBindingValue(text, binding, logger);

        // `undefined` means "nothing new to write" — every incoming array entry
        // was already present, or its `binding` name is already claimed.
        if (value === SKIP_BINDING) {
            continue;
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

/**
 * Apply one item's non-file resources (deps, devDeps, bindings, env vars).
 * Returns the deps + bindings added. `useUmbrella` routes base-package deps
 * through the `lunorash` umbrella (skipping the granular duplicates).
 */
const applyItemResources = (manifest: RegistryManifest, cwd: string, logger: Logger, useUmbrella = false): { bindings: string[]; deps: string[] } => {
    const deps: string[] = [];
    const bindings: string[] = [];

    if (manifest.deps) {
        deps.push(...applyDeps(manifest.deps, cwd, logger, "dependencies", useUmbrella));
    }

    if (manifest.devDependencies) {
        deps.push(...applyDeps(manifest.devDependencies, cwd, logger, "devDependencies", useUmbrella));
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
 * True when the items come from a registry the user pointed at rather than the
 * pinned first-party one — a remote `--source` OR a local `--from` root. Both
 * are attacker-influenceable (a checked-out repo, a downloaded directory, a
 * hostile fetch base) and both ship the same file/dep/binding writes, so they
 * carry one rule and one predicate. Two copies of this check had already
 * drifted: `--source` was refused while `--from` applied silently.
 */
const isCustomRegistrySource = (options: { from?: string; source?: string }): boolean =>
    (options.source !== undefined && options.source.length > 0) || (options.from !== undefined && options.from.length > 0);

/**
 * Gate the privileged project mutations behind a confirmation when any item adds
 * dependencies OR wrangler.jsonc bindings, or when the items came from a
 * custom registry source (an attacker-influenceable origin can ship binding/file
 * writes that fire on `wrangler dev`/`deploy` without the victim importing
 * anything). Returns `true` to proceed, `false` to abort (after logging).
 */
const confirmDepMutation = async (items: ReadonlyArray<{ manifest: RegistryManifest }>, options: AddCommandOptions): Promise<boolean> => {
    const hasDeps = items.some(({ manifest }) => Object.keys(manifest.deps ?? {}).length > 0 || Object.keys(manifest.devDependencies ?? {}).length > 0);
    const hasBindings = items.some(({ manifest }) => (manifest.bindings ?? []).length > 0);
    // A custom `--source`/`--from` registry is untrusted: require a conscious
    // confirmation even for a files-only item, so attacker-controlled source
    // files aren't written silently.
    const nonDefaultSource = isCustomRegistrySource(options);

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
        // `from` first, matching `resolveRegistryRoot`: when both are given the
        // resolver reads the local root and ignores `--source`, so naming
        // `source` here asked the operator to confirm a place nothing read from.
        reasons.push(`come from a custom registry source (${String(options.from ?? options.source)})`);
    }

    const reasonText = reasons.join(", ");

    if (!process.stdin.isTTY && options.confirm === undefined) {
        options.logger.error(`add: stdin is not a TTY and the requested items ${reasonText} — re-run with --yes to confirm`);

        return false;
    }

    const confirmer = options.confirm ?? tuiConfirm;
    const confirmed = await confirmer(`The requested items ${reasonText}. Continue?`);

    if (!confirmed) {
        options.logger.info("add: aborted");
    }

    return confirmed;
};

export { applyDeps, applyItemResources, confirmDepMutation, isCustomRegistrySource, projectUsesUmbrella, resolveDepRange, rewriteUmbrellaImports };
