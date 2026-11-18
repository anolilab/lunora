import { statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { ImportDeclaration, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

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

    // A dynamic import fails only when it runs (the mail starter's `cloudflare:email` send), but
    // it still names a module the target does not have, so it is refused with the rest.
    for (const call of descendantsOfKind(sourceFile, SyntaxKind.CallExpression)) {
        const [argument] = call.getArguments();

        // A backtick literal with no substitutions is as static as a quoted one: import(`cloudflare:email`).
        if (
            call.getExpression().getKind() === SyntaxKind.ImportKeyword &&
            argument !== undefined &&
            (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))
        ) {
            note(argument.getLiteralValue());
        }
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
 * The file a relative specifier names, as the bundler resolves it: the exact
 * path, a TypeScript source written as its emitted extension, the path with each
 * bundled extension, or a directory's `index`. `undefined` when nothing matches,
 * which the build itself reports.
 */
const resolveRelative = (fromFile: string, specifier: string): string | undefined => {
    const base = resolve(dirname(fromFile), specifier);
    const written = BUNDLED_EXTENSIONS.find((extension) => base.endsWith(extension));
    const candidates = [
        ...(written === undefined ? [] : [base, ...(SOURCE_FOR_EMITTED[written] ?? []).map((source) => base.slice(0, -written.length) + source)]),
        ...BUNDLED_EXTENSIONS.map((extension) => base + extension),
        ...BUNDLED_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
    ];

    return candidates.find((candidate) => isFile(candidate));
};

/**
 * Codegen's own output and installed packages are never the app's to fix: a
 * relative import into `_generated/` (which loads `cloudflare:workers` itself for
 * a sharded schema) or `node_modules` is not followed.
 */
const isOutsideAppCode = (path: string): boolean => path.split(sep).some((segment) => segment === "_generated" || segment === "node_modules");

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
    const pending = [...listLunoraSourceFiles(lunoraDirectory)];
    const seen = new Set(pending);
    const found: CloudflareModuleImport[] = [];

    for (let filePath = pending.shift(); filePath !== undefined; filePath = pending.shift()) {
        const specifiers = runtimeSpecifiersOf(project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath));
        const cloudflare = specifiers.filter((specifier) => specifier.startsWith(CLOUDFLARE_SCHEME));

        if (cloudflare.length > 0) {
            found.push({ module: relative(root, filePath) || basename(filePath), specifiers: cloudflare });
        }

        for (const specifier of specifiers) {
            const reached = specifier.startsWith(".") ? resolveRelative(filePath, specifier) : undefined;

            if (reached !== undefined && !seen.has(reached) && !isOutsideAppCode(reached)) {
                seen.add(reached);
                pending.push(reached);
            }
        }
    }

    return found;
};

export type { CloudflareModuleImport };
export { discoverCloudflareModuleImports };
