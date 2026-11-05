/**
 * The one detector for a `lunora.config.*` that exports only named bindings.
 * Lunora reads only the default export (see `project-config-file.ts`), so such
 * a file configures nothing; both the parse and the evaluating loader report it
 * through here, so they name the same exports and give the same fix.
 */
import type { SourceFile } from "ts-morph";
import { Node as TsNode } from "ts-morph";

import { unwrapLiteral } from "./project-config-shape";

/** Whether `declaration` declares only a type: an interface, a type alias, or an `export type { … }` specifier. */
const isTypeOnly = (declaration: TsNode): boolean =>
    TsNode.isInterfaceDeclaration(declaration) ||
    TsNode.isTypeAliasDeclaration(declaration) ||
    (TsNode.isExportSpecifier(declaration) && (declaration.isTypeOnly() || declaration.getExportDeclaration().isTypeOnly()));

/** The names a file exports as values (a type-only export configures nothing); empty when it has a default export. */
const namedValueExports = (sourceFile: SourceFile): string[] => {
    const symbols = sourceFile.getExportSymbols();

    if (symbols.some((symbol) => symbol.getName() === "default")) {
        return [];
    }

    return symbols
        .filter((symbol) => {
            const declarations = symbol.getDeclarations();

            return declarations.length === 0 || !declarations.every((declaration) => isTypeOnly(declaration));
        })
        .map((symbol) => symbol.getName());
};

/**
 * Why a config that exports only named bindings is not read, or `undefined` when
 * it has a default export or exports no value. The fix is the one its exports
 * point to: exports named like config keys are gathered into one object, and a
 * lone exported settings object becomes the default as it is.
 */
const namedOnlyExportsProblem = (
    fileName: string,
    sourceFile: SourceFile,
    configKeys: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): string | undefined => {
    const named = namedValueExports(sourceFile);

    if (named.length === 0) {
        return undefined;
    }

    const keys = named.filter((name) => configKeys.has(name));
    const objects = named.filter((name) => {
        const initializer = unwrapLiteral(sourceFile.getVariableDeclaration(name)?.getInitializer());

        return !configKeys.has(name) && initializer !== undefined && TsNode.isObjectLiteralExpression(initializer);
    });

    let fix = "`export default { … } satisfies LunoraConfig`";

    if (keys.length > 0) {
        fix = `\`export default { ${keys.join(", ")} } satisfies LunoraConfig\``;
    } else if (objects.length === 1) {
        fix = `\`export default ${String(objects[0])};\` in place of the named export`;
    }

    return `${fileName} has no default export, so none of its settings are read (it exports ${named.map((name) => `\`${name}\``).join(", ")}). Lunora reads only the default export: ${fix}.`;
};

export default namedOnlyExportsProblem;
