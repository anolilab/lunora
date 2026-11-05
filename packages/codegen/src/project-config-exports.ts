/**
 * The one detector for a `lunora.config.*` that exports only named bindings.
 * Lunora reads only the default export (see `project-config-file.ts`), so such
 * a file configures nothing; both the parse and the evaluating loader report it
 * through here, so they name the same exports and give the same fix.
 */
import type { SourceFile } from "ts-morph";
import { Node as TsNode } from "ts-morph";

import { unchangedInitializer, unwrapLiteral } from "./project-config-shape";

/** Whether `declaration` declares only a type: an interface, a type alias, or an `export type { … }` specifier. */
const isTypeOnly = (declaration: TsNode): boolean =>
    TsNode.isInterfaceDeclaration(declaration) ||
    TsNode.isTypeAliasDeclaration(declaration) ||
    (TsNode.isExportSpecifier(declaration) && (declaration.isTypeOnly() || declaration.getExportDeclaration().isTypeOnly()));

/** The names a file exports as values; a type-only export configures nothing. */
const namedValueExports = (sourceFile: SourceFile): string[] =>
    sourceFile
        .getExportSymbols()
        .filter((symbol) => {
            const declarations = symbol.getDeclarations();

            return declarations.length === 0 || !declarations.every((declaration) => isTypeOnly(declaration));
        })
        .map((symbol) => symbol.getName());

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
    if (sourceFile.getExportSymbols().some((symbol) => symbol.getName() === "default")) {
        return undefined;
    }

    const named = namedValueExports(sourceFile);
    // `export * from "./settings"` forwards names this parse cannot see (it resolves no imports), and never a default.
    const forwarded = sourceFile
        .getExportDeclarations()
        .filter((declaration) => declaration.isNamespaceExport() && declaration.getNamespaceExport() === undefined && !declaration.isTypeOnly())
        .map((declaration) => declaration.getModuleSpecifierValue())
        .filter((module): module is string => module !== undefined);

    if (named.length === 0 && forwarded.length === 0) {
        return undefined;
    }

    if (named.length === 0) {
        return `${fileName} has no default export, so none of its settings are read (it only re-exports ${forwarded.map((module) => `\`${module}\``).join(", ")} with \`export *\`, which never forwards a default). Lunora reads only the default export: \`export { default } from "${String(forwarded[0])}"\`, or \`export default { … } satisfies LunoraConfig\`.`;
    }

    const keys = named.filter((name) => configKeys.has(name));
    const objects = named.filter((name) => {
        const initializer = unwrapLiteral(unchangedInitializer(sourceFile, name));

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
