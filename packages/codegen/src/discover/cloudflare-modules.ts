import { basename, dirname, relative } from "node:path";

import type { ImportDeclaration, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { descendantsOfKind, listLunoraSourceFiles } from "./ast";

/** The scheme of the Workers runtime's built-in modules: `cloudflare:workers`, `cloudflare:email`, `cloudflare:sockets`, … */
const CLOUDFLARE_SCHEME = "cloudflare:";

/** One app module that loads `cloudflare:*` built-ins, and which. */
interface CloudflareModuleImport {
    /** The importing file, relative to the project root (`lunora/mail/index.ts`). */
    module: string;
    /** The `cloudflare:*` specifiers it loads, in source order, each once. */
    specifiers: ReadonlyArray<string>;
}

/**
 * Whether an import declaration survives compilation. A type-only one erases,
 * and so does a named import whose every binding is `type`, which is how
 * `import type { Env } from "cloudflare:workers"` stays loadable anywhere. A
 * bare `import "cloudflare:…"` keeps its side effect, so it counts.
 */
const loadsAtRuntime = (declaration: ImportDeclaration): boolean => {
    if (declaration.isTypeOnly()) {
        return false;
    }

    const clause = declaration.getImportClause();

    if (clause === undefined || clause.getDefaultImport() !== undefined || clause.getNamespaceImport() !== undefined) {
        return true;
    }

    return clause.getNamedImports().some((named) => !named.isTypeOnly());
};

/** The `cloudflare:*` specifiers a file loads: static imports, re-exports and `import("cloudflare:…")` calls. */
const cloudflareSpecifiersOf = (sourceFile: SourceFile): string[] => {
    const found = new Set<string>();
    const note = (specifier: string | undefined): void => {
        if (specifier?.startsWith(CLOUDFLARE_SCHEME) === true) {
            found.add(specifier);
        }
    };

    for (const declaration of sourceFile.getImportDeclarations()) {
        if (loadsAtRuntime(declaration)) {
            note(declaration.getModuleSpecifierValue());
        }
    }

    for (const declaration of sourceFile.getExportDeclarations()) {
        if (!declaration.isTypeOnly()) {
            note(declaration.getModuleSpecifierValue());
        }
    }

    // A dynamic import fails only when it runs (the mail starter's `cloudflare:email` send), but
    // it still names a module the target does not have, so it is refused with the rest.
    for (const call of descendantsOfKind(sourceFile, SyntaxKind.CallExpression)) {
        const [argument] = call.getArguments();

        if (call.getExpression().getKind() === SyntaxKind.ImportKeyword && argument !== undefined && Node.isStringLiteral(argument)) {
            note(argument.getLiteralValue());
        }
    }

    return [...found];
};

/**
 * Every app module under `lunora/` that loads a `cloudflare:*` built-in, for the
 * platform gate to refuse on a target that has none. `_generated/` is skipped by
 * the shared lister, so only modules the app owns are judged, never codegen's
 * own output. Every file is walked: the diagnostic names each module, so there
 * is no early exit once one is found.
 */
const discoverCloudflareModuleImports = (project: Project, lunoraDirectory: string): CloudflareModuleImport[] => {
    // Paths are shown from the project root, so the `lunora/` prefix tells the reader where to look.
    const root = dirname(lunoraDirectory);

    return listLunoraSourceFiles(lunoraDirectory).flatMap((filePath) => {
        const specifiers = cloudflareSpecifiersOf(project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath));

        return specifiers.length === 0 ? [] : [{ module: relative(root, filePath) || basename(filePath), specifiers }];
    });
};

export type { CloudflareModuleImport };
export { discoverCloudflareModuleImports };
