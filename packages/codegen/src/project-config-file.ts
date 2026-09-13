/**
 * `lunora.config.*` — the project's single authored config file, read on the HOST.
 *
 * It replaces `lunora.json`, and it carries what that file carried (`target`,
 * `remote`) plus the `app` hook a Vite-first project composes its worker with.
 *
 * Read two ways, on purpose.
 *
 * {@link loadProjectConfig} EVALUATES it with `jiti`, so a computed value works
 * — but `jiti`'s non-deprecated entry point is `await jiti.import()`, so it is
 * async and only callers that can await it use it (`@lunora/vite`, whose hooks
 * can).
 *
 * {@link readProjectConfigLiterals} PARSES the default export for `target` and
 * `remote`. `runCodegen` is synchronous and resolves `target` inside itself, so
 * those two have to be answerable without awaiting.
 *
 * What the parser can see, exactly: a string / boolean / object literal assigned
 * to a property of the object the default export resolves to — directly, through
 * a `satisfies` / `as` / parenthesised wrapper, or through a `const` in the same
 * file. What it CANNOT: a computed value, a getter, a spread, `module.exports`.
 * Those do not silently become the default — the reader reports `unreadable` and
 * `resolveCodegenTarget` raises a diagnostic, because a `target` that quietly
 * becomes `cloudflare` ships the app to the wrong provider.
 *
 * BOTH readers resolve the DEFAULT export and nothing else. That is not a
 * limitation to be relaxed: `@lunora/vite` emits `import lunoraConfig from
 * "…/lunora.config"` into the composed worker entry, so a hook reached any other
 * way would fail the bundle with "does not provide an export named default" —
 * the least debuggable error that plugin can produce.
 *
 * This lives in `@lunora/codegen` rather than `@lunora/config` for the reason
 * `readProjectTarget` always did: `@lunora/config` depends on `@lunora/codegen`,
 * not the reverse, so putting the loader there and importing it here would invert
 * the edge. There is still exactly one loader for the file.
 *
 * The `app` hook is ALSO bundled into the worker by `@lunora/vite`, which is why
 * the documented shape uses a type-only `satisfies` rather than a runtime
 * `defineConfig` import: a runtime import in this file is evaluated HERE, on the
 * host, and must resolve from the host — a `cloudflare:*` module or a tsconfig
 * path alias (which `jiti` does not read) throws, and {@link loadProjectConfig}
 * reports that rather than swallowing it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import { createJiti } from "jiti";
import type { ObjectLiteralElementLike, ObjectLiteralExpression, PropertyAssignment, ShorthandPropertyAssignment, SourceFile } from "ts-morph";
import { Node as TsNode, Project } from "ts-morph";

/**
 * The config filenames probed at the project root, in order. TypeScript first
 * because that is what the templates ship and what the type-only `satisfies`
 * needs; the JS forms are accepted so a JS-authored project is not forced into
 * TypeScript for one file.
 *
 * The one exported truth: the dev server watches exactly these, and
 * {@link findProjectConfigFile} probes exactly these.
 *
 * `.cts` / `.cjs` are absent deliberately. Vite's default `resolve.extensions`
 * does not include them, so the specifier `@lunora/vite` emits for the `app`
 * hook would not resolve — and a config half of whose keys work is worse than
 * one the probe never finds.
 */
const PROJECT_CONFIG_FILENAMES: ReadonlyArray<string> = ["lunora.config.ts", "lunora.config.mts", "lunora.config.js", "lunora.config.mjs"];

/**
 * The literals {@link readProjectConfigLiterals} proves by parsing — narrowed,
 * unlike the evaluated shape below, because the parser has just established that
 * each one IS a string or a boolean. Callers that re-checked `typeof` were
 * re-validating a fact this file already knew.
 */
interface ProjectConfigLiterals {
    remote?: boolean;
    target?: string;

    /**
     * A config file exists, but its default export could not be read as an
     * object literal — a computed value, a getter, a spread, `module.exports`.
     * The caller must not treat this as "no keys declared": that is how a
     * declared `target` becomes the default in silence.
     */
    unreadable?: boolean;
}

/** The structural slice of `lunora.config.*` Lunora reads. Unvalidated on purpose — see {@link loadProjectConfig}. */
interface LunoraProjectConfig {
    /** The `app` hook: receives the generated `defineApp()` builder and returns it. Read by `@lunora/vite`, not by the CLI. */
    app?: unknown;
    /** Remote-binding dev preference. */
    remote?: unknown;
    /** Deploy target id. */
    target?: unknown;
}

/** What {@link loadProjectConfig} found: the config, or why it could not be evaluated. */
interface LoadedProjectConfig {
    config?: LunoraProjectConfig;

    /**
     * Set when the file exists but evaluating it threw. Surfaced by the caller —
     * a config whose imports do not resolve on the host used to read as "no
     * config", which silently dropped the user's whole `app` hook.
     */
    error?: string;
}

/** The resolved config file, or `undefined` when the project ships none. */
const findProjectConfigFile = (projectRoot: string): string | undefined =>
    // `resolve`, not `join`: `jiti` cannot load a relative specifier, while the
    // parser reads one fine — so a relative `projectRoot` made the two readers
    // disagree about a config that was right there.
    PROJECT_CONFIG_FILENAMES.map((name) => resolve(projectRoot, name)).find((candidate) => existsSync(candidate));

/**
 * Memoized per path, keyed on mtime + size so an edit is picked up and a
 * short-lived process transpiles once. One entry per path, replaced rather than
 * accumulated: a long dev session edits the file many times.
 */
const cache = new Map<string, { key: string; value: Promise<LoadedProjectConfig> }>();

/**
 * Load `lunora.config.*`, or `{}` when the project ships none.
 *
 * `moduleCache: false` is load-bearing, not a tuning knob: `jiti`'s module cache
 * lives on `globalThis`, so a NEW instance still hands back the module it
 * compiled the first time. Without it a config edit was never picked up in a
 * long-lived dev server — the watcher fired, the server restarted, and the hook
 * stayed as it was when the process started.
 *
 * `interopDefault` is off so the namespace is not collapsed onto its default
 * export: the hook has to come from `default` specifically, because that is what
 * the emitted worker entry imports (see the module header).
 */
const loadProjectConfig = async (projectRoot: string): Promise<LoadedProjectConfig> => {
    const configPath = findProjectConfigFile(projectRoot);

    if (configPath === undefined) {
        return {};
    }

    let key: string;

    try {
        const stats = statSync(configPath);

        key = `${String(stats.mtimeMs)}:${String(stats.size)}`;
    } catch {
        return {};
    }

    const cached = cache.get(configPath);

    if (cached?.key === key) {
        return cached.value;
    }

    const pending = (async (): Promise<LoadedProjectConfig> => {
        try {
            const namespace: unknown = await createJiti(configPath, { interopDefault: false, moduleCache: false }).import(configPath);
            const value = (namespace as { default?: unknown } | undefined)?.default;

            return { config: value !== null && typeof value === "object" ? value : undefined };
        } catch (error: unknown) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    })();

    cache.set(configPath, { key, value: pending });

    return pending;
};

/**
 * The object literal the default export resolves to, or `undefined` when it does
 * not resolve to one.
 *
 * A `satisfies` / `as` / parenthesised wrapper is unwrapped, because that is the
 * documented shape. An identifier is followed to a `const` in the same file,
 * because `const config = { … }; export default config;` is the commonest config
 * idiom there is and reading it as "no keys" was indistinguishable from an empty
 * config.
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

    if (expression !== undefined && TsNode.isIdentifier(expression)) {
        const declaration = sourceFile.getVariableDeclaration(expression.getText());

        expression = declaration?.getInitializer();

        while (expression !== undefined && (TsNode.isSatisfiesExpression(expression) || TsNode.isAsExpression(expression))) {
            expression = expression.getExpression();
        }
    }

    return expression !== undefined && TsNode.isObjectLiteralExpression(expression) ? expression : undefined;
};

/**
 * One property's key, with a string-literal key's quotes removed.
 *
 * `getName()` keeps them, so `{ "target": … }` — perfectly valid TypeScript —
 * read as the name `"target"` and was silently ignored.
 */
const propertyKey = (property: PropertyAssignment | ShorthandPropertyAssignment): string => {
    const nameNode = property.getNameNode();

    return TsNode.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText();
};

/** The literal a property is assigned, following a shorthand to its `const` in the same file. */
const propertyLiteral = (property: PropertyAssignment | ShorthandPropertyAssignment, sourceFile: SourceFile) => {
    if (TsNode.isPropertyAssignment(property)) {
        return property.getInitializer();
    }

    return sourceFile.getVariableDeclaration(property.getName())?.getInitializer();
};

/**
 * What one property of the config object contributes.
 *
 * A key this reader cares about but cannot resolve to a literal contributes
 * `unreadable`, never absence: "no `target` declared" and "a `target` I could not
 * read" must not be the same answer, because the second silently ships the app to
 * the default provider.
 */
const readProperty = (property: ObjectLiteralElementLike, sourceFile: SourceFile): ProjectConfigLiterals => {
    // A getter or method declares a value this reader cannot see.
    if (TsNode.isGetAccessorDeclaration(property) || TsNode.isMethodDeclaration(property)) {
        const name = property.getName();

        return name === "target" || name === "remote" ? { unreadable: true } : {};
    }

    if (!TsNode.isPropertyAssignment(property) && !TsNode.isShorthandPropertyAssignment(property)) {
        return {};
    }

    const key = propertyKey(property);

    if (key !== "target" && key !== "remote") {
        return {};
    }

    const value = propertyLiteral(property, sourceFile);

    if (value === undefined) {
        return { unreadable: true };
    }

    if (key === "target") {
        return TsNode.isStringLiteral(value) ? { target: value.getLiteralValue() } : { unreadable: true };
    }

    if (TsNode.isTrueLiteral(value) || TsNode.isFalseLiteral(value)) {
        return { remote: value.getLiteralValue() };
    }

    // The object form (`{ kinds: [...] }`) is a reserved opt-in meaning "on", so
    // it has to be visible here too — reading only the booleans turned a
    // documented config into "no preference" without a word.
    return TsNode.isObjectLiteralExpression(value) ? { remote: true } : { unreadable: true };
};

/**
 * The `target` and `remote` LITERALS declared in the config, without evaluating
 * it — see the module header for what this can and cannot see, and why.
 */
const readProjectConfigLiterals = (projectRoot: string): ProjectConfigLiterals => {
    const configPath = findProjectConfigFile(projectRoot);

    if (configPath === undefined) {
        return {};
    }

    let source: string;

    try {
        source = readFileSync(configPath, "utf8");
    } catch {
        return { unreadable: true };
    }

    const project = new Project({
        compilerOptions: { allowJs: true },
        skipFileDependencyResolution: true,
        skipLoadingLibFiles: true,
        useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile(basename(configPath), source, { overwrite: true });
    const object = defaultExportObject(sourceFile);

    if (object === undefined) {
        return { unreadable: true };
    }

    // A spread can SHADOW a literal later in the object, so the literal this
    // reader sees is not necessarily the value that wins. Reporting it anyway is
    // the one case where this reader would be actively wrong rather than merely
    // blind, so the whole read gives up instead.
    if (object.getProperties().some((property) => TsNode.isSpreadAssignment(property))) {
        return { unreadable: true };
    }

    let literals: ProjectConfigLiterals = {};

    for (const property of object.getProperties()) {
        literals = { ...literals, ...readProperty(property, sourceFile) };
    }

    return literals;
};

export type { LoadedProjectConfig, LunoraProjectConfig, ProjectConfigLiterals };
export { findProjectConfigFile, loadProjectConfig, PROJECT_CONFIG_FILENAMES, readProjectConfigLiterals };
