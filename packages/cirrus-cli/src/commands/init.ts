import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { walkSync } from "@visulima/fs";
import { dirname, join, relative, resolve } from "@visulima/path";

import type { Logger } from "../util/logger.js";

export type Template = "next" | "standalone" | "vite";

export interface InitCommandOptions {
    cwd?: string;
    logger: Logger;
    name?: string;
    /** Override the templates root (useful for tests). */
    templateRoot?: string;
    templateType?: Template;
}

export interface InitCommandResult {
    code: number;
    files: ReadonlyArray<string>;
    target: string;
}

const TEXT_EXTENSIONS = new Set([".gitignore", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".ts", ".tsx"]);

const isTextFile = (filePath: string): boolean => {
    const lastDot = filePath.lastIndexOf(".");

    if (lastDot === -1) {
        return false;
    }

    return TEXT_EXTENSIONS.has(filePath.slice(lastDot));
};

const substitute = (content: string, name: string): string => {
    return content.replaceAll('{{name}}', name);
};

const collectFiles = (dir: string): ReadonlyArray<string> => {
    const out: string[] = [];

    for (const entry of walkSync(dir, { includeDirs: false, includeFiles: true })) {
        out.push(entry.path);
    }

    return out;
};

const defaultTemplateRoot = (): string => {
    const here = dirname(fileURLToPath(import.meta.url));

    // src/commands -> package root -> templates/
    return resolve(here, "..", "..", "templates");
};

export const runInitCommand = (options: InitCommandOptions): InitCommandResult => {
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

    const templateRoot = options.templateRoot ?? defaultTemplateRoot();
    const templateDir = join(templateRoot, templateType);

    if (!existsSync(templateDir)) {
        options.logger.error(`template not found: ${templateDir}`);

        return { code: 1, files: [], target };
    }

    const files = collectFiles(templateDir);
    const written: string[] = [];

    for (const source of files) {
        const rel = relative(templateDir, source);
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

    options.logger.success(`scaffolded ${written.length} files into ${target}`);
    options.logger.info("next steps:");
    options.logger.info(`  cd ${name}`);
    options.logger.info("  pnpm install");
    options.logger.info("  pnpm dev");

    return { code: 0, files: written, target };
};
