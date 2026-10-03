import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { Node, Project, SyntaxKind } from "ts-morph";

import join from "./path";

/** The directory every Lunora tool assumes when the project names none. */
const DEFAULT_SCHEMA_DIRECTORY = "lunora";

/** The config files Vite itself probes, in its order. */
const VITE_CONFIG_FILES = ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.cjs", "vite.config.mts", "vite.config.cts"] as const;

/** The package the `lunora()` Vite plugin is imported from, and its export name. */
const PLUGIN_SPECIFIER = "@lunora/vite";
const PLUGIN_EXPORT = "lunora";

/**
 * The project's Lunora source directory (the plugin's `schemaDir`), read the way
 * `@lunora/vite` sees it: the `schemaDir` string literal passed to the `lunora()`
 * call in `vite.config.*`, else `"lunora"`. The CLI commands that scan the
 * project (`dev`, `deploy`, `doctor`, `env`, `codegen`) resolve it here, so a
 * project that moved its functions to `backend/` gets its `ctx.*` reads and
 * schema facts read from `backend/` instead of from a directory that does not
 * exist.
 *
 * Parsed, never evaluated: a CLI command must not run the project's build
 * config. A computed `schemaDir`, or a plugin reached any other way, is not seen
 * and falls back to the default — the same answer as before this was read.
 */
const resolveSchemaDirectory = (projectRoot: string): string => {
    const configPath = VITE_CONFIG_FILES.map((file) => join(projectRoot, file)).find((path) => existsSync(path));

    if (configPath === undefined) {
        return DEFAULT_SCHEMA_DIRECTORY;
    }

    let source: string;

    try {
        source = readFileSync(configPath, "utf8");
    } catch {
        return DEFAULT_SCHEMA_DIRECTORY;
    }

    const sourceFile = new Project({
        compilerOptions: { allowJs: true },
        skipFileDependencyResolution: true,
        skipLoadingLibFiles: true,
        useInMemoryFileSystem: true,
    }).createSourceFile(basename(configPath), source);
    const pluginNames = new Set(
        sourceFile
            .getImportDeclarations()
            .filter((declaration) => declaration.getModuleSpecifierValue() === PLUGIN_SPECIFIER)
            .flatMap((declaration) => declaration.getNamedImports())
            .filter((named) => named.getName() === PLUGIN_EXPORT)
            .map((named) => named.getAliasNode()?.getText() ?? PLUGIN_EXPORT),
    );

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const [options] = call.getArguments();

        if (!pluginNames.has(call.getExpression().getText()) || !Node.isObjectLiteralExpression(options)) {
            continue;
        }

        const property = options.getProperty("schemaDir");
        const value = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;

        if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
            return value.getLiteralValue();
        }
    }

    return DEFAULT_SCHEMA_DIRECTORY;
};

export default resolveSchemaDirectory;
