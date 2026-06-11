import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { walkSync } from "@visulima/fs";
import { dirname, join, relative, resolve } from "@visulima/path";
import { downloadTemplate } from "giget";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { DetectedFramework, FrameworkDetection } from "../../util/detect-framework";
import { detectFramework } from "../../util/detect-framework";
import type { Logger } from "../../util/logger";
import { patchViteConfig } from "../../util/patch-vite-config";
import type { InitOptions } from "./index";

type Template = "astro" | "next" | "nuxt" | "standalone" | "sveltekit" | "tanstack-start-react" | "tanstack-start-solid" | "vite";

interface InitCommandOptions {
    /**
     * When true, accept `--source` values that don't start with `gh:` /
     * `github:` / `https://` or that contain `..`. Defaults to false; the CLI
     * gate exists to stop arbitrary filesystem / scheme sources from being
     * pulled without the caller opting in.
     */
    allowUnsafeSource?: boolean;
    cwd?: string;

    /**
     * Local directory containing the template subdirs (e.g. `vite/`,
     * `standalone/`). When provided, skips the network fetch entirely.
     * Useful for offline runs, the clean-machine smoke test, and unit tests.
     */
    from?: string;

    /**
     * When true, configure Cirrus into the CURRENT project (`cwd`) instead of
     * scaffolding a new directory. Finds an existing `vite.config.*` and
     * patches it via `patchViteConfig`, or creates a minimal one when absent.
     * All other scaffold options (`name`, `templateType`, `source`, `from`)
     * are ignored in this mode.
     */
    inPlace?: boolean;
    logger: Logger;
    name?: string;

    /**
     * Override the remote source giget downloads from. Default:
     * `gh:anolilab/cirrus/templates/&lt;templateType>#v&lt;cliVersion>`. Tests
     * typically use `from` instead to skip the network.
     */
    source?: string;
    templateType?: Template;
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
import { cirrus } from "@cirrus/vite";

export default defineConfig({ plugins: [cirrus()] });
`;

/** Sample `cirrus/schema.ts` written when scaffolding Cirrus into an existing app. */
const SAMPLE_SCHEMA = `import { defineSchema, defineTable, v } from "@cirrus/server";

export default defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),
});
`;

/** Sample `cirrus/messages.ts` (one query + one mutation) written alongside the schema. */
const SAMPLE_FUNCTION = `import { mutation, query, v } from "@cirrus/server";

export const list = query({
    args: { channelId: v.id("channels"), limit: v.optional(v.number()) },
    handler: async (_context, args) => {
        return { channelId: args.channelId, limit: args.limit ?? 50, messages: [] };
    },
});

export const send = mutation({
    args: { channelId: v.id("channels"), text: v.string() },
    handler: async (_context, args) => {
        return { channelId: args.channelId, text: args.text };
    },
});
`;

const DEFAULT_SOURCE_BASE = "gh:anolilab/cirrus/templates";
const DEFAULT_SOURCE_REF_FALLBACK = "alpha";

/**
 * Pin the default template ref to the CLI's own published version (`vX.Y.Z`)
 * so a given CLI release always fetches the matching template snapshot.
 * Falls back to the alpha channel when the CLI is running unpublished
 * (version `"0.0.0"`) or its package.json can't be read.
 */
const resolveCliVersion = (): string => {
    try {
        // Walk up from this module's directory to find @cirrus/cli's package.json.
        // Works whether the file is the built `dist/index.mjs` or the source under `src/`.
        let directory = dirname(fileURLToPath(import.meta.url));

        for (let index = 0; index < 5; index += 1) {
            const candidate = join(directory, "package.json");

            if (existsSync(candidate)) {
                const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };

                if (parsed.name === "@cirrus/cli" && typeof parsed.version === "string") {
                    return parsed.version;
                }
            }

            const parent = dirname(directory);

            if (parent === directory) {
                break;
            }

            directory = parent;
        }
    } catch {
        // Fall through to the fallback.
    }

    return "0.0.0";
};

const resolveDefaultSourceRef = (): string => {
    const version = resolveCliVersion();

    return version === "0.0.0" ? DEFAULT_SOURCE_REF_FALLBACK : `v${version}`;
};

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

const resolveTemplateSource = (templateType: Template, source: string | undefined): string => {
    if (source !== undefined && source.length > 0) {
        return source;
    }

    return `${DEFAULT_SOURCE_BASE}/${templateType}#${resolveDefaultSourceRef()}`;
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
const scaffoldFromRemote = async (
    source: string | undefined,
    templateType: Template,
    target: string,
    name: string,
    logger: Logger,
): Promise<InitCommandResult> => {
    const stagingRoot = mkdtempSync(join(tmpdir(), "cirrus-init-fetch-"));
    const stagingDirectory = join(stagingRoot, "template");

    try {
        const remote = resolveTemplateSource(templateType, source);

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

    logger.success(`created ${target} with cirrus() plugin`);

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

    logger.success(`patched ${viteConfigPath} — added cirrus() plugin`);

    return { code: 0, files: [viteConfigPath], target: cwd };
};

/**
 * Scaffold `cirrus/{schema,messages}.ts` into `cwd` when absent. Idempotent:
 * an existing `cirrus/schema.ts` is left untouched and reported, so re-running
 * `cirrus init --here` never double-patches the schema. Returns the list of
 * files actually written (empty when the directory already had a schema).
 */
const scaffoldCirrusDirectory = (cwd: string, logger: Logger): ReadonlyArray<string> => {
    const cirrusDirectory = join(cwd, "cirrus");
    const schemaPath = join(cirrusDirectory, "schema.ts");

    if (existsSync(schemaPath)) {
        logger.info(`cirrus/ already present — left ${schemaPath} untouched`);

        return [];
    }

    const written: string[] = [];

    try {
        mkdirSync(cirrusDirectory, { recursive: true });
        writeFileSync(schemaPath, SAMPLE_SCHEMA, "utf8");
        written.push(schemaPath);

        const functionPath = join(cirrusDirectory, "messages.ts");

        // The function file is only written when missing so a hand-edited one is
        // never clobbered on a re-run.
        if (!existsSync(functionPath)) {
            writeFileSync(functionPath, SAMPLE_FUNCTION, "utf8");
            written.push(functionPath);
        }

        logger.success(`scaffolded cirrus/ (${String(written.length)} file(s))`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`init --here: could not scaffold cirrus/: ${message}`);
    }

    return written;
};

/**
 * Per-framework "next steps" copy printed after the in-place patch. Each entry
 * names the idiomatic Cirrus adapter to install and the composition wiring
 * the user must add by hand (worker `httpRouter` for class A, hook-injection for
 * class B). This is the honest "auto-patched vs instructed" boundary: the CLI
 * scaffolds `cirrus/` and patches the Vite config; the provider + worker
 * composition is printed for the user to wire because it is framework-specific
 * and lives in files the CLI does not own.
 */
const printFrameworkNextSteps = (detection: FrameworkDetection, logger: Logger): void => {
    const { adapter, class: frameworkClass, framework } = detection;

    logger.info("");
    logger.info(`detected framework: ${framework} (class ${frameworkClass})`);
    logger.info("next steps:");
    logger.info(`  1. install the adapter:  pnpm add ${adapter} @cirrus/client @cirrus/runtime @cirrus/server`);
    logger.info("  2. run codegen:          cirrus codegen");

    if (frameworkClass === "A") {
        // Class A — Cirrus owns the worker entry: drop the framework SSR handler
        // into createWorker({ httpRouter }).
        logger.info("  3. compose one worker:   wrap your worker entry with");
        logger.info("       createWorker({ httpRouter: <your framework SSR handler>, shardDO: ShardDO, ... })");
        logger.info(`  4. add the provider:     mount the ${adapter} provider in your root layout/route`);
        logger.info("  5. make a loader live:   preloadQuery() in a loader, usePreloadedQuery() in the component");
        logger.info("     see https://cirrus.dev/docs/frameworks/reactive-loaders");
    } else if (frameworkClass === "B") {
        // Class B — the framework owns its CF adapter: Cirrus realtime is injected
        // into the framework's server entry/hooks; it keeps the rest.
        logger.info("  3. inject Cirrus:        mount Cirrus realtime under /_cirrus/* in your server hook");
        logger.info(`       (${framework} owns its Cloudflare adapter — Cirrus composes into its server entry)`);
        logger.info(`  4. add the provider:     mount the ${adapter} provider in your root layout`);
        logger.info("  5. read the guide:       https://cirrus.dev/docs/frameworks/deploy");
    } else {
        // Class C — SPA / SSR-less: client adapter + standalone Cirrus worker.
        logger.info("  3. add the provider:     wrap your app with the CirrusProvider from @cirrus/react");
        logger.info("  4. read the guide:       https://cirrus.dev/docs/frameworks/bring-your-framework");
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
 * wire Cirrus through their server entry rather than a `cirrus()` Vite plugin.
 * Returns the InitCommandResult so a hard write failure aborts the whole run.
 */
const patchOrCreateViteConfig = (cwd: string, framework: DetectedFramework, logger: Logger): InitCommandResult => {
    const viteConfigPath = findExistingViteConfig(cwd);

    if (viteConfigPath === undefined) {
        // SvelteKit/Nuxt own their build via their own config; don't drop a
        // standalone vite.config.ts on them. They get cirrus/ + instructions only.
        if (framework === "sveltekit" || framework === "nuxt" || framework === "astro") {
            logger.info(`no Vite config found — ${framework} wires Cirrus through its server entry (see next steps)`);

            return { code: 0, files: [], target: cwd };
        }

        return createMinimalViteConfig(cwd, logger);
    }

    return patchExistingViteConfig(viteConfigPath, cwd, logger);
};

/**
 * In-place mode: configure Cirrus into an existing project at `cwd`. Detects the
 * meta-framework from `package.json`, patches/creates the Vite config where
 * applicable, scaffolds `cirrus/` (schema + sample function) idempotently, and
 * prints framework-specific next steps (adapter install + provider/worker
 * wiring). Re-running is a no-op for already-patched pieces.
 *
 * Auto-patched: the Vite config (class A/C) and the `cirrus/` scaffold.
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

    const scaffolded = scaffoldCirrusDirectory(cwd, logger);

    printFrameworkNextSteps(detection, logger);

    return { code: 0, files: [...viteResult.files, ...scaffolded], target: cwd };
};

const runInitCommand = async (options: InitCommandOptions): Promise<InitCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    if (options.inPlace === true) {
        return runInPlaceInit(cwd, options.logger);
    }

    const name = options.name ?? "cirrus-app";
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

    return scaffoldFromRemote(options.source, templateType, target, name, options.logger);
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

/** `cirrus init [name]` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<InitOptions> = defineHandler<InitOptions>(({ argument, cwd, logger, options }) => {
    const templateRaw = options.template ?? "vite";
    const template: Template = isTemplate(templateRaw) ? templateRaw : "vite";

    return runInitCommand({
        allowUnsafeSource: options.allowUnsafeSource === true,
        cwd,
        from: options.from,
        inPlace: options.here === true,
        logger,
        name: argument[0],
        source: options.source,
        templateType: template,
    });
});

export { execute, isTemplate };
export type { InitCommandOptions, InitCommandResult, Template };
export { runInitCommand };
