import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { CallExpression, ImportDeclaration, ImportEqualsDeclaration, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind, ts } from "ts-morph";

import { descendantsOfKind, listLunoraSourceFiles } from "./ast";

/** The scheme of the Workers runtime's built-in modules: `cloudflare:workers`, `cloudflare:email`, `cloudflare:sockets`, … */
const CLOUDFLARE_SCHEME = "cloudflare:";

/** Every extension the worker bundle takes, tried in this order for an extensionless specifier. */
const BUNDLED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * The TypeScript files a JavaScript extension in a specifier may name: under
 * `moduleResolution: "bundler"` (and NodeNext) `./x.js` is written for `./x.ts`.
 */
const SOURCE_FOR_EMITTED: Readonly<Record<string, ReadonlyArray<string>>> = {
    ".cjs": [".cts"],
    ".js": [".ts", ".tsx"],
    ".jsx": [".tsx"],
    ".mjs": [".mts"],
};

/** One app module that loads `cloudflare:*` built-ins, and which. */
interface CloudflareModuleImport {
    /** The importing file, relative to the project root (`lunora/mail/index.ts`). */
    module: string;
    /** The `cloudflare:*` specifiers it loads, in source order, each once. */
    specifiers: ReadonlyArray<string>;
}

/**
 * Whether an import declaration loads its module at runtime. Only a whole
 * `import type { … } from …` is erased. Under `verbatimModuleSyntax`, which the
 * repo base and several templates set, `import { type Env } from "m"` is kept as
 * `import {} from "m"` and still loads `m`, so inline `type` specifiers count.
 * The rule does not read the app's tsconfig: a false refusal costs one keyword
 * (`import type`) to fix, and a missed one fails at boot.
 */
const loadsAtRuntime = (declaration: ImportDeclaration): boolean => !declaration.isTypeOnly();

/** `import env = require("m")`'s module, the TypeScript CommonJS form a `.cts` helper uses; none when type-only. */
const requireEqualsSpecifier = (declaration: ImportEqualsDeclaration): string | undefined => {
    const reference = declaration.getModuleReference();

    if (declaration.isTypeOnly() || !Node.isExternalModuleReference(reference)) {
        return undefined;
    }

    const expression = reference.getExpression();

    return expression !== undefined && Node.isStringLiteral(expression) ? expression.getLiteralValue() : undefined;
};

/**
 * The module an `import("…")` or `require("…")` call loads, when its argument is a
 * literal. A dynamic import fails only when it runs (the mail starter's
 * `cloudflare:email` send), but it still names a module the target does not have,
 * so it is refused with the rest; a `require` is what a `.cjs` or `.cts` helper the
 * walk reaches loads with. A backtick literal with no substitutions is as static
 * as a quoted one.
 */
const loadCallSpecifier = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();
    const [argument] = call.getArguments();
    const loads = callee.getKind() === SyntaxKind.ImportKeyword || (Node.isIdentifier(callee) && callee.getText() === "require");

    return loads && argument !== undefined && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))
        ? argument.getLiteralValue()
        : undefined;
};

/**
 * The module specifiers a file loads at runtime, in source order, each once:
 * static imports, re-exports and `import("…")` calls with a literal argument.
 * Type-only declarations erase, so neither their module nor anything it imports
 * is bundled.
 */
const runtimeSpecifiersOf = (sourceFile: SourceFile): string[] => {
    const found = new Set<string>();
    const note = (specifier: string | undefined): void => {
        if (specifier !== undefined) {
            found.add(specifier);
        }
    };

    for (const declaration of sourceFile.getImportDeclarations()) {
        if (loadsAtRuntime(declaration)) {
            note(declaration.getModuleSpecifierValue());
        }
    }

    // The same rule as imports: `export { type X } from "m"` keeps `export {} from "m"` under
    // `verbatimModuleSyntax`, so only a whole `export type { … } from …` is erased.
    for (const declaration of sourceFile.getExportDeclarations()) {
        if (!declaration.isTypeOnly()) {
            note(declaration.getModuleSpecifierValue());
        }
    }

    for (const declaration of descendantsOfKind(sourceFile, SyntaxKind.ImportEqualsDeclaration)) {
        note(requireEqualsSpecifier(declaration));
    }

    for (const call of descendantsOfKind(sourceFile, SyntaxKind.CallExpression)) {
        note(loadCallSpecifier(call));
    }

    return [...found];
};

/** Whether `path` is an existing file (not a directory). */
const isFile = (path: string): boolean => {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
};

/**
 * Every file a relative specifier may name: the exact path, a TypeScript source
 * written as its emitted extension, the path with each bundled extension, and a
 * directory's `index`. All of them, not the first that exists, so the answer does
 * not depend on matching the bundler's resolution order (esbuild tries `.tsx`
 * before `.ts`, for one). When two siblings share a base name, a `cloudflare:*`
 * import in either is reported: that fails closed, at the cost of a false refusal
 * when only the other one is bundled, which an explicit extension fixes. Empty
 * when nothing matches, which the build itself reports.
 */
const resolveRelative = (fromFile: string, specifier: string): string[] => {
    const base = resolve(dirname(fromFile), specifier);
    const written = BUNDLED_EXTENSIONS.find((extension) => base.endsWith(extension));
    const candidates = [
        ...(written === undefined ? [] : [base, ...(SOURCE_FOR_EMITTED[written] ?? []).map((source) => base.slice(0, -written.length) + source)]),
        ...BUNDLED_EXTENSIONS.map((extension) => base + extension),
        ...BUNDLED_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
    ];

    return candidates.filter((candidate) => isFile(candidate));
};

/**
 * Codegen's own output and installed packages are never the app's to fix: a
 * relative import into `_generated/` (which loads `cloudflare:workers` itself for
 * a sharded schema) or `node_modules` is not followed. Judged on the path from the
 * project root, never the absolute one, so a checkout that happens to live under
 * a directory with either name (`/tmp/_generated/app`) is still walked. A `..`
 * segment, for an import that leaves the root, is not a directory name.
 */
const isOutsideAppCode = (root: string, path: string): boolean =>
    relative(root, path)
        .split(sep)
        .some((segment) => segment === "_generated" || segment === "node_modules");

/**
 * The app file a non-relative specifier names through an alias the project
 * supports: `#lunora/*` from `package.json` `imports`, or a tsconfig `paths`
 * entry. Resolved exactly as the rest of discovery resolves an import (the
 * project's own compiler options and resolution host), and kept only when it
 * lands in app source under the project root: a package, or its `.d.ts`, is not
 * the app's to fix.
 */
const resolveAlias = (project: Project, root: string, filePath: string, specifier: string): string[] => {
    const resolved = ts.resolveModuleName(specifier, filePath, project.getCompilerOptions(), project.getModuleResolutionHost()).resolvedModule;
    const file = resolved?.resolvedFileName;

    if (file === undefined || resolved?.isExternalLibraryImport === true || file.endsWith(".d.ts") || relative(root, file).startsWith("..")) {
        return [];
    }

    return [file];
};

/** The app files a module's specifiers may reach, relative or through an alias, outside `_generated/` and `node_modules`. */
const appFilesReachedFrom = (project: Project, root: string, filePath: string, specifiers: ReadonlyArray<string>): string[] =>
    specifiers
        .filter((specifier) => !specifier.startsWith(CLOUDFLARE_SCHEME))
        .flatMap((specifier) => (specifier.startsWith(".") ? resolveRelative(filePath, specifier) : resolveAlias(project, root, filePath, specifier)))
        .filter((file) => !isOutsideAppCode(root, file));

/**
 * One key per file: its real path, so a file reached through a symlinked
 * directory and through its own path is walked once, and a link back into an
 * ancestor cannot make the walk go round forever.
 */
const fileKey = (path: string): string => {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
};

/**
 * Every app module the worker bundle would load from `lunora/` that loads a
 * `cloudflare:*` built-in, for the platform gate to refuse on a target that has
 * none.
 *
 * The walk starts from the modules codegen reads and follows their relative
 * imports, static and dynamic, into whatever file they reach, because that is
 * what the bundle contains. A file matched by `codegen.exclude` is followed into
 * (exclusion keeps it out of function discovery, not out of the bundle), and so
 * is a `.tsx`, `.mts`, `.cts` or JavaScript helper, which the lister never lists.
 * Every reached file is examined: the diagnostic names each module, so there is
 * no early exit once one is found.
 */
const discoverCloudflareModuleImports = (project: Project, lunoraDirectory: string): CloudflareModuleImport[] => {
    // Paths are shown from the project root, so the `lunora/` prefix tells the reader where to look.
    const root = dirname(lunoraDirectory);
    // The lister leaves out the root `schema.ts`, which `discoverSchema` reads on its own, but
    // the generated shard imports it, so it and whatever it imports are in the bundle too.
    const rootSchema = join(lunoraDirectory, "schema.ts");
    const pending = [...listLunoraSourceFiles(lunoraDirectory), ...(isFile(rootSchema) ? [rootSchema] : [])];
    const seen = new Set(pending.map((file) => fileKey(file)));
    const found: CloudflareModuleImport[] = [];

    for (let filePath = pending.shift(); filePath !== undefined; filePath = pending.shift()) {
        const specifiers = runtimeSpecifiersOf(project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath));
        const cloudflare = specifiers.filter((specifier) => specifier.startsWith(CLOUDFLARE_SCHEME));

        if (cloudflare.length > 0) {
            found.push({ module: relative(root, filePath) || basename(filePath), specifiers: cloudflare });
        }

        for (const file of appFilesReachedFrom(project, root, filePath, specifiers)) {
            const key = fileKey(file);

            if (!seen.has(key)) {
                seen.add(key);
                pending.push(file);
            }
        }
    }

    return found;
};

export type { CloudflareModuleImport };
export { discoverCloudflareModuleImports };
