import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { walkSync } from "@visulima/fs";
import { dirname, join, relative, resolve } from "@visulima/path";
import { downloadTemplate } from "giget";

import type { Logger } from "../util/logger.js";

type Template = "next" | "standalone" | "tanstack-start" | "vite";

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

const runInitCommand = async (options: InitCommandOptions): Promise<InitCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
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

export type { InitCommandOptions, InitCommandResult, Template };
export { runInitCommand };
