import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { ts } from "ts-morph";

/** Extensions a source file of the Worker can have, in the order a bare relative import is tried. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

/** A `node:`, `cloudflare:` or other scheme-prefixed runtime module. */
const RUNTIME_SCHEME = /^[a-z]+:/u;

/** A `.js` / `.mjs` / `.cjs` suffix, written in TypeScript source for the `.ts` file it compiles from. */
const JS_SUFFIX = /\.[cm]?js$/u;

/** A specifier that names a package, as opposed to a file, a subpath import or a runtime module. */
const isPackageSpecifier = (specifier: string): boolean =>
    !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("#") && !RUNTIME_SCHEME.test(specifier);

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
const packageName = (specifier: string): string =>
    specifier
        .split("/")
        .slice(0, specifier.startsWith("@") ? 2 : 1)
        .join("/");

/** Generated output and installed packages: never the app's own loaders. */
const isOutsideApp = (path: string): boolean => path.split(sep).some((part) => part === "_generated" || part === "node_modules");

/** Installed packages, which a relative import from the app never reaches into. */
const isInstalled = (path: string): boolean => path.split(sep).includes("node_modules");

/** The file a relative import names, the way the bundler finds it: as written, `.js` written for `.ts`, an added extension, or an index. */
const resolveRelative = (from: string, specifier: string): string | undefined => {
    const base = resolve(dirname(from), specifier);
    const stem = JS_SUFFIX.test(base) ? base.replace(JS_SUFFIX, "") : undefined;
    const candidates = [
        base,
        ...(stem === undefined ? [] : SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`)),
        ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
        ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
    ];

    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
};

/** `lunora.config.ts` and its `.mts` / `.js` / `.mjs` siblings. */
const PROJECT_CONFIG_FILE = /^lunora\.config\.[cm]?[jt]s$/u;

/** The first string a `package.json` `imports` target resolves to, through its condition objects; `types` names a declaration file, never the module the Worker loads. */
const importTarget = (target: unknown): string | undefined => {
    if (typeof target === "string") {
        return target;
    }

    if (typeof target === "object" && target !== null) {
        for (const [condition, value] of Object.entries(target)) {
            const found = condition === "types" ? undefined : importTarget(value);

            if (found !== undefined) {
                return found;
            }
        }
    }

    return undefined;
};

/** `#lunora/payment` → `./lunora/payment` through the project's `package.json` `imports`, exact keys and one-`*` patterns. */
const mapSubpathImport = (cwd: string, specifier: string): string | undefined => {
    let imports: Record<string, unknown> | undefined;

    try {
        imports = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { imports?: Record<string, unknown> }).imports;
    } catch {
        return undefined;
    }

    // Node takes an exact key before any pattern, wherever either is declared.
    const exact = importTarget(imports?.[specifier]);

    if (exact !== undefined) {
        return exact;
    }

    for (const [key, target] of Object.entries(imports ?? {})) {
        const [prefix = "", suffix = ""] = key.split("*");
        const mapped = importTarget(target);

        if (mapped !== undefined && key.includes("*") && specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= key.length - 1) {
            // A replacer function, so a `$&` or `$$` in the subpath is inserted as written; Node substitutes every `*`, not only the first.
            const captured = specifier.slice(prefix.length, specifier.length - suffix.length);

            return mapped.replaceAll("*", () => captured);
        }
    }

    return undefined;
};

/** The `.ts` files the composed (virtual) entry reaches: the generated modules, and the project config whose `app` hook it imports. */
const virtualEntryRoots = (cwd: string, schemaDirectory: string): string[] => {
    const generated = join(cwd, schemaDirectory, "_generated");
    // The same file the composed entry imports for the app's `app` hook.
    const config = readdirSync(cwd).find((name) => PROJECT_CONFIG_FILE.test(name));

    return [
        ...(existsSync(generated)
            ? readdirSync(generated)
                  .filter((name) => name.endsWith(".ts"))
                  .map((name) => join(generated, name))
            : []),
        ...(config === undefined ? [] : [join(cwd, config)]),
    ];
};

/** Whether the project keeps imports as written (`verbatimModuleSyntax`), so `import { type X } from "m"` still loads `m`. */
const keepsTypeOnlyImports = (cwd: string): boolean => {
    const configFile = ts.findConfigFile(cwd, (path) => ts.sys.fileExists(path));

    if (configFile === undefined) {
        return false;
    }

    const read: { config?: object } = ts.readConfigFile(configFile, (path) => ts.sys.readFile(path));

    return ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(configFile)).options.verbatimModuleSyntax === true;
};

/** `{ type A, type B }`: named bindings that are all types. Erased with the rest of the import unless the project keeps imports as written. */
const allNamesTypeOnly = (bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined): boolean =>
    bindings !== undefined &&
    (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly);

/** An `import … from` / `export … from` that puts code in the bundle: a type-only one is erased. */
const valueModuleSpecifier = (node: ts.Node, keepsTypeOnly: boolean): string | undefined => {
    if (ts.isImportDeclaration(node)) {
        const { importClause } = node;
        const typeOnly =
            importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
            (!keepsTypeOnly && importClause?.name === undefined && allNamesTypeOnly(importClause?.namedBindings));

        return !typeOnly && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
    }

    if (ts.isExportDeclaration(node)) {
        const typeOnly = node.isTypeOnly || (!keepsTypeOnly && allNamesTypeOnly(node.exportClause));

        return !typeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
    }

    return undefined;
};

/** The literal specifier of an `import("…")` call. */
const dynamicImportSpecifier = (node: ts.Node): string | undefined => {
    if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
        return undefined;
    }

    const [argument] = node.arguments;

    return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
};

/** Relative and `#` subpath imports to follow, and the package specifiers of the file's `import()` calls. */
const scanFile = (file: string, keepsTypeOnly: boolean): { dynamicPackages: string[]; relative: string[] } => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
    const dynamicPackages: string[] = [];
    const relativeImports: string[] = [];

    const visit = (node: ts.Node): void => {
        const dynamic = dynamicImportSpecifier(node);
        const specifier = dynamic ?? valueModuleSpecifier(node, keepsTypeOnly);

        if (specifier?.startsWith(".") || specifier?.startsWith("#")) {
            relativeImports.push(specifier);
        } else if (dynamic !== undefined && isPackageSpecifier(dynamic)) {
            dynamicPackages.push(dynamic);
        }

        ts.forEachChild(node, visit);
    };

    visit(source);

    return { dynamicPackages, relative: relativeImports };
};

/** Whether `name` is installed where a module in `directory` would find it. */
const isInstalledFrom = (directory: string, name: string): boolean => {
    for (let current = directory; ; current = dirname(current)) {
        if (existsSync(join(current, "node_modules", name, "package.json"))) {
            return true;
        }

        if (dirname(current) === current) {
            return false;
        }
    }
};

/**
 * The package specifiers the Worker loads with a literal `import()`, sorted: integration SDKs handed
 * over as loaders (`playwright: () => import("@cloudflare/playwright")`, a payment `client` or a
 * Hyperdrive driver that imports `stripe`, `postgres`, `mysql2/promise` inside it). Their module
 * evaluation runs on first use, so an SDK that throws while evaluating in workerd would surface in
 * front of a user; the smoke check evaluates each one before the Worker ships.
 *
 * Walks only the files the Worker loads: from the entry along relative and `#` subpath imports, static and dynamic,
 * through `_generated` (which is how the entry reaches the function modules) without collecting from
 * it, since codegen's own `import()`s are not integration loaders. A file the Worker never loads
 * (a colocated test, a seed script) is never read, so a Node-only `import()` in it cannot block a
 * deploy. Only specifiers that resolve from `cwd` are returned: the smoke entry imports them from
 * under it, and one that does not resolve there would fail the bundle rather than the module.
 *
 * Not covered: an SDK a framework route module loads when the entry is virtual (the framework, not this
 * walk, decides which route modules exist), and an SDK a package loads for itself (`@lunora/mcp` and `@modelcontextprotocol/sdk`),
 * since the app never names it.
 */
const collectIntegrationModules = (cwd: string, entry: string | undefined, schemaDirectory: string): string[] => {
    const keepsTypeOnly = keepsTypeOnlyImports(cwd);
    const seen = new Set<string>();
    const packages = new Set<string>();
    // A Vite-composed Worker's entry is `virtual:lunora/worker`, which has no file to read; the files it imports are the roots then.
    const queue = entry !== undefined && existsSync(resolve(cwd, entry)) ? [resolve(cwd, entry)] : virtualEntryRoots(cwd, schemaDirectory);

    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        if (!seen.has(file) && !isInstalled(relative(cwd, file))) {
            seen.add(file);

            const { dynamicPackages, relative: imports } = scanFile(file, keepsTypeOnly);

            if (!isOutsideApp(relative(cwd, file))) {
                for (const specifier of dynamicPackages) {
                    packages.add(specifier);
                }
            }

            queue.push(
                ...imports.flatMap((specifier) => {
                    if (!specifier.startsWith("#")) {
                        return resolveRelative(file, specifier) ?? [];
                    }

                    const mapped = mapSubpathImport(cwd, specifier);

                    return mapped === undefined ? [] : (resolveRelative(join(cwd, "package.json"), mapped) ?? []);
                }),
            );
        }
    }

    return [...packages].filter((specifier) => isInstalledFrom(cwd, packageName(specifier))).toSorted((a, b) => a.localeCompare(b));
};

export default collectIntegrationModules;
