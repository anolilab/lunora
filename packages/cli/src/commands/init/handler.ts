import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { isInteractive } from "@lunora/config";
import { walkSync } from "@visulima/fs";
import { basename, dirname, join, relative, resolve } from "@visulima/path";
import { downloadTemplate } from "giget";
import { applyEdits, modify } from "jsonc-parser";

import type { CiProvider } from "../../util/ci-workflow";
import { isCiProvider, scaffoldCiWorkflow } from "../../util/ci-workflow";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { DetectedFramework, FrameworkDetection } from "../../util/detect-framework";
import { detectFramework } from "../../util/detect-framework";
import type { PackageManager, PackageManagerProbe } from "../../util/detect-package-manager";
import { detectInstalledManagers, installArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import { patchViteConfig } from "../../util/patch-vite-config";
import { resolveDistTag, resolveSourceRef } from "../../util/source-ref";
import type { Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import { tuiBanner, tuiConfirm, tuiIntro, tuiMultiSelect, tuiOutro, tuiSelect, tuiText, withTuiSpinner } from "../../util/tui-prompts";
import type { FeatureItem } from "../add/features";
import { runAddCommand } from "../registry";
import type { InitOptions } from "./index";
import type { OfferDeps } from "./offer-extras";
import { offerRegistryExtras } from "./offer-extras";
import type { OverlayFramework } from "./overlay/adapters";
import { ADAPTERS, isOverlayFramework } from "./overlay/adapters";
import { applyLunoraOverlay } from "./overlay/apply";

type Template = "astro" | "next" | "nuxt" | "standalone" | "sveltekit" | "tanstack-start-react" | "tanstack-start-solid";

interface InitCommandOptions {
    /**
     * When true, accept `--source` values that don't start with `gh:` /
     * `github:` / `https://` or that contain `..`. Defaults to false; the CLI
     * gate exists to stop arbitrary filesystem / scheme sources from being
     * pulled without the caller opting in.
     */
    allowUnsafeSource?: boolean;
    /** When set, also scaffold a CI deploy pipeline for the given provider. */
    ci?: CiProvider;

    cwd?: string;

    /**
     * Local directory containing the template subdirs (e.g. `vite/`,
     * `standalone/`). When provided, skips the network fetch entirely.
     * Useful for offline runs, the clean-machine smoke test, and unit tests.
     */
    from?: string;

    /**
     * When true, configure Lunora into the CURRENT project (`cwd`) instead of
     * scaffolding a new directory. Finds an existing `vite.config.*` and
     * patches it via `patchViteConfig`, or creates a minimal one when absent.
     * All other scaffold options (`name`, `templateType`, `source`, `from`)
     * are ignored in this mode.
     */
    inPlace?: boolean;

    /**
     * Inject the post-scaffold install offer's prompts (tests). When set, the
     * offer runs regardless of TTY: `confirmInstall` drives the yes/no, and
     * `selectManager` picks among the detected managers.
     */
    installPrompt?: {
        confirmInstall: () => Promise<boolean>;
        selectManager: (managers: ReadonlyArray<PackageManager>) => Promise<PackageManager>;
    };

    /**
     * Force the post-scaffold "add auth / email?" offer on (the `--interactive`
     * flag). When omitted, the offer runs only when stdin is a TTY. `--yes`
     * suppresses it regardless. Has no effect once {@link prompt} is injected.
     */
    interactive?: boolean;

    logger: Logger;

    name?: string;

    /**
     * Local directory holding create-vite bases (one `template-&lt;id>/` subdir per
     * framework). When set with `vite`, the overlay copies the base from disk
     * instead of fetching `create-vite` over the network — offline mode + tests.
     */
    overlayBaseFrom?: string;

    /** Probe for which package managers are installed (tests). Defaults to a real `&lt;pm> --version` check. */
    packageManagerProbe?: PackageManagerProbe;

    /**
     * Inject the offer's prompts (tests). When set, the offer is treated as
     * interactive regardless of TTY, and these drive the feature multi-select
     * and the auth-provider sub-select.
     */
    prompt?: Pick<OfferDeps, "multiSelect" | "select">;

    /**
     * Override the git ref (branch, tag, or commit) the default template source
     * is fetched from. Takes precedence over the version-derived ref. Ignored
     * when `source` or `from` is set.
     */
    ref?: string;

    /** Local registry root for the offer's `runAddCommand` (offline / tests). Mirrors `from` but for registry items. */
    registryFrom?: string;
    /** Override the remote registry source base for the offer (default `gh:anolilab/lunora/registry`). */
    registrySource?: string;

    /**
     * Override the remote source giget downloads from. Default:
     * `gh:anolilab/lunora/templates/&lt;templateType>#&lt;ref>`, where `&lt;ref>` is
     * the `ref` option when set, else derived from the CLI version (pre-release
     * channels → their branch, stable → `main`). Tests typically use `from`
     * instead to skip the network.
     */
    source?: string;

    /** Spawner for the post-scaffold dependency install (tests inject a recording stub). Defaults to a real subprocess. */
    spawner?: Spawner;
    templateType?: Template;

    /**
     * Scaffold via the **create-vite overlay** for this framework (`react`,
     * `vue`, `solid`, `svelte`, `vanilla`) instead of a bespoke template: fetch
     * the official create-vite base and apply the Lunora layer on top. Takes
     * precedence over `templateType`.
     */
    vite?: string;

    /** Suppress the offer entirely (the `--yes` flag): scaffold only, print the later-setup hint. */
    yes?: boolean;
}

interface InitCommandResult {
    code: number;
    files: ReadonlyArray<string>;
    target: string;
}

const TEXT_EXTENSIONS = new Set([".gitignore", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".ts", ".tsx"]);

/** Ordered list of vite config filenames to probe during in-place init. */
const VITE_CONFIG_CANDIDATES = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"] as const;

/** Minimal vite config written when none exists during in-place init. */
const MINIMAL_VITE_CONFIG = `import { defineConfig } from "vite";
import { lunora } from "@lunora/vite";

export default defineConfig({ plugins: [lunora()] });
`;

/** Sample `lunora/schema.ts` written when scaffolding Lunora into an existing app. */
const SAMPLE_SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),
});
`;

/** Sample `lunora/messages.ts` (one query + one mutation) written alongside the schema. */
const SAMPLE_FUNCTION = `import { mutation, query, v } from "./_generated/server";

export const list = query
    .input({ channelId: v.id("channels"), limit: v.optional(v.number()) })
    .query(async ({ args }) => {
        return { channelId: args.channelId, limit: args.limit ?? 50, messages: [] };
    });

export const send = mutation
    .input({ channelId: v.id("channels"), text: v.string() })
    .mutation(async ({ args }) => {
        return { channelId: args.channelId, text: args.text };
    });
`;

const DEFAULT_SOURCE_BASE = "gh:anolilab/lunora/templates";

const isTextFile = (filePath: string): boolean => {
    const lastDot = filePath.lastIndexOf(".");

    if (lastDot === -1) {
        return false;
    }

    return TEXT_EXTENSIONS.has(filePath.slice(lastDot));
};

const substitute = (content: string, name: string): string => content.replaceAll("{{name}}", name);

/** A dependency published from this monorepo: the `lunorash` umbrella or any `@lunora/*` package. */
const isLunoraDep = (name: string): boolean => name === "lunorash" || name.startsWith("@lunora/");

/**
 * Rewrite the `@lunora/*` + `lunorash` dependency ranges in a template's
 * `package.json` to the CLI's release-channel dist-tag.
 *
 * Templates pin these at the `^0.0.0` placeholder so the monorepo's own tooling
 * stays version-agnostic, but that placeholder resolves to an empty stub package
 * on a consumer machine (and on a pre-release channel the `latest` tag is itself
 * a placeholder). Stamping each Lunora-scoped range to {@link resolveDistTag}
 * wires a scaffolded project to the same channel the running CLI shipped on —
 * the same fix `resolveDepRange` applies to registry-added deps. Non-Lunora deps
 * (react, vite, wrangler, …) are left untouched. Structural jsonc edits preserve
 * the file's formatting; a parse failure leaves the text unchanged.
 */
const stampLunoraDeps = (packageJsonText: string, distTag: string): string => {
    let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    try {
        parsed = JSON.parse(packageJsonText) as typeof parsed;
    } catch {
        return packageJsonText;
    }

    let text = packageJsonText;

    for (const section of ["dependencies", "devDependencies"] as const) {
        for (const name of Object.keys(parsed[section] ?? {})) {
            if (!isLunoraDep(name)) {
                continue;
            }

            const edits = modify(text, [section, name], distTag, { formattingOptions: { insertSpaces: true, tabSize: 4 } });

            text = applyEdits(text, edits);
        }
    }

    return text;
};

const collectFiles = (directory: string): ReadonlyArray<string> => {
    const out: string[] = [];

    for (const entry of walkSync(directory, { includeDirs: false, includeFiles: true })) {
        out.push(entry.path);
    }

    return out;
};

const copyTemplate = (sourceDirectory: string, target: string, name: string): ReadonlyArray<string> => {
    const files = collectFiles(sourceDirectory);
    const written: string[] = [];
    const distTag = resolveDistTag();

    for (const source of files) {
        const relativePath = relative(sourceDirectory, source);
        const destination = join(target, relativePath);

        mkdirSync(dirname(destination), { recursive: true });

        const raw = readFileSync(source);
        let text = isTextFile(source) ? substitute(raw.toString("utf8"), name) : undefined;

        // Pin the template's `@lunora/*` + `lunorash` placeholder ranges to the
        // CLI's release channel so the scaffold installs real code, not the
        // `^0.0.0` stub. Other deps and non-package.json files pass through.
        if (text !== undefined && basename(source) === "package.json") {
            text = stampLunoraDeps(text, distTag);
        }

        if (text === undefined) {
            writeFileSync(destination, raw);
        } else {
            writeFileSync(destination, text, "utf8");
        }

        written.push(destination);
    }

    return written;
};

const resolveTemplateSource = (templateType: Template, source: string | undefined, ref: string | undefined): string => {
    if (source !== undefined && source.length > 0) {
        return source;
    }

    return `${DEFAULT_SOURCE_BASE}/${templateType}#${resolveSourceRef(ref)}`;
};

/**
 * Defence-in-depth gate over `--source`. Refuses sources containing `..`
 * (path traversal) or sources that don't start with one of the supported
 * provider schemes. `--allow-unsafe-source` exists for users who genuinely
 * need a local-disk or custom-scheme source.
 */
const isSafeSource = (source: string): boolean => {
    if (source.includes("..")) {
        return false;
    }

    return source.startsWith("gh:") || source.startsWith("github:") || source.startsWith("https://");
};

const logScaffoldSuccess = (logger: Logger, written: ReadonlyArray<string>, target: string): void => {
    logger.success(`scaffolded ${String(written.length)} files into ${target}`);
};

/** The shell command that runs a project script with `manager` (`pnpm dev`, `npm run dev`, …). */
const runScriptCommand = (manager: PackageManager, script: string): string => {
    if (manager === "npm") {
        return `npm run ${script}`;
    }

    if (manager === "bun") {
        return `bun run ${script}`;
    }

    // pnpm / yarn run scripts by bare name.
    return `${manager} ${script}`;
};

/**
 * Print the post-scaffold "next steps". When deps were already installed (the
 * user accepted the install offer), the `install` line is dropped and the `dev`
 * line uses the chosen manager; otherwise it defaults to `pnpm`.
 */
const printNextSteps = (logger: Logger, name: string, installed: PackageManager | undefined): void => {
    const manager: PackageManager = installed ?? "pnpm";

    logger.info("next steps:");
    logger.info(`  cd ${name}`);

    if (installed === undefined) {
        logger.info(`  ${manager} install`);
    }

    logger.info(`  ${runScriptCommand(manager, "dev")}`);
};

/** The install offer runs only on a real TTY or when its prompts are injected (tests) — never auto-installs in CI. */
const offerInstallIsInteractive = (options: InitCommandOptions): boolean => options.yes !== true && (options.installPrompt !== undefined || isInteractive());

/**
 * After a successful scaffold, offer to install dependencies. Detects the
 * installed package managers (pnpm > bun > yarn > npm), confirms, then — when
 * more than one is available — lets the user pick (defaulting to the most
 * preferred). Returns the manager that installed, or `undefined` when skipped or
 * on failure (the scaffold still succeeds either way).
 */
const maybeOfferInstall = async (options: InitCommandOptions, target: string): Promise<PackageManager | undefined> => {
    if (!offerInstallIsInteractive(options)) {
        return undefined;
    }

    const managers = detectInstalledManagers(options.packageManagerProbe);
    const [defaultManager] = managers;

    if (defaultManager === undefined) {
        // No package manager on PATH — nothing to offer; the next-steps hint covers it.
        return undefined;
    }

    const confirm = options.installPrompt?.confirmInstall ?? (async (): Promise<boolean> => tuiConfirm("Install dependencies now?", { defaultYes: true }));

    if (!(await confirm())) {
        return undefined;
    }

    let manager = defaultManager;

    if (managers.length > 1) {
        manager = options.installPrompt
            ? await options.installPrompt.selectManager(managers)
            : ((await tuiSelect(
                  "Which package manager?",
                  managers.map((candidate) => {
                      return { label: candidate, value: candidate };
                  }),
                  { default: defaultManager },
              )) ?? defaultManager);
    }

    const spawner = options.spawner ?? defaultSpawner;
    const { args, command } = installArgsFor(manager);
    const result = await withTuiSpinner(`Installing dependencies with ${manager}…`, () => spawner({ args, command, cwd: target }));

    if (result.code !== 0) {
        options.logger.warn(`\`${command} install\` exited with code ${String(result.code)} — run it yourself in ${basename(target)}/.`);

        return undefined;
    }

    options.logger.success(`installed dependencies with ${manager}`);

    return manager;
};

const scaffoldFromLocal = (fromRoot: string, templateType: Template, target: string, name: string, logger: Logger): InitCommandResult => {
    const templateDirectory = join(fromRoot, templateType);

    if (!existsSync(templateDirectory)) {
        logger.error(`template not found in local source: ${templateDirectory}`);

        return { code: 1, files: [], target };
    }

    const written = copyTemplate(templateDirectory, target, name);

    logScaffoldSuccess(logger, written, target);

    return { code: 0, files: written, target };
};

/**
 * Remote-fetch path: giget pulls the template into a scratch dir, we
 * substitute `{{name}}` into text files, then move them into `target`.
 * Going through a scratch dir keeps the substitution + collision logic
 * identical to the local path so we have one rule for "what counts as a
 * text file" and one place that decides the destination layout.
 */
const scaffoldFromRemote = async (options: {
    logger: Logger;
    name: string;
    ref: string | undefined;
    source: string | undefined;
    target: string;
    templateType: Template;
}): Promise<InitCommandResult> => {
    const { logger, name, ref, source, target, templateType } = options;
    const stagingRoot = mkdtempSync(join(tmpdir(), "lunora-init-fetch-"));
    const stagingDirectory = join(stagingRoot, "template");

    try {
        const remote = resolveTemplateSource(templateType, source, ref);

        // Fetch + scaffold behind live spinners (no-op off a TTY, so CI/tests
        // stay clean). The verbose provenance is folded into one dim audit line.
        const downloaded = (await withTuiSpinner(`Fetching the ${templateType} template…`, () =>
            downloadTemplate(remote, {
                cwd: stagingRoot,
                dir: stagingDirectory,
                force: true,
                install: false,
                silent: true,
            }),
        )) as { commit?: string; dir: string; source: string };

        const staged = collectFiles(stagingDirectory);

        // One concise provenance line so the user can still audit what was pulled.
        logger.info(
            downloaded.commit
                ? `template: ${downloaded.source} @ ${downloaded.commit} (${String(staged.length)} files)`
                : `template: ${downloaded.source} (${String(staged.length)} files)`,
        );

        const written = await withTuiSpinner(`Scaffolding ${String(staged.length)} files into ${name}/…`, () =>
            Promise.resolve(copyTemplate(stagingDirectory, target, name)),
        );

        logScaffoldSuccess(logger, written, target);

        return { code: 0, files: written, target };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`failed to download template: ${message}`);

        return { code: 1, files: [], target };
    } finally {
        rmSync(stagingRoot, { force: true, recursive: true });
    }
};

/** Mirror create-vite's dotfile rename — it stores `.gitignore` etc. with a leading `_` and renames on scaffold. */
const renameCreateViteDotfiles = (directory: string): void => {
    for (const file of ["_gitignore", "_npmrc", "_gitattributes"]) {
        const from = join(directory, file);

        if (existsSync(from)) {
            renameSync(from, join(directory, `.${file.slice(1)}`));
        }
    }
};

/**
 * Overlay path: scaffold a fresh `create-vite` base for `framework` into
 * `target`, then apply the Lunora overlay. The base comes from disk
 * (`overlayBaseFrom`, offline/tests) or `create-vite` over the network.
 */
const scaffoldViteOverlay = async (options: {
    framework: OverlayFramework;
    logger: Logger;
    name: string;
    overlayBaseFrom: string | undefined;
    target: string;
}): Promise<InitCommandResult> => {
    const { framework, logger, name, overlayBaseFrom, target } = options;
    const adapter = ADAPTERS[framework];
    const stagingRoot = mkdtempSync(join(tmpdir(), "lunora-vite-base-"));

    try {
        if (overlayBaseFrom === undefined) {
            const stagingDirectory = join(stagingRoot, "base");
            const remote = `github:vitejs/vite/packages/create-vite/template-${adapter.createViteTemplate}#main`;

            await withTuiSpinner(`Fetching the ${adapter.label} (create-vite) base…`, () =>
                downloadTemplate(remote, { cwd: stagingRoot, dir: stagingDirectory, force: true, install: false, silent: true }),
            );
            renameCreateViteDotfiles(stagingDirectory);
            cpSync(stagingDirectory, target, { recursive: true });
        } else {
            const localBase = join(overlayBaseFrom, `template-${adapter.createViteTemplate}`);

            if (!existsSync(localBase)) {
                logger.error(`create-vite base not found on disk: ${localBase}`);

                return { code: 1, files: [], target };
            }

            cpSync(localBase, target, { recursive: true });
        }

        const written = await withTuiSpinner(`Applying the Lunora overlay (${adapter.label})…`, () =>
            Promise.resolve(applyLunoraOverlay({ adapter, distTag: resolveDistTag(), logger, name, target })),
        );

        logScaffoldSuccess(logger, written, target);

        return { code: 0, files: [...collectFiles(target)], target };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`failed to scaffold the ${adapter.label} base: ${message}`);

        return { code: 1, files: [], target };
    } finally {
        rmSync(stagingRoot, { force: true, recursive: true });
    }
};

/**
 * Create a minimal vite.config.ts when no vite config exists in `cwd`.
 * Returns the InitCommandResult for the in-place path.
 */
const createMinimalViteConfig = (cwd: string, logger: Logger): InitCommandResult => {
    const target = join(cwd, "vite.config.ts");

    try {
        writeFileSync(target, MINIMAL_VITE_CONFIG, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`init --in-place: could not write ${target}: ${message}`);

        return { code: 1, files: [], target: cwd };
    }

    logger.success(`created ${target} with lunora() plugin`);

    return { code: 0, files: [target], target: cwd };
};

/**
 * Patch an existing vite config file in-place: read it, call patchViteConfig,
 * and write back when changed. Logs the outcome either way.
 */
const patchExistingViteConfig = (viteConfigPath: string, cwd: string, logger: Logger): InitCommandResult => {
    let source: string;

    try {
        source = readFileSync(viteConfigPath, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`init --in-place: could not read ${viteConfigPath}: ${message}`);

        return { code: 1, files: [], target: cwd };
    }

    const result = patchViteConfig(source);

    if (!result.changed) {
        logger.info(`${viteConfigPath}: ${result.reason ?? "no changes needed"}`);

        return { code: 0, files: [], target: cwd };
    }

    try {
        writeFileSync(viteConfigPath, result.code, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`init --in-place: could not write ${viteConfigPath}: ${message}`);

        return { code: 1, files: [], target: cwd };
    }

    logger.success(`patched ${viteConfigPath} — added lunora() plugin`);

    return { code: 0, files: [viteConfigPath], target: cwd };
};

/**
 * Scaffold `lunora/{schema,messages}.ts` into `cwd` when absent. Idempotent:
 * an existing `lunora/schema.ts` is left untouched and reported, so re-running
 * `lunora init --here` never double-patches the schema. Returns the list of
 * files actually written (empty when the directory already had a schema).
 */
const scaffoldLunoraDirectory = (cwd: string, logger: Logger): ReadonlyArray<string> => {
    const lunoraDirectory = join(cwd, "lunora");
    const schemaPath = join(lunoraDirectory, "schema.ts");

    if (existsSync(schemaPath)) {
        logger.info(`lunora/ already present — left ${schemaPath} untouched`);

        return [];
    }

    const written: string[] = [];

    try {
        mkdirSync(lunoraDirectory, { recursive: true });
        writeFileSync(schemaPath, SAMPLE_SCHEMA, "utf8");
        written.push(schemaPath);

        const functionPath = join(lunoraDirectory, "messages.ts");

        // The function file is only written when missing so a hand-edited one is
        // never clobbered on a re-run.
        if (!existsSync(functionPath)) {
            writeFileSync(functionPath, SAMPLE_FUNCTION, "utf8");
            written.push(functionPath);
        }

        logger.success(`scaffolded lunora/ (${String(written.length)} file(s))`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`init --here: could not scaffold lunora/: ${message}`);
    }

    return written;
};

/**
 * Per-framework "next steps" copy printed after the in-place patch. Each entry
 * names the idiomatic Lunora adapter to install and the composition wiring
 * the user must add by hand (worker `httpRouter` for class A, hook-injection for
 * class B). This is the honest "auto-patched vs instructed" boundary: the CLI
 * scaffolds `lunora/` and patches the Vite config; the provider + worker
 * composition is printed for the user to wire because it is framework-specific
 * and lives in files the CLI does not own.
 */
const printFrameworkNextSteps = (detection: FrameworkDetection, logger: Logger): void => {
    const { adapter, class: frameworkClass, framework } = detection;

    logger.info("");
    logger.info(`detected framework: ${framework} (class ${frameworkClass})`);
    logger.info("next steps:");
    logger.info(`  1. install the adapter:  pnpm add ${adapter} @lunora/client @lunora/runtime @lunora/server`);
    logger.info("  2. run codegen:          lunora codegen");

    if (frameworkClass === "A") {
        // Class A — Lunora owns the worker entry: drop the framework SSR handler
        // into createWorker({ httpRouter }).
        logger.info("  3. compose one worker:   wrap your worker entry with");
        logger.info("       createWorker({ httpRouter: <your framework SSR handler>, shardDO: ShardDO, ... })");
        logger.info(`  4. add the provider:     mount the ${adapter} provider in your root layout/route`);
        logger.info("  5. make a loader live:   preloadQuery() in a loader, usePreloadedQuery() in the component");
        logger.info("     see https://lunora.sh/docs/frameworks/reactive-loaders");
    } else if (frameworkClass === "B") {
        // Class B — the framework owns its CF adapter: Lunora realtime is injected
        // into the framework's server entry/hooks; it keeps the rest.
        logger.info("  3. inject Lunora:        mount Lunora realtime under /_lunora/* in your server hook");
        logger.info(`       (${framework} owns its Cloudflare adapter — Lunora composes into its server entry)`);
        logger.info(`  4. add the provider:     mount the ${adapter} provider in your root layout`);
        logger.info("  5. read the guide:       https://lunora.sh/docs/frameworks/deploy");
    } else {
        // Class C — SPA / SSR-less: client adapter + standalone Lunora worker.
        logger.info("  3. add the provider:     wrap your app with the LunoraProvider from @lunora/react");
        logger.info("  4. read the guide:       https://lunora.sh/docs/frameworks/bring-your-framework");
    }

    logger.info("");
};

/** The Vite-config probe shared by the in-place path. Returns the first existing config, or undefined. */
const findExistingViteConfig = (cwd: string): string | undefined => {
    for (const candidate of VITE_CONFIG_CANDIDATES) {
        const full = join(cwd, candidate);

        if (existsSync(full)) {
            return full;
        }
    }

    return undefined;
};

/**
 * Patch (or create) the project's Vite config for the in-place path, skipping
 * the work for class-B frameworks that ship their own Cloudflare adapter and
 * wire Lunora through their server entry rather than a `lunora()` Vite plugin.
 * Returns the InitCommandResult so a hard write failure aborts the whole run.
 */
const patchOrCreateViteConfig = (cwd: string, framework: DetectedFramework, logger: Logger): InitCommandResult => {
    const viteConfigPath = findExistingViteConfig(cwd);

    if (viteConfigPath === undefined) {
        // SvelteKit/Nuxt own their build via their own config; don't drop a
        // standalone vite.config.ts on them. They get lunora/ + instructions only.
        if (framework === "sveltekit" || framework === "nuxt" || framework === "astro") {
            logger.info(`no Vite config found — ${framework} wires Lunora through its server entry (see next steps)`);

            return { code: 0, files: [], target: cwd };
        }

        return createMinimalViteConfig(cwd, logger);
    }

    return patchExistingViteConfig(viteConfigPath, cwd, logger);
};

/**
 * In-place mode: configure Lunora into an existing project at `cwd`. Detects the
 * meta-framework from `package.json`, patches/creates the Vite config where
 * applicable, scaffolds `lunora/` (schema + sample function) idempotently, and
 * prints framework-specific next steps (adapter install + provider/worker
 * wiring). Re-running is a no-op for already-patched pieces.
 *
 * Auto-patched: the Vite config (class A/C) and the `lunora/` scaffold.
 * Instructed: the adapter dependency, the provider mount, and the worker
 * `httpRouter` composition (class A) / hook injection (class B) — these live in
 * framework-owned files, so the CLI prints precise steps instead of guessing.
 */
const runInPlaceInit = (cwd: string, logger: Logger): InitCommandResult => {
    const detection = detectFramework(cwd);

    const viteResult = patchOrCreateViteConfig(cwd, detection.framework, logger);

    if (viteResult.code !== 0) {
        return viteResult;
    }

    const scaffolded = scaffoldLunoraDirectory(cwd, logger);

    printFrameworkNextSteps(detection, logger);

    return { code: 0, files: [...viteResult.files, ...scaffolded], target: cwd };
};

/**
 * Whether the post-scaffold offer should prompt. `--yes` always suppresses it;
 * otherwise it's on when prompts are injected (tests), the `--interactive` flag
 * is set, or — by default — stdin is a TTY.
 */
const offerIsInteractive = (options: InitCommandOptions): boolean =>
    options.yes !== true && (options.prompt !== undefined || (options.interactive ?? isInteractive()));

/**
 * Build the offer's real dependencies (readline prompts + `runAddCommand`) and
 * run the post-scaffold auth/email offer against `projectDir`. Interactive when
 * `--interactive` is set, prompts are injected (tests), or stdin is a TTY —
 * unless `--yes` suppresses it (then it prints the later-setup hint and applies
 * nothing). Apply is best-effort: a failed registry add is logged by
 * `runAddCommand` and never aborts the (already successful) scaffold.
 */
const maybeOfferExtras = async (options: InitCommandOptions, projectDirectory: string): Promise<void> => {
    const interactive = offerIsInteractive(options);

    // Each registry apply mutates shared project files; show a spinner while it
    // runs (no-op off a TTY, so tests/CI run bare). Behind the spinner the
    // registry command's own progress logging is muted — it writes to the same
    // stdout the live spinner repaints, which would garble the terminal — but
    // errors/warnings still surface. Off a TTY there's no spinner, so the full
    // logger is kept and CI retains the detail.
    const apply = async (names: ReadonlyArray<string>): Promise<boolean> => {
        const applyLogger: Logger = isInteractive()
            ? {
                  error: (message) => {
                      options.logger.error(message);
                  },
                  info: () => {},
                  success: () => {},
                  warn: (message) => {
                      options.logger.warn(message);
                  },
              }
            : options.logger;

        const result = await withTuiSpinner(`adding ${names.join(", ")}…`, () =>
            runAddCommand({
                allowUnsafeSource: options.allowUnsafeSource,
                cwd: projectDirectory,
                from: options.registryFrom,
                logger: applyLogger,
                names: [...names],
                ref: options.ref,
                source: options.registrySource,
                yes: true,
            }),
        );

        return result.code === 0;
    };

    // Branded framing for the interactive offer (both no-op off a TTY).
    await tuiIntro("let's finish setting up your app");

    await offerRegistryExtras({
        apply,
        interactive,
        logger: options.logger,
        multiSelect: options.prompt?.multiSelect ?? ((message, choices, settings) => tuiMultiSelect(message, choices, settings)),
        select: options.prompt?.select ?? ((message, choices, settings): Promise<FeatureItem | undefined> => tuiSelect(message, choices, settings)),
    });
};

/** Default framework when none is specified — the React create-vite overlay. */
const DEFAULT_FRAMEWORK = "react";

/**
 * The frameworks offered in the interactive picker. The create-vite frameworks
 * (`react` / `vue` / `solid` / `svelte`) scaffold via the overlay engine — the
 * official create-vite base plus the Lunora layer — while the rest are bespoke
 * Lunora templates. (`vanilla` is overlay-only via `--vite`; `next` is hidden
 * until available.)
 */
const FRAMEWORK_CHOICES: ReadonlyArray<{ description: string; label: string; value: string }> = [
    { description: "React SPA — official create-vite base + the Lunora layer (the default)", label: "React", value: "react" },
    { description: "Vue SPA — create-vite base + Lunora", label: "Vue", value: "vue" },
    { description: "Solid SPA — create-vite base + Lunora", label: "Solid", value: "solid" },
    { description: "Svelte SPA — create-vite base + Lunora", label: "Svelte", value: "svelte" },
    { description: "TanStack Start (React) — SSR with live-loader routes", label: "TanStack Start · React", value: "tanstack-start-react" },
    { description: "TanStack Start (Solid)", label: "TanStack Start · Solid", value: "tanstack-start-solid" },
    { description: "Astro + a standalone Lunora worker", label: "Astro", value: "astro" },
    { description: "Nuxt (Vue) + a standalone Lunora worker", label: "Nuxt", value: "nuxt" },
    { description: "SvelteKit + a standalone Lunora worker", label: "SvelteKit", value: "sveltekit" },
    { description: "Worker only — no frontend", label: "Standalone", value: "standalone" },
];

/** Comma-joined choice values for the non-interactive error hint. */
const CHOICE_VALUES = FRAMEWORK_CHOICES.map((choice) => choice.value).join(", ");

/** What to scaffold: a create-vite overlay framework, or a bespoke Lunora template. */
type ScaffoldChoice = { framework: string; kind: "overlay" } | { kind: "template"; templateType: Template };

/** Map a picker/flag value to a scaffold choice — create-vite frameworks overlay, everything else is a bespoke template. */
const toScaffoldChoice = (value: string): ScaffoldChoice =>
    isOverlayFramework(value) ? { framework: value, kind: "overlay" } : { kind: "template", templateType: value as Template };

/**
 * Resolve what to scaffold. An explicit `--vite` framework or `-t` template
 * wins; otherwise an interactive run shows the framework picker, and a
 * `--yes` run takes the React overlay default. The non-interactive
 * "nothing specified + no --yes" case is rejected earlier by
 * {@link nonInteractiveInitError}, so it never reaches the silent default.
 */
const resolveScaffoldChoice = async (options: InitCommandOptions): Promise<ScaffoldChoice> => {
    if (options.vite !== undefined) {
        return { framework: options.vite, kind: "overlay" };
    }

    if (options.templateType !== undefined) {
        return { kind: "template", templateType: options.templateType };
    }

    if (!isInteractive() || options.yes === true) {
        return { framework: DEFAULT_FRAMEWORK, kind: "overlay" };
    }

    return toScaffoldChoice((await tuiSelect("Which framework would you like?", FRAMEWORK_CHOICES, { default: DEFAULT_FRAMEWORK })) ?? DEFAULT_FRAMEWORK);
};

/**
 * In a non-interactive terminal `init` can't prompt for the name or template, so
 * require them on the command line instead of silently scaffolding `lunora-app`
 * with the default template. `--yes` opts into the defaults; an injected name +
 * templateType (tests) satisfies the check. Returns an error message, or
 * `undefined` when the run may proceed.
 */
const nonInteractiveInitError = (options: InitCommandOptions): string | undefined => {
    if (isInteractive() || options.yes === true) {
        return undefined;
    }

    const missing: string[] = [];

    if (options.name === undefined) {
        missing.push("a project name (`lunora init <name>`)");
    }

    if (options.templateType === undefined && options.vite === undefined) {
        missing.push(`a framework (\`-t <template>\` or \`--vite <framework>\`, one of: ${CHOICE_VALUES})`);
    }

    if (missing.length === 0) {
        return undefined;
    }

    return `lunora init can't prompt in a non-interactive terminal — provide ${missing.join(" and ")}, or pass --yes to accept the defaults.`;
};

/** Scaffold a brand-new project directory (the non-`--here` path). */
const scaffoldNewProject = async (options: InitCommandOptions, cwd: string): Promise<InitCommandResult> => {
    // Branded ASCII title at the very top of the flow (no-op off a TTY).
    await tuiBanner("realtime backend on Cloudflare Workers + Durable Objects");

    const blocked = nonInteractiveInitError(options);

    if (blocked !== undefined) {
        options.logger.error(blocked);

        return { code: 1, files: [], target: "" };
    }

    // No name argument → ask for one (a TTY shows the prompt; with `--yes` /
    // non-interactive it takes the `lunora-app` default).
    const name = options.name ?? (await tuiText("What should we call your project?", { default: "lunora-app", placeholder: "lunora-app" }));
    const choice = await resolveScaffoldChoice(options);

    // Guard the project name against path traversal: it becomes a directory
    // under cwd, so a name containing separators or `..` could scaffold outside
    // the intended parent. Mirrors the `--source` `isSafeSource` gate.
    if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
        options.logger.error(`init: refusing project name "${name}" — must not contain path separators or be "." / "..".`);

        return { code: 1, files: [], target: "" };
    }

    const target = resolve(cwd, name);

    if (existsSync(target)) {
        const entries = readdirSync(target);

        if (entries.length > 0) {
            options.logger.error(`target directory not empty: ${target}`);

            return { code: 1, files: [], target };
        }
    }

    // Overlay path: a create-vite framework (the default, `--vite`, or the
    // picker) fetches a stock create-vite base and applies the Lunora layer.
    if (choice.kind === "overlay") {
        if (!isOverlayFramework(choice.framework)) {
            options.logger.error(`init: unknown framework "${choice.framework}". Supported overlays: ${Object.keys(ADAPTERS).join(", ")}.`);

            return { code: 1, files: [], target };
        }

        mkdirSync(target, { recursive: true });

        return scaffoldViteOverlay({ framework: choice.framework, logger: options.logger, name, overlayBaseFrom: options.overlayBaseFrom, target });
    }

    const { templateType } = choice;

    if (templateType === "next") {
        options.logger.warn('template "next" is not yet available — re-run with `--vite react` or `-t standalone`.');

        return { code: 1, files: [], target };
    }

    // Local-fallback path: `--from /path/to/templates` skips the network and
    // copies straight from disk. Used by the clean-machine smoke + the unit
    // tests; also a working offline mode for end users with a pre-cloned
    // template tree.
    if (options.from !== undefined) {
        return scaffoldFromLocal(options.from, templateType, target, name, options.logger);
    }

    if (options.source !== undefined && options.source.length > 0 && !options.allowUnsafeSource && !isSafeSource(options.source)) {
        options.logger.error(
            `init: refusing --source ${options.source} — only gh:, github:, or https:// sources are allowed (and may not contain "..").` +
                " Re-run with --allow-unsafe-source if you really want this.",
        );

        return { code: 1, files: [], target };
    }

    return scaffoldFromRemote({ logger: options.logger, name, ref: options.ref, source: options.source, target, templateType });
};

/**
 * `lunora init` entry: scaffold (in-place or a new directory), then — on success
 * — offer to add auth + email via the registry. The offer never affects the
 * scaffold's exit code.
 */
const runInitCommand = async (options: InitCommandOptions): Promise<InitCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const result = options.inPlace === true ? runInPlaceInit(cwd, options.logger) : await scaffoldNewProject(options, cwd);

    if (result.code === 0 && result.target !== "") {
        // Offer the auth/email extras FIRST — they add dependencies + bindings to
        // the scaffold's package.json — then install LAST so those newly-added
        // deps are part of the single install. In-place init keeps its own
        // per-framework wiring hints and never auto-installs an existing project.
        await maybeOfferExtras(options, result.target);

        const installedManager = options.inPlace === true ? undefined : await maybeOfferInstall(options, result.target);

        if (options.inPlace !== true) {
            // Closing flourish + next steps, after the install so it's truly last.
            await tuiOutro("you're all set 🎉");
            printNextSteps(options.logger, basename(result.target), installedManager);
        }
    }

    // `--ci`: drop a deploy pipeline into the scaffolded project (or `cwd` for
    // in-place init). Best-effort — never affects the scaffold exit code.
    if (result.code === 0 && options.ci !== undefined) {
        scaffoldCiWorkflow(options.inPlace === true ? cwd : result.target, options.ci, options.logger);
    }

    return result;
};

/** Narrow a raw `--template` value to a known {@link Template}. */
const isTemplate = (value: unknown): value is Template =>
    value === "astro" ||
    value === "next" ||
    value === "nuxt" ||
    value === "standalone" ||
    value === "sveltekit" ||
    value === "tanstack-start-react" ||
    value === "tanstack-start-solid";

/** Narrow the `--ci` value to a {@link CiProvider}, warning (and ignoring it) on an unknown provider. */
const resolveCiProvider = (raw: string | undefined, logger: Logger): CiProvider | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    if (isCiProvider(raw)) {
        return raw;
    }

    logger.warn(`init: unknown --ci "${raw}" — expected github | gitlab; skipping CI scaffold.`);

    return undefined;
};

/** `lunora init [name]` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<InitOptions> = defineHandler<InitOptions>(({ argument, cwd, logger, options }) => {
    // Leave `templateType` undefined when no `-t` was passed (or an unknown one
    // was), so the scaffolder shows the interactive picker (TTY) / errors
    // (non-TTY) / takes the React-overlay default rather than a stale template.
    const templateType: Template | undefined = options.template !== undefined && isTemplate(options.template) ? options.template : undefined;

    return runInitCommand({
        allowUnsafeSource: options.allowUnsafeSource === true,
        cwd,
        ci: resolveCiProvider(options.ci, logger),
        from: options.from,
        inPlace: options.here === true,
        interactive: options.interactive === true ? true : undefined,
        logger,
        name: argument[0],
        ref: options.ref,
        source: options.source,
        templateType,
        vite: options.vite,
        yes: options.yes === true,
    });
});

export { execute, isTemplate, resolveTemplateSource };
export type { InitCommandOptions, InitCommandResult, Template };
export { runInitCommand };
