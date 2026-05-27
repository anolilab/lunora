import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { dirname, join, resolve } from "@visulima/path";

import type { Logger } from "../util/logger.js";
import { appendTableToSchema, formatTableBlock } from "../util/schemaEditor.js";

export type FunctionKind = "action" | "mutation" | "query";
export type GeneratorKind = FunctionKind | "package" | "table";

export interface NewCommandOptions {
    /** Category tag for new packages — unused for query/mutation/action/table. */
    category?: string;
    cwd?: string;
    /** Description for new packages. */
    description?: string;
    kind: GeneratorKind;
    logger: Logger;
    /** Name of the thing being created (camelCase enforced for code, dashCase for packages). */
    name: string;
    /** Override the templates root (used by tests). */
    templateRoot?: string;
}

export interface NewCommandResult {
    /** Files written (or in the case of `table`, including the mutated schema.ts). */
    files: ReadonlyArray<string>;
    code: number;
}

const FUNCTION_KINDS: ReadonlySet<GeneratorKind> = new Set<GeneratorKind>(["action", "mutation", "query"]);

const camelCase = (input: string): string => {
    return input.replace(/[-_\s]+(\w)/gu, (_, c: string) => c.toUpperCase()).replace(/^[A-Z]/u, (c) => c.toLowerCase());
};

const dashCase = (input: string): string => {
    return input
        .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
        .replace(/[_\s]+/gu, "-")
        .toLowerCase();
};

const isIdentifier = (value: string): boolean => /^[A-Za-z_][\w$]*$/u.test(value);

const isPackageName = (value: string): boolean => /^[a-z][\da-z-]*$/u.test(value);

const defaultTemplateRoot = (): string => {
    const here = dirname(fileURLToPath(import.meta.url));

    // src/commands -> package root -> plop-templates/generators/
    return resolve(here, "..", "..", "plop-templates", "generators");
};

/**
 * Tiny handlebars-subset renderer. Supports `{{name}}`, `{{camelCase name}}`,
 * `{{dashCase name}}` and `{{description}}` / `{{category}}`. Intentionally
 * minimal: full plop/handlebars is overkill for these tiny scaffolds.
 */
const render = (template: string, data: Record<string, string>): string => {
    return template.replace(/\{\{\s*(camelCase|dashCase)?\s*(\w+)\s*\}\}/gu, (_, helper: string | undefined, key: string) => {
        const raw = data[key] ?? "";

        if (helper === "camelCase") {
            return camelCase(raw);
        }

        if (helper === "dashCase") {
            return dashCase(raw);
        }

        return raw;
    });
};

const writeFile = (target: string, contents: string): void => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
};

const generateFunction = (
    kind: FunctionKind,
    options: NewCommandOptions,
    cwd: string,
    templateRoot: string,
): NewCommandResult => {
    if (!isIdentifier(camelCase(options.name))) {
        options.logger.error(`invalid ${kind} name: "${options.name}" — must be a valid JS identifier`);

        return { code: 1, files: [] };
    }

    const cirrusDir = join(cwd, "cirrus");
    const file = join(cirrusDir, `${camelCase(options.name)}.ts`);

    if (existsSync(file)) {
        options.logger.error(`file already exists: ${file}`);

        return { code: 1, files: [] };
    }

    const tplPath = join(templateRoot, kind, "function.ts.hbs");

    if (!existsSync(tplPath)) {
        options.logger.error(`template not found: ${tplPath}`);

        return { code: 1, files: [] };
    }

    const tpl = readFileSync(tplPath, "utf8");
    const contents = render(tpl, { name: options.name });

    writeFile(file, contents);
    options.logger.success(`created ${kind}: ${file}`);

    return { code: 0, files: [file] };
};

const generateTable = (options: NewCommandOptions, cwd: string, templateRoot: string): NewCommandResult => {
    const tableName = camelCase(options.name);

    if (!isIdentifier(tableName)) {
        options.logger.error(`invalid table name: "${options.name}" — must be a valid JS identifier`);

        return { code: 1, files: [] };
    }

    const schemaPath = join(cwd, "cirrus", "schema.ts");

    if (!existsSync(schemaPath)) {
        // No schema yet — write a fresh one from the template.
        const tplPath = join(templateRoot, "table", "schema.ts.hbs");

        if (!existsSync(tplPath)) {
            options.logger.error(`template not found: ${tplPath}`);

            return { code: 1, files: [] };
        }

        const tpl = readFileSync(tplPath, "utf8");
        const contents = render(tpl, { name: tableName });

        writeFile(schemaPath, contents);
        options.logger.success(`created schema with table "${tableName}": ${schemaPath}`);

        return { code: 0, files: [schemaPath] };
    }

    // Schema exists — append a new defineTable() entry.
    const original = readFileSync(schemaPath, "utf8");

    if (new RegExp(`\\b${tableName}\\s*:\\s*defineTable\\b`, "u").test(original)) {
        options.logger.error(`table "${tableName}" already exists in ${schemaPath}`);

        return { code: 1, files: [] };
    }

    const block = formatTableBlock(tableName);
    const next = appendTableToSchema(original, tableName, block);

    if (next === undefined) {
        options.logger.error(
            `could not locate defineSchema({ ... }) in ${schemaPath} — add the table manually:\n${block}`,
        );

        return { code: 1, files: [] };
    }

    writeFileSync(schemaPath, next, "utf8");
    options.logger.success(`added table "${tableName}" to ${schemaPath}`);

    return { code: 0, files: [schemaPath] };
};

const generatePackage = (options: NewCommandOptions, cwd: string, templateRoot: string): NewCommandResult => {
    const pkgName = dashCase(options.name);

    if (!isPackageName(pkgName)) {
        options.logger.error(`invalid package name: "${options.name}" — lowercase letters, digits and dashes only`);

        return { code: 1, files: [] };
    }

    // Detect monorepo root by walking up from cwd looking for pnpm-workspace.yaml.
    const findMonorepoRoot = (start: string): string | undefined => {
        let dir = resolve(start);

        for (let i = 0; i < 8; i += 1) {
            if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
                return dir;
            }

            const parent = dirname(dir);

            if (parent === dir) {
                return undefined;
            }

            dir = parent;
        }

        return undefined;
    };

    const monorepoRoot = findMonorepoRoot(cwd);

    if (!monorepoRoot) {
        options.logger.error("`cirrus new package` must be run inside the Cirrus monorepo (no pnpm-workspace.yaml found upward)");

        return { code: 1, files: [] };
    }

    const target = join(monorepoRoot, "packages", `cirrus-${pkgName}`);

    if (existsSync(target) && readdirSync(target).length > 0) {
        options.logger.error(`target directory not empty: ${target}`);

        return { code: 1, files: [] };
    }

    const data: Record<string, string> = {
        category: options.category ?? "add-on",
        description: options.description ?? `@cirrus/${pkgName} package.`,
        name: pkgName,
    };

    const files: { rel: string; from: string }[] = [
        { from: "package.json.hbs", rel: "package.json" },
        { from: "tsconfig.json.hbs", rel: "tsconfig.json" },
        { from: "vitest.config.ts.hbs", rel: "vitest.config.ts" },
        { from: "packem.config.ts.hbs", rel: "packem.config.ts" },
        { from: "project.json.hbs", rel: "project.json" },
        { from: ".releaserc.json.hbs", rel: ".releaserc.json" },
        { from: "README.md.hbs", rel: "README.md" },
        { from: "src/index.ts.hbs", rel: "src/index.ts" },
    ];

    const written: string[] = [];

    for (const entry of files) {
        const tplPath = join(templateRoot, "package", entry.from);

        if (!existsSync(tplPath)) {
            options.logger.error(`template not found: ${tplPath}`);

            return { code: 1, files: written };
        }

        const tpl = readFileSync(tplPath, "utf8");
        const dest = join(target, entry.rel);

        writeFile(dest, render(tpl, data));
        written.push(dest);
    }

    options.logger.success(`scaffolded @cirrus/${pkgName} at ${target}`);
    options.logger.info("next steps:");
    options.logger.info("  pnpm install");
    options.logger.info(`  pnpm --filter @cirrus/${pkgName} test`);

    return { code: 0, files: written };
};

export const runNewCommand = (options: NewCommandOptions): NewCommandResult => {
    const cwd = options.cwd ?? process.cwd();
    const templateRoot = options.templateRoot ?? defaultTemplateRoot();

    if (FUNCTION_KINDS.has(options.kind)) {
        return generateFunction(options.kind as FunctionKind, options, cwd, templateRoot);
    }

    if (options.kind === "table") {
        return generateTable(options, cwd, templateRoot);
    }

    if (options.kind === "package") {
        return generatePackage(options, cwd, templateRoot);
    }

    options.logger.error(`unknown generator: ${String(options.kind)}`);

    return { code: 1, files: [] };
};
