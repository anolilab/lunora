/**
 * What a call's callee is called. Three questions, kept together because they
 * were three helpers in three files with no cross references, and the discovery
 * feeders picked between them by accident:
 *
 * - {@link calleeName} — how is it spelled? Makes no claim about origin.
 * - {@link resolvesToImportedName} — does it name X, allowing an import alias?
 * - {@link resolveCalleeKind} — which surface export is it, by import?
 * - {@link isServerImport} — is it that export, by import, with no fallback?
 *
 * They are not interchangeable (the signatures differ), so the question picks
 * the function. The asymmetry worth knowing: `resolvesToImportedName` and
 * `resolveCalleeKind` accept a plain matching name, or the raw text, when there
 * is no type information. `isServerImport` never does. It is the only one that
 * proves origin, and the security markers (`platformAdmin`, `defineIdentityGuard`)
 * use it for that reason.
 */
import type { Identifier, Node, SourceFile } from "ts-morph";
import { Node as TsNode } from "ts-morph";

import { isServerSurfaceModule } from "../module-specifiers";

/**
 * The simple name of a callee — a bare identifier's text, or a property
 * access's member name (`guards.rls` → `"rls"`). `undefined` for anything else
 * (a call returning a function, an element access, a `new`).
 *
 * Makes no claim about where the name came from. Callers that need one should
 * use {@link resolvesToImportedName} or {@link resolveCalleeKind} instead of
 * comparing this against a known name.
 */
const calleeName = (callee: Node): string | undefined => {
    if (TsNode.isIdentifier(callee)) {
        return callee.getText();
    }

    return TsNode.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
};

/**
 * Local names an import binds for `exportedName` in a source file.
 *
 * Purely syntactic — no `getSymbol()`, no type checker. Deliberate on two
 * counts: the detectors built on this have to keep working under degraded type
 * info (their whole reason for matching by name), and they run on every
 * `.use(...)` argument of every chain, where resolving a symbol per callee is
 * real type-checker work on a hot path. Scanning a file's import declarations
 * is a handful of syntactic children by comparison.
 *
 * Not cached: ts-morph reuses the `SourceFile` object when a file is
 * overwritten, so a cache keyed on it serves the previous content's aliases.
 */
const importAliases = (sourceFile: SourceFile, exportedName: string): Set<string> => {
    const aliases = new Set<string>();

    for (const declaration of sourceFile.getImportDeclarations()) {
        if (!isServerSurfaceModule(declaration.getModuleSpecifierValue())) {
            continue;
        }

        for (const specifier of declaration.getNamedImports()) {
            if (specifier.getNameNode().getText() === exportedName) {
                aliases.add(specifier.getAliasNode()?.getText() ?? specifier.getName());
            }
        }
    }

    return aliases;
};

/**
 * True when a callee names `expectedName` — literally, or through an import
 * alias. The middleware detectors (`isRlsCall`, `isMaskCall`) match with this.
 *
 * A deliberate RELAXATION of {@link resolveCalleeKind}: it matches by name
 * rather than by import origin so it keeps working when ts-morph has degraded
 * type info, where an origin check resolves to nothing and would drop every
 * policy. The cost is that `rls(...)` from anywhere counts — a pre-existing
 * trade, left alone.
 *
 * The plain text comparison alone missed `import { rls as rowLevel }`, so an
 * aliased import read as unrelated middleware: `usesRls: false`, no policies in
 * the inspector, and the dispatch lint suppressed for that target. The
 * asymmetry made it worse — `resolveCalleeKind` DOES resolve aliases, so the
 * same file's procedure classified correctly while its policy evidence
 * vanished.
 *
 * Only the ALIAS branch is gated on the module specifier; a plainly-imported
 * `rls` from any module still matches on text, as it always did. The gate is
 * there because these signals suppress lints as well as enable them (`usesRls`
 * short-circuits `rls-uncovered-table` and `normalize-id-used-as-authorization`),
 * so the new hop should not widen what silences a finding — it is not a claim
 * that this predicate proves origin.
 */
const resolvesToImportedName = (callee: Node, expectedName: string): boolean => {
    if (TsNode.isPropertyAccessExpression(callee)) {
        return callee.getName() === expectedName;
    }

    if (!TsNode.isIdentifier(callee)) {
        return false;
    }

    const text = callee.getText();

    return text === expectedName || importAliases(callee.getSourceFile(), expectedName).has(text);
};

/**
 * The exported name a Lunora-surface import binds `identifier` to, read off its
 * symbol: `query` for `import { query as q }`. `undefined` when no declaration is
 * such an import — a local binding, or an import from somewhere else. Trusts only
 * the public package and the generated `_generated/server` re-export.
 */
const surfaceImportNameOf = (identifier: Identifier): string | undefined => {
    for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
        // The NAME node, not the alias: the kind we care about is the exported name.
        if (TsNode.isImportSpecifier(declaration) && isServerSurfaceModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return declaration.getNameNode().getText();
        }
    }

    return undefined;
};

/**
 * Resolve a callee identifier through its import declaration, returning the
 * name as EXPORTED from the Lunora surface — so `import { query as q }` used as
 * `q(...)` answers `"query"`.
 *
 * `undefined` when the identifier resolves to something that is not a surface
 * import, so a local `const query = …` is not mistaken for a registration —
 * affordable here because a misidentified registration invents a route no
 * handler backs, and not affordable for the middleware detectors, which is why
 * {@link resolvesToImportedName} exists.
 *
 * That only holds WHEN THERE IS A SYMBOL. With no type-checker info at all (no
 * tsconfig wired up) there is nothing to resolve and this falls back to the raw
 * text — accepting the same local `const query = …` it otherwise refuses —
 * because the alternative is dropping every function in the project.
 */
const resolveCalleeKind = (identifier: Identifier): string | undefined => {
    // No symbol: nothing to resolve, so fall back to the text (see above).
    if (!identifier.getSymbol()) {
        return identifier.getText();
    }

    return surfaceImportNameOf(identifier);
};

/**
 * Whether `callee` is the surface export `exportName`, by import, with no
 * fallback to the text: an identifier whose symbol is a named import of that
 * export (an alias of it counts). A local function with the same name is not
 * one, so it cannot downgrade a finding.
 *
 * Deliberately narrow. A namespace call (`server.platformAdmin(...)`) or a
 * re-export through the project's own barrel does not match, so the procedure
 * is reported rather than trusted. That is the safe direction.
 */
const isServerImport = (callee: Node, exportName: string): boolean => TsNode.isIdentifier(callee) && surfaceImportNameOf(callee) === exportName;

export { calleeName, isServerImport, resolveCalleeKind, resolvesToImportedName };
