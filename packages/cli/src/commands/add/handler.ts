import { existsSync } from "node:fs";

import { findWranglerFile, promptSelect } from "@lunora/config";
import { join } from "@visulima/path";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { runAddCommand } from "../registry";
import type { FeatureItem, NormalizedFeature } from "./features";
import { AUTH_PROVIDER_OPTIONS, DEFAULT_AUTH_ITEM, EMAIL_ITEM, normalizeFeature, promptAuthProvider } from "./features";
import type { AddOptions } from "./index";

interface AddFeatureOptions {
    allowUnsafeSource?: boolean;
    cwd?: string;
    /** The raw `&lt;feature>` argument: an alias (`auth` | `email` | `mail`) or a bare registry item name. */
    feature?: string;
    /** Local registry root (offline / tests). */
    from?: string;
    logger: Logger;
    /** Inject the provider prompt (tests). */
    promptSelect?: (
        message: string,
        options: ReadonlyArray<{ description?: string; label: string; value: FeatureItem }>,
        settings?: { default?: FeatureItem },
    ) => Promise<FeatureItem | undefined>;
    /** Non-interactive auth provider (`auth` | `clerk` | `auth0`). */
    provider?: string;
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

    const select = options.promptSelect ?? ((message, choices, settings): Promise<FeatureItem | undefined> => promptSelect(message, choices, settings));

    return promptAuthProvider(select);
};

/** Resolve the registry item(s) a normalized feature installs. */
const resolveFeatureItems = async (feature: NormalizedFeature, options: AddFeatureOptions): Promise<ReadonlyArray<string>> => {
    if (feature.kind === "auth") {
        return [await resolveAuthItem(options)];
    }

    if (feature.kind === "email") {
        return [EMAIL_ITEM];
    }

    // Bare registry item name — handed straight to runAddCommand.
    return [feature.item];
};

/**
 * `lunora add &lt;feature>`: validate we're in a Lunora project, resolve the
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

    const items = await resolveFeatureItems(feature, options);

    // The act of running `lunora add` IS the opt-in, so skip the registry's
    // package.json-mutation confirmation (yes: true) and apply directly.
    const result = await runAddCommand({
        allowUnsafeSource: options.allowUnsafeSource,
        cwd,
        from: options.from,
        logger: options.logger,
        names: [...items],
        source: options.source,
        yes: true,
    });

    return { code: result.code, items };
};

/** `lunora add &lt;feature>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<AddOptions> = defineHandler<AddOptions>(async ({ argument, cwd, logger, options }) => {
    const result = await runAddFeature({
        allowUnsafeSource: options.allowUnsafeSource === true,
        cwd,
        feature: argument[0],
        from: options.from,
        logger,
        provider: options.provider,
        source: options.source,
        yes: options.yes === true,
    });

    return { code: result.code };
});

export { execute, runAddFeature };
export type { AddFeatureOptions, AddFeatureResult };
