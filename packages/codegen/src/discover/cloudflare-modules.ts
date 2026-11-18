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
 * Whether an import declaration loads its module at runtime. Only a whole
 * `import type { … } from …` is erased. Under `verbatimModuleSyntax`, which the
 * repo base and several templates set, `import { type Env } from "m"` is kept as
 * `import {} from "m"` and still loads `m`, so inline `type` specifiers count.
 * The rule does not read the app's tsconfig: a false refusal costs one keyword
 * (`import type`) to fix, and a missed one fails at boot.
 */
const loadsAtRuntime = (declaration: ImportDeclaration): boolean => !declaration.isTypeOnly();

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
