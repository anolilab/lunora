/**
 * What a call's callee is called — and how much to trust the answer.
 *
 * Three questions live here, deliberately together, because they were three
 * helpers in three files with three different trust models and no cross
 * references, and the discovery feeders picked between them by accident:
 *
 * | helper                    | question                                          | trusts                          |
 * | ------------------------- | ------------------------------------------------- | ------------------------------- |
 * | {@link calleeName}        | what is this callee spelled?                      | the source text, nothing else   |
 * | {@link resolvesToImportedName} | does it name X, allowing an alias?           | text, plus a surface-gated import |
 * | {@link resolveCalleeKind} | which surface export is this, really?             | only a surface-gated import     |
 *
 * They are ordered by how much they will believe. Pick the strictest one that
 * answers the question: `resolveCalleeKind` refuses a local `const query = …`,
 * `resolvesToImportedName` accepts anything spelled right, and `calleeName`
 * makes no claim about origin at all.
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
 * Deliberately NOT cached per source file. ts-morph reuses the `SourceFile`
 * object when a file is overwritten or refreshed, so a cache keyed on it serves
 * the previous content's aliases — a wrong answer about whether a procedure
 * declares a policy, traded for a saving this scan does not need.
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
 * The alias hop is additive (the text match answers first, so degraded type info
 * behaves exactly as before) but it DOES gate on the module specifier, unlike
 * the text match. These signals suppress lints as well as enable them —
 * `usesRls` short-circuits `rls-uncovered-table` and
 * `normalize-id-used-as-authorization` — so trusting an unrelated library's
 * `rls` would silence a real finding.
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
 * Resolve a callee identifier through its import declaration, returning the
 * name as EXPORTED from the Lunora surface — so `import { query as q }` used as
 * `q(...)` answers `"query"`.
 *
 * The strictest of the three: `undefined` when the identifier is not imported
 * from the surface, so a local `const query = …` is not mistaken for a
 * registration. That strictness is affordable here because a misidentified
 * registration invents a route no handler backs; the middleware detectors
 * cannot afford it, which is why {@link resolvesToImportedName} exists.
 *
 * The one concession: with no type-checker info at all (no tsconfig wired up)
 * there is no symbol to resolve, and it falls back to the surface text rather
 * than dropping every function in the project.
 */
const resolveCalleeKind = (identifier: Identifier): string | undefined => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText();
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!TsNode.isImportSpecifier(declaration)) {
            continue;
        }

        // Only trust identifiers imported from the Lunora surface (the public
        // package or the generated `_generated/server` re-export).
        if (!isServerSurfaceModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return undefined;
        }

        // `import { query as q }` → `getNameNode()` is `query`, `getAliasNode()`
        // is `q`. The kind we care about is the exported name, not the alias.
        return declaration.getNameNode().getText();
    }

    // A symbol with no surface import specifier among its declarations — a local
    // binding, or imported from somewhere else. Reject rather than pick it up.
    return undefined;
};

export { calleeName, resolveCalleeKind, resolvesToImportedName };
