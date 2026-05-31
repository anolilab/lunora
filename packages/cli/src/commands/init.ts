import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { walkSync } from "@visulima/fs";
import { dirname, join, relative, resolve } from "@visulima/path";
import { downloadTemplate } from "giget";

import type { Logger } from "../util/logger.js";

export type Template = "next" | "standalone" | "tanstack-start" | "vite";

export interface InitCommandOptions {
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
     * `gh:anolilab/cirrus/templates/<templateType>#alpha`. Tests typically
     * use `from` instead to skip the network.
     */
    source?: string;
    templateType?: Template;
}

export interface InitCommandResult {
    code: number;
    files: ReadonlyArray<string>;
    target: string;
}

const TEXT_EXTENSIONS = new Set([".gitignore", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".ts", ".tsx"]);

const DEFAULT_SOURCE_BASE = "gh:anolilab/cirrus/templates";
const DEFAULT_SOURCE_REF = "alpha";

const isTextFile = (filePath: string): boolean => {
    const lastDot = filePath.lastIndexOf(".");

    if (lastDot === -1) {
        return false;
    }

    return TEXT_EXTENSIONS.has(filePath.slice(lastDot));
};

const substitute = (content: string, name: string): string => {
    return content.replaceAll("{{name}}", name);
};

const collectFiles = (dir: string): ReadonlyArray<string> => {
    const out: string[] = [];

    for (const entry of walkSync(dir, { includeDirs: false, includeFiles: true })) {
        out.push(entry.path);
    }

    return out;
};

const copyTemplate = (sourceDir: string, target: string, name: string): ReadonlyArray<string> => {
    const files = collectFiles(sourceDir);
    const written: string[] = [];

    for (const source of files) {
        const rel = relative(sourceDir, source);
        const dest = join(target, rel);

        mkdirSync(dirname(dest), { recursive: true });

        const raw = readFileSync(source);
        const text = isTextFile(source) ? substitute(raw.toString("utf8"), name) : undefined;

        if (text === undefined) {
            writeFileSync(dest, raw);
        } else {
            writeFileSync(dest, text, "utf8");
        }

        written.push(dest);
    }

    return written;
};

const resolveTemplateSource = (templateType: Template, source: string | undefined): string => {
    if (source !== undefined && source.length > 0) {
        return source;
    }

    return `${DEFAULT_SOURCE_BASE}/${templateType}#${DEFAULT_SOURCE_REF}`;
};

const logScaffoldSuccess = (logger: Logger, written: ReadonlyArray<string>, target: string, name: string): void => {
    logger.success(`scaffolded ${written.length} files into ${target}`);
    logger.info("next steps:");
    logger.info(`  cd ${name}`);
    logger.info("  pnpm install");
    logger.info("  pnpm dev");
};

const scaffoldFromLocal = (fromRoot: string, templateType: Template, target: string, name: string, logger: Logger): InitCommandResult => {
    const templateDir = join(fromRoot, templateType);

    if (!existsSync(templateDir)) {
        logger.error(`template not found in local source: ${templateDir}`);

        return { code: 1, files: [], target };
    }

    const written = copyTemplate(templateDir, target, name);

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
    const stagingDir = join(stagingRoot, "template");

    try {
        const remote = resolveTemplateSource(templateType, source);

        logger.info(`fetching template from ${remote}`);

        await downloadTemplate(remote, {
            cwd: stagingRoot,
            dir: stagingDir,
            force: true,
            install: false,
            silent: true,
        });

        const written = copyTemplate(stagingDir, target, name);

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

export const runInitCommand = async (options: InitCommandOptions): Promise<InitCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const name = options.name ?? "cirrus-app";
    const templateType: Template = options.templateType ?? "vite";

    if (templateType === "next") {
        options.logger.warn('template "next" is not yet available — re-run with `-t vite` or `-t standalone`.');

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

    return scaffoldFromRemote(options.source, templateType, target, name, options.logger);
};
