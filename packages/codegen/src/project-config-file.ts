/**
 * `lunora.config.*` — the project's single authored config file, read on the HOST.
 *
 * It replaces `lunora.json`, and it carries what that file carried (`target`,
 * `remote`) plus the `app` hook a Vite-first project composes its worker with.
 * One file, because the two were always the same question — "how is this project
 * wired?" — split across a format boundary that only existed because the CLI had
 * no way to read TypeScript.
 *
 * Read two ways, on purpose.
 *
 * `loadProjectConfig` EVALUATES it with `jiti`, so a computed value works — but
 * `jiti`'s non-deprecated entry point is `await jiti.import()`, so it is async
 * and only callers that can await it use it (`@lunora/vite`, whose hooks can).
 *
 * The literal reader PARSES the default export's object literal for
 * `target` and `remote`. `runCodegen` is synchronous and resolves `target`
 * inside itself, so those two have to be answerable without awaiting; making
 * them async would turn `runCodegen` async and ripple through every command and
 * the Vite plugin. The cost is narrow and stated: a literal `target`/`remote`
 * is read, a computed one is not — which is what the documented shape uses, and
 * what the JSON file it replaces could express anyway.
 *
 * This lives in `@lunora/codegen` rather than `@lunora/config` for the reason
 * `readProjectTarget` always did: `@lunora/config` depends on `@lunora/codegen`,
 * not the reverse, so putting the loader there and importing it here would invert
 * the edge. There is still exactly one loader for the file.
 *
 * The `app` hook is ALSO bundled into the worker by `@lunora/vite`, which is why
 * the documented shape uses a type-only `satisfies` rather than a runtime
 * `defineConfig` import: a runtime import in this file would be dragged into the
 * worker bundle, and a host-only one would break it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { createJiti } from "jiti";
import type { ObjectLiteralExpression, PropertyAssignment, SourceFile } from "ts-morph";
import { Node as TsNode, Project } from "ts-morph";

/** The config file's base name; the extension is whichever of {@link PROJECT_CONFIG_EXTENSIONS} exists. */
const PROJECT_CONFIG_BASENAME = "lunora.config";

/**
 * Extensions probed, in order. TypeScript first because that is what the
 * templates ship and what the type-only `satisfies` needs; the JS forms are
 * accepted so a JS-authored project is not forced into TypeScript for one file.
 */
const PROJECT_CONFIG_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;

/** The structural slice of `lunora.config.*` Lunora reads. Unvalidated on purpose — see {@link loadProjectConfig}. */
interface LunoraProjectConfig {
    /** The `app` hook: receives the generated `defineApp()` builder and returns it. Read by `@lunora/vite`, not by the CLI. */
    app?: unknown;
    /** Remote-binding dev preference. */
    remote?: unknown;
    /** Deploy target id. */
    target?: unknown;
}

/** The resolved config file, or `undefined` when the project ships none. */
const findProjectConfigFile = (projectRoot: string): string | undefined =>
    PROJECT_CONFIG_EXTENSIONS.map((extension) => join(projectRoot, `${PROJECT_CONFIG_BASENAME}${extension}`)).find((candidate) => existsSync(candidate));

/**
 * Memoized per path + mtime so a long-lived process (the dev server) picks up an
 * edit, and a short-lived one (any CLI command) transpiles once. A miss builds a
 * fresh `jiti` instance deliberately: `jiti` caches modules internally, and a
 * reused instance would hand back the stale config it already compiled.
 */
const cache = new Map<string, Promise<LunoraProjectConfig | undefined>>();

/**
 * Load `lunora.config.*`, or `undefined` when there is nothing usable.
 *
 * Best-effort and unvalidated, exactly as the `lunora.json` reader was: a missing
 * file, a config that throws, or a non-object default export all collapse to
 * `undefined` rather than breaking a command that would otherwise run. An
 * unrecognized `target` NAME is passed through untouched so the caller's registry
 * lookup rejects it — swallowing a typo into the default would ship an app to the
 * wrong provider.
 */
const loadProjectConfig = async (projectRoot: string): Promise<LunoraProjectConfig | undefined> => {
    const configPath = findProjectConfigFile(projectRoot);

    if (configPath === undefined) {
        return undefined;
    }

    let key: string;

    try {
        key = `${configPath}:${String(statSync(configPath).mtimeMs)}`;
    } catch {
        return undefined;
    }

    const cached = cache.get(key);

    if (cached !== undefined) {
        return cached;
    }

    const pending = (async (): Promise<LunoraProjectConfig | undefined> => {
        try {
            // `interopDefault` makes the returned namespace read through to a
            // default export, so `export default { … }` (the documented shape) and
            // named exports are the same object here — no unwrapping, and no
            // second shape to support in this file.
            const loaded = await createJiti(configPath, { interopDefault: true }).import(configPath);

            return loaded !== null && typeof loaded === "object" ? loaded : undefined;
        } catch {
            return undefined;
        }
    })();

    cache.set(key, pending);

    return pending;
};

/**
 * The `target` and `remote` LITERALS declared in the config, without evaluating
 * it — see the module header for why these two are read this way.
 *
 * Parsed, not regexed: the value must be a real string/boolean literal on the
 * default export's object, so a key mentioned in a comment or a string decides
 * nothing. A `satisfies` / `as` wrapper is unwrapped, because that is the
 * documented shape. Anything else — a computed value, a spread, no config at
 * all — reads as absent, exactly as a missing key did before.
 */

/**
 * The object literal a config file default-exports, or `undefined` when it does
 * not export one. A `satisfies` / `as` / parenthesised wrapper is unwrapped,
 * because that is the documented shape.
 */
const defaultExportObject = (sourceFile: SourceFile): ObjectLiteralExpression | undefined => {
    const assignment = sourceFile.getExportAssignments().find((candidate) => !candidate.isExportEquals());
    let expression = assignment?.getExpression();

    while (
        expression !== undefined &&
        (TsNode.isSatisfiesExpression(expression) || TsNode.isAsExpression(expression) || TsNode.isParenthesizedExpression(expression))
    ) {
        expression = expression.getExpression();
    }

    return expression !== undefined && TsNode.isObjectLiteralExpression(expression) ? expression : undefined;
};

/**
 * One property's key, with a string-literal key's quotes removed.
 *
 * `getName()` keeps them, so `{ "target": … }` — perfectly valid TypeScript —
 * read as the name `"target"` and was silently ignored.
 */
const propertyKey = (property: PropertyAssignment): string => {
    const nameNode = property.getNameNode();

    return TsNode.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText();
};

/**
 * The `target` and `remote` LITERALS declared in the config, without evaluating
 * it — see the module header for why these two are read this way.
 *
 * Parsed, not regexed: the value must be a real string/boolean literal on the
 * default export's object, so a key mentioned in a comment or a string decides
 * nothing. Anything else — a computed value, a spread, no config at all — reads
 * as absent, exactly as a missing key did before.
 */
const readProjectConfigLiterals = (projectRoot: string): Pick<LunoraProjectConfig, "remote" | "target"> => {
    const configPath = findProjectConfigFile(projectRoot);

    if (configPath === undefined) {
        return {};
    }

    let source: string;

    try {
        source = readFileSync(configPath, "utf8");
    } catch {
        return {};
    }

    const project = new Project({
        compilerOptions: { allowJs: true },
        skipFileDependencyResolution: true,
        skipLoadingLibFiles: true,
        useInMemoryFileSystem: true,
    });
    const object = defaultExportObject(project.createSourceFile(basename(configPath), source, { overwrite: true }));
    const literals: Pick<LunoraProjectConfig, "remote" | "target"> = {};

    for (const property of object?.getProperties() ?? []) {
        if (!TsNode.isPropertyAssignment(property)) {
            continue;
        }

        const key = propertyKey(property);
        const value = property.getInitializer();

        if (value === undefined) {
            continue;
        }

        if (key === "target" && TsNode.isStringLiteral(value)) {
            literals.target = value.getLiteralValue();
        }

        if (key === "remote" && (TsNode.isTrueLiteral(value) || TsNode.isFalseLiteral(value))) {
            literals.remote = value.getLiteralValue();
        }
    }

    return literals;
};

export type { LunoraProjectConfig };
export { findProjectConfigFile, loadProjectConfig, PROJECT_CONFIG_BASENAME, PROJECT_CONFIG_EXTENSIONS, readProjectConfigLiterals };
