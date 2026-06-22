import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { isInteractive, promptMultiSelect, promptSelect } from "@lunora/config";
import { walkSync } from "@visulima/fs";
import { dirname, join, relative, resolve } from "@visulima/path";
import { downloadTemplate } from "giget";

import type { CiProvider } from "../../util/ci-workflow";
import { isCiProvider, scaffoldCiWorkflow } from "../../util/ci-workflow";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { DetectedFramework, FrameworkDetection } from "../../util/detect-framework";
import { detectFramework } from "../../util/detect-framework";
import type { Logger } from "../../util/logger";
import { patchViteConfig } from "../../util/patch-vite-config";
import { resolveSourceRef } from "../../util/source-ref";
import type { FeatureItem } from "../add/features";
import { runAddCommand } from "../registry";
import type { InitOptions } from "./index";
import type { OfferDeps } from "./offer-extras";
import { offerRegistryExtras } from "./offer-extras";

type Template = "astro" | "next" | "nuxt" | "standalone" | "sveltekit" | "tanstack-start-react" | "tanstack-start-solid" | "vite";

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
     * Force the post-scaffold "add auth / email?" offer on (the `--interactive`
     * flag). When omitted, the offer runs only when stdin is a TTY. `--yes`
     * suppresses it regardless. Has no effect once {@link prompt} is injected.
     */
    interactive?: boolean;
    logger: Logger;
    name?: string;

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
    templateType?: Template;

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

    for (const source of files) {
        const relativePath = relative(sourceDirectory, source);
        const destination = join(target, relativePath);

        mkdirSync(dirname(destination), { recursive: true });

        const raw = readFileSync(source);
        const text = isTextFile(source) ? substitute(raw.toString("utf8"), name) : undefined;

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

const logScaffoldSuccess = (logger: Logger, written: ReadonlyArray<string>, target: string, name: string): void => {
    logger.success(`scaffolded ${String(written.length)} files into ${target}`);
    logger.info("next steps:");
    logger.info(`  cd ${name}`);
    logger.info("  pnpm install");
    logger.info("  pnpm dev");
};

const scaffoldFromLocal = (fromRoot: string, templateType: Template, target: string, name: string, logger: Logger): InitCommandResult => {
    const templateDirectory = join(fromRoot, templateType);

    if (!existsSync(templateDirectory)) {
        logger.error(`template not found in local source: ${templateDirectory}`);

        return { code: 1, files: [], target };
    }

    const written = copyTemplate(templateDirectory, target, name);

    logScaffoldSuccess(logger, written, target, name);

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

        logger.info(`fetching template from ${remote}`);

        const downloaded = (await downloadTemplate(remote, {
            cwd: stagingRoot,
            dir: stagingDirectory,
            force: true,
            install: false,
            silent: true,
        })) as { commit?: string; dir: string; source: string };

        // Surface the resolved provenance so the user can audit what was
        // fetched before any files are copied into the project tree.
        const staged = collectFiles(stagingDirectory);

        if (downloaded.commit) {
            logger.info(`resolved ${downloaded.source} @ ${downloaded.commit} (${String(staged.length)} file(s))`);
        } else {
            logger.info(`resolved ${downloaded.source} (${String(staged.length)} file(s))`);
        }

        const written = copyTemplate(stagingDirectory, target, name);

        logScaffoldSuccess(logger, written, target, name);

        return { code: 0, files: written, target };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`failed to download template: ${message}`);

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

    const apply = async (names: ReadonlyArray<FeatureItem>): Promise<boolean> => {
        const result = await runAddCommand({
            allowUnsafeSource: options.allowUnsafeSource,
            cwd: projectDirectory,
            from: options.registryFrom,
            logger: options.logger,
            names: [...names],
            ref: options.ref,
            source: options.registrySource,
            yes: true,
        });

        return result.code === 0;
    };

    await offerRegistryExtras({
        apply,
        interactive,
        logger: options.logger,
        multiSelect: options.prompt?.multiSelect ?? ((message, choices, settings) => promptMultiSelect(message, choices, settings)),
        select: options.prompt?.select ?? ((message, choices, settings): Promise<FeatureItem | undefined> => promptSelect(message, choices, settings)),
    });
};

/** Scaffold a brand-new project directory (the non-`--here` path). */
const scaffoldNewProject = async (options: InitCommandOptions, cwd: string): Promise<InitCommandResult> => {
    const name = options.name ?? "lunora-app";
    const templateType: Template = options.templateType ?? "vite";

    if (templateType === "next") {
        options.logger.warn('template "next" is not yet available — re-run with `-t vite` or `-t standalone`.');

        return { code: 1, files: [], target: "" };
    }

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
        await maybeOfferExtras(options, result.target);
    }

    // `--ci`: drop a deploy pipeline into the scaffolded project (or `cwd` for
    // in-place init). Best-effort — never affects the scaffold exit code.
    if (result.code === 0 && options.ci !== undefined) {
        scaffoldCiWorkflow(options.inPlace === true ? cwd : result.target, options.ci, options.logger);
    }

    return result;
};

/** Narrow a raw `--template` value to a known {@link Template} (defaults to vite). */
const isTemplate = (value: unknown): value is Template =>
    value === "astro" ||
    value === "next" ||
    value === "nuxt" ||
    value === "standalone" ||
    value === "sveltekit" ||
    value === "tanstack-start-react" ||
    value === "tanstack-start-solid" ||
    value === "vite";

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
    const templateRaw = options.template ?? "vite";
    const template: Template = isTemplate(templateRaw) ? templateRaw : "vite";

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
        templateType: template,
        yes: options.yes === true,
    });
});

export { execute, isTemplate, resolveTemplateSource };
export type { InitCommandOptions, InitCommandResult, Template };
export { runInitCommand };
