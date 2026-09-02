import { existsSync, readFileSync } from "node:fs";

import { applyLintIgnores, detectLintTools } from "@lunora/config";
import { findWranglerFile } from "@lunora/config/cloudflare";
import { basename, join } from "@visulima/path";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { reportLintIgnoreOutcomes } from "../../util/lint-ignore-report";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import type { TextPrompt } from "../../util/tui-prompts";
import { tuiSelect, tuiText } from "../../util/tui-prompts";
import { runAddCommand } from "../registry";
import { isCustomRegistrySource } from "../registry/apply";
import type { RegistryManifest } from "../registry/types";
import { deriveDatabaseName, promptDatabaseName, sanitizeDatabaseName, withAuthDatabaseName } from "./auth-database";
import type { FeatureItem, NormalizedFeature } from "./features";
import {
    AUTH_PROVIDER_OPTIONS,
    AUTH_UI_OPTIONS,
    DEFAULT_AUTH_ITEM,
    DEFAULT_AUTH_UI_ITEM,
    detectAuthUiItem,
    EMAIL_ITEM,
    isReactNativeProject,
    normalizeFeature,
    promptAuthProvider,
} from "./features";
import type { AddOptions } from "./index";
import { MAIL_DESTINATION_PROMPT, resolveTypedDestination, withMailDestination } from "./mail";
import { deriveBucketName, promptBucketName, sanitizeBucketName, withStorageBucketName } from "./storage";

interface AddFeatureOptions {
    allowUnsafeSource?: boolean;
    /** storage: R2 bucket name to use without prompting. */
    bucket?: string;
    /** Inject the registry apply confirmer for non-interactive callers / tests. */
    confirm?: (prompt: string) => Promise<boolean>;
    cwd?: string;
    /** auth: D1 database name to use without prompting. */
    db?: string;
    /** The raw `<feature>` argument: an alias (`auth` | `email` | `mail`) or a bare registry item name. */
    feature?: string;
    /** Local registry root (offline / tests). */
    from?: string;
    logger: Logger;
    /** mail: verified destination address to use without prompting. */
    mailTo?: string;
    /** Inject the provider prompt (tests). */
    promptSelect?: (
        message: string,
        options: ReadonlyArray<{ description?: string; label: string; value: FeatureItem }>,
        settings?: { default?: FeatureItem },
    ) => Promise<FeatureItem | undefined>;
    /** Inject the bucket-name text prompt (tests). */
    promptText?: (message: string, settings?: { default?: string; placeholder?: string }) => Promise<string>;
    /** Non-interactive auth provider (`auth` | `clerk` | `auth0`). */
    provider?: string;
    /** Override the git ref (branch, tag, or commit) registry items are fetched from. */
    ref?: string;
    /** Override the remote registry source base. */
    source?: string;
    /** Skip the provider prompt and use the default. */
    yes?: boolean;
}

interface AddFeatureResult {
    code: number;
    /** Registry items applied (for tests / callers). May be a bare passthrough name. */
    items: ReadonlyArray<string>;
}

/** Map a `--provider` value to a registry item, or `undefined` if unrecognized. */
const providerToItem = (provider: string): FeatureItem | undefined => {
    const value = provider.trim().toLowerCase();
    const match = AUTH_PROVIDER_OPTIONS.find(
        (option) =>
            option.value === value ||
            option.label.toLowerCase() === value ||
            (value === "auth0" && option.value === "auth-auth0") ||
            (value === "clerk" && option.value === "auth-clerk"),
    );

    return match?.value;
};

/** Read the project's merged (deps + devDeps) dependency map; `{}` if unreadable. */
const readProjectDependencies = (cwd: string): Record<string, string> => {
    try {
        const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        return { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
        return {};
    }
};

/**
 * Resolve which per-framework auth-UI item to install: auto-detect from the
 * project's dependencies, else prompt (or take the React default under `--yes`).
 */
const resolveAuthUiItem = async (options: AddFeatureOptions): Promise<FeatureItem> => {
    const cwd = options.cwd ?? process.cwd();
    const detected = detectAuthUiItem(readProjectDependencies(cwd));

    if (detected !== undefined) {
        return detected;
    }

    if (options.yes === true) {
        options.logger.warn(
            `add: couldn't detect your framework — using "${DEFAULT_AUTH_UI_ITEM}". Pass a specific item (e.g. \`lunora add auth-ui-vue\`) to override.`,
        );

        return DEFAULT_AUTH_UI_ITEM;
    }

    const select = options.promptSelect ?? ((message, choices, settings): Promise<FeatureItem | undefined> => tuiSelect(message, choices, settings));

    return (await select("Which framework is your app?", AUTH_UI_OPTIONS, { default: DEFAULT_AUTH_UI_ITEM })) ?? DEFAULT_AUTH_UI_ITEM;
};

/** Resolve which auth registry item to install: explicit `--provider`, the prompt, or the default. */
const resolveAuthItem = async (options: AddFeatureOptions): Promise<FeatureItem> => {
    if (options.provider !== undefined && options.provider !== "") {
        const item = providerToItem(options.provider);

        if (item === undefined) {
            options.logger.warn(`add: unknown --provider "${options.provider}" — using "${DEFAULT_AUTH_ITEM}" (email & password).`);

            return DEFAULT_AUTH_ITEM;
        }

        return item;
    }

    if (options.yes === true) {
        return DEFAULT_AUTH_ITEM;
    }

    const select = options.promptSelect ?? ((message, choices, settings): Promise<FeatureItem | undefined> => tuiSelect(message, choices, settings));

    return promptAuthProvider(select);
};

/** The injected text prompt for `add` (tests pass a fake; production uses the TUI). */
const textPrompt = (options: AddFeatureOptions): TextPrompt => options.promptText ?? ((message, settings) => tuiText(message, settings));

/**
 * Resolve the R2 bucket name for a storage add: an explicit `--bucket` wins
 * (sanitized, falling back with a warning if it's not a valid R2 name); `--yes`
 * takes the `project-uploads` default without asking; otherwise prompt. The
 * prompt + default + sanitize flow itself lives in {@link promptBucketName},
 * shared with the init offer.
 */
const resolveStorageBucketName = async (options: AddFeatureOptions): Promise<string> => {
    const projectName = basename(options.cwd ?? process.cwd());

    if (options.bucket !== undefined && options.bucket !== "") {
        const sanitized = sanitizeBucketName(options.bucket);

        if (sanitized !== undefined) {
            return sanitized;
        }

        const fallback = deriveBucketName(projectName);
        options.logger.warn(`add: "${options.bucket}" isn't a valid R2 bucket name (lowercase alphanumeric + hyphens, 3–63 chars) — using "${fallback}".`);

        return fallback;
    }

    if (options.yes === true) {
        return deriveBucketName(projectName);
    }

    return promptBucketName(textPrompt(options), projectName);
};

/**
 * Resolve the verified mail destination address, or `undefined` to keep the
 * placeholder (so no transform is applied). An explicit `--mail-to` wins;
 * `--yes` keeps the placeholder; otherwise prompt. The trim/validate/warn rules
 * live in {@link resolveTypedDestination}, shared with the init offer.
 */
const resolveMailDestination = async (options: AddFeatureOptions): Promise<string | undefined> => {
    const warn = (message: string): void => {
        options.logger.warn(`add: ${message}`);
    };

    if (options.mailTo !== undefined && options.mailTo !== "") {
        return resolveTypedDestination(options.mailTo, warn);
    }

    if (options.yes === true) {
        return undefined;
    }

    return resolveTypedDestination(await textPrompt(options)(MAIL_DESTINATION_PROMPT, { placeholder: "you@yourdomain.com" }), warn);
};

/**
 * Resolve the D1 database name for an auth add: an explicit `--db` wins
 * (sanitized, falling back with a warning if unusable); `--yes` takes the
 * `project-db` default without asking; otherwise prompt. The prompt flow lives
 * in {@link promptDatabaseName}, shared with the init offer.
 */
const resolveAuthDatabaseName = async (options: AddFeatureOptions): Promise<string> => {
    const projectName = basename(options.cwd ?? process.cwd());

    if (options.db !== undefined && options.db !== "") {
        const sanitized = sanitizeDatabaseName(options.db);

        if (sanitized !== undefined) {
            return sanitized;
        }

        const fallback = deriveDatabaseName(projectName);
        options.logger.warn(`add: "${options.db}" isn't a usable D1 database name — using "${fallback}".`);

        return fallback;
    }

    if (options.yes === true) {
        return deriveDatabaseName(projectName);
    }

    return promptDatabaseName(textPrompt(options), projectName);
};

/** Resolve the registry item(s) a normalized feature installs. */
const resolveFeatureItems = async (feature: NormalizedFeature, options: AddFeatureOptions): Promise<ReadonlyArray<string>> => {
    if (feature.kind === "auth") {
        return [await resolveAuthItem(options)];
    }

    if (feature.kind === "auth-ui") {
        return [await resolveAuthUiItem(options)];
    }

    if (feature.kind === "email") {
        return [EMAIL_ITEM];
    }

    // Bare registry item name — handed straight to runAddCommand.
    return [feature.item];
};

/**
 * Keep the project's linters and formatters in step with what Lunora generates.
 *
 * Run after every successful `add` rather than only at `init`, because a feature
 * install is exactly when the generated surface grows — and a project that
 * adopted Prettier or Biome after `lunora init` would otherwise never be
 * configured at all.
 *
 * Detection-driven with no prompt: `add` already knows the project (it refuses
 * to run outside one), so asking again would be asking a question the manifest
 * answers. Every writer is idempotent, so the common case is silent.
 */
const syncLintIgnores = (cwd: string, logger: Logger): void => {
    reportLintIgnoreOutcomes(applyLintIgnores(cwd, detectLintTools(cwd)), logger);
};

/**
 * Whether `lunora add` may skip the registry's own confirmation prompt.
 *
 * Running `lunora add` IS the opt-in for the package.json / wrangler mutations
 * the FIRST-PARTY registry declares, so those need no second confirmation. It is
 * NOT an opt-in for a registry the user pointed at: that gate (in
 * `confirmDepMutation`) hangs off the same `yes` flag, and passing `true`
 * unconditionally disarmed it — `lunora registry add … --source gh:attacker/evil`
 * refused while `lunora add` wrote files, deps, wrangler bindings and `.dev.vars`
 * at exit 0. `--from` is the same kind of origin as `--source` (see
 * {@link isCustomRegistrySource}), and was the half that still skipped it.
 */
const autoConfirmRegistryApply = (options: AddFeatureOptions): boolean => !isCustomRegistrySource(options) || options.yes === true;

/**
 * `lunora add <feature>`: validate we're in a Lunora project, resolve the
 * feature to its registry item(s) (prompting for the auth provider when
 * interactive), and apply via `runAddCommand`. Returns the applied items so
 * tests/callers can assert without re-reading the filesystem.
 */
const runAddFeature = async (options: AddFeatureOptions): Promise<AddFeatureResult> => {
    const cwd = options.cwd ?? process.cwd();

    const feature = options.feature === undefined ? undefined : normalizeFeature(options.feature);

    if (feature === undefined) {
        options.logger.error("add requires a feature or registry item. Usage: lunora add <auth|email|storage|crons|presence|…>");

        return { code: 1, items: [] };
    }

    // Must be inside a Lunora project: a `lunora/` source dir + a wrangler config.
    if (!existsSync(join(cwd, "lunora")) || findWranglerFile(cwd) === undefined) {
        options.logger.error("add: not a Lunora project here (need a lunora/ directory and a wrangler.jsonc). Run `lunora init` first.");

        return { code: 1, items: [] };
    }

    // Every auth-UI port renders DOM. On React Native the React payload would
    // install and type-check, then render nothing — so say that instead of
    // shipping `div`s into a Metro bundle. `auth` (the server half) is
    // unaffected and `@lunora/react-native/auth` covers the client half.
    if (feature.kind === "auth-ui" && isReactNativeProject(readProjectDependencies(cwd))) {
        options.logger.error(
            "add: auth-ui has no React Native port — the screens render DOM elements and a stylesheet, which Metro has nothing to mount. Build the screens with React Native primitives against the same better-auth client (`@lunora/react-native/auth`); `lunora add auth` still installs the server half.",
        );

        return { code: 1, items: [] };
    }

    const items = await resolveFeatureItems(feature, options);

    // Several items ship `REPLACE_ME` placeholders in their bindings. Resolve real
    // values (flag / prompt / project-derived default) and inject them into the
    // manifests before they're written, matching the init offer's DX. Each
    // transform no-ops on items it doesn't match, so composing them is safe.
    const transforms: ((manifest: RegistryManifest) => RegistryManifest)[] = [];

    if (items.includes("storage")) {
        const bucketName = await resolveStorageBucketName(options);

        transforms.push((manifest) => withStorageBucketName(manifest, bucketName));
    }

    if (items.includes("mail")) {
        const destination = await resolveMailDestination(options);

        if (destination !== undefined) {
            transforms.push((manifest) => withMailDestination(manifest, destination));
        }
    }

    // Every auth-family item (auth, auth-clerk, auth-auth0, the plugins) pulls in
    // the base `auth` item via `requires`, which carries the D1 binding — so name
    // its database whenever any auth item is requested. The transform no-ops on
    // the provider/plugin manifests and rewrites the base `auth` one.
    if (items.some((name) => name === "auth" || name.startsWith("auth-"))) {
        const databaseName = await resolveAuthDatabaseName(options);

        transforms.push((manifest) => withAuthDatabaseName(manifest, databaseName));
    }

    const transformManifest =
        transforms.length > 0
            ? (manifest: RegistryManifest): RegistryManifest => {
                  let result = manifest;

                  for (const transform of transforms) {
                      result = transform(result);
                  }

                  return result;
              }
            : undefined;

    const result = await runAddCommand({
        allowUnsafeSource: options.allowUnsafeSource,
        confirm: options.confirm,
        cwd,
        from: options.from,
        logger: options.logger,
        names: [...items],
        ref: options.ref,
        source: options.source,
        transformManifest,
        yes: autoConfirmRegistryApply(options),
    });

    if (result.code === 0) {
        syncLintIgnores(cwd, options.logger);
    }

    return { code: result.code, items };
};

/** `lunora add <feature>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<AddOptions> = defineHandler<AddOptions>(async ({ argument, cwd, logger, options }) => {
    const formatError = validateOutputFormat("add", options.format);

    if (formatError !== undefined) {
        logger.error(formatError);

        return { code: 1 };
    }

    // In `--format json` mode every human/progress line goes to stderr so
    // stdout carries only the serialized structured result.
    const effectiveLogger = loggerForFormat(options.format, logger);

    const result = await runAddFeature({
        allowUnsafeSource: options.allowUnsafeSource === true,
        bucket: options.bucket,
        cwd,
        db: options.db,
        feature: argument[0],
        from: options.from,
        logger: effectiveLogger,
        mailTo: options.mailTo,
        provider: options.provider,
        ref: options.ref,
        source: options.source,
        yes: options.yes === true,
    });

    if (isJsonFormat(options.format)) {
        printJson({ code: result.code, items: result.items });
    }

    return { code: result.code };
});

export { execute, runAddFeature };
export type { AddFeatureOptions, AddFeatureResult };
