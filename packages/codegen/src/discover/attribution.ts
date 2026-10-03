/**
 * Call-site attribution: which exported function a discovered call site runs on
 * behalf of. Every per-call-site collector names its site through
 * {@link callSiteScopeOf}, so a write, read or call moved into a same-file helper
 * is attributed to the exports that call the helper instead of vanishing.
 *
 * The expensive part — one identifier pass per file, resolving references to
 * the file's non-exported top-level helpers — runs once per parsed file and is
 * cached on the compiler `SourceFile`, so the collectors share it and a file
 * re-parsed in watch mode (a new compiler node) is re-indexed.
 */
import type { FunctionDeclaration, Identifier, Node as TsNode, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind, ts } from "ts-morph";

import type { CallSiteScope } from "../ir";

type TopLevelDeclaration = FunctionDeclaration | VariableDeclaration;

/** What a node lexically sits in: an `export default` expression, a top-level declaration, or neither. */
type LexicalContainer = { declaration: TopLevelDeclaration; kind: "declaration" } | { kind: "default" } | { kind: "module" };

/** The per-file attribution index, keyed by compiler nodes so it never outlives a re-parse. */
interface FileAttribution {
    /** Exported top-level declaration → the name it is exported under. */
    exportNames: ReadonlyMap<ts.Node, string>;
    /** Non-exported top-level declaration (a helper) → the exports reaching it, sorted. */
    helperCallers: ReadonlyMap<ts.Node, ReadonlyArray<string>>;
}

const INDEX_CACHE = new WeakMap<ts.SourceFile, FileAttribution>();

/** The top-level `function` / `const` an identifier-named declaration statement holds. */
const topLevelDeclarations = (sourceFile: SourceFile): TopLevelDeclaration[] =>
    sourceFile.getStatements().flatMap((statement): TopLevelDeclaration[] => {
        if (Node.isFunctionDeclaration(statement)) {
            return [statement];
        }

        return Node.isVariableStatement(statement) ? statement.getDeclarations().filter((declaration) => Node.isIdentifier(declaration.getNameNode())) : [];
    });

/**
 * The innermost top-level container of `node`: the top-level declaration it sits
 * in, the `export default <expression>` it sits in, or module scope.
 */
const lexicalContainerOf = (node: TsNode): LexicalContainer => {
    for (const ancestor of node.getAncestors()) {
        if (Node.isFunctionDeclaration(ancestor) && Node.isSourceFile(ancestor.getParent())) {
            return { declaration: ancestor, kind: "declaration" };
        }

        if (Node.isVariableDeclaration(ancestor) && Node.isSourceFile(ancestor.getVariableStatement()?.getParent())) {
            return Node.isIdentifier(ancestor.getNameNode()) ? { declaration: ancestor, kind: "declaration" } : { kind: "module" };
        }

        // `export default query(...)` registers as `<namespace>:default`.
        if (Node.isExportAssignment(ancestor) && !ancestor.isExportEquals()) {
            return { kind: "default" };
        }
    }

    return { kind: "module" };
};

/** The name an `export`-keyword declaration exports itself under, or `undefined` without the keyword. */
const keywordExportName = (declaration: TopLevelDeclaration): string | undefined => {
    if (Node.isFunctionDeclaration(declaration)) {
        if (!declaration.hasExportKeyword()) {
            return undefined;
        }

        return declaration.hasDefaultKeyword() ? "default" : (declaration.getName() ?? "default");
    }

    return declaration.getVariableStatement()?.hasExportKeyword() === true ? declaration.getName() : undefined;
};

/** `[localName, exportedName]` for every local `export { a as b }` specifier and `export default a` of the file. */
const exportStatementNames = (sourceFile: SourceFile): (readonly [string, string])[] =>
    sourceFile.getStatements().flatMap((statement): (readonly [string, string])[] => {
        if (Node.isExportDeclaration(statement) && !statement.hasModuleSpecifier() && !statement.isTypeOnly()) {
            return statement
                .getNamedExports()
                .map((specifier) => [specifier.getNameNode().getText(), specifier.getAliasNode()?.getText() ?? specifier.getName()] as const);
        }

        const expression = Node.isExportAssignment(statement) && !statement.isExportEquals() ? statement.getExpression() : undefined;

        return expression !== undefined && Node.isIdentifier(expression) ? [[expression.getText(), "default"] as const] : [];
    });

/**
 * Exported top-level declaration → its exported name, read syntactically (no
 * type checker): `export const` / `export function`, a local
 * `export { run as start }` (→ `start`), and `export default go` (→ `default`).
 * A declaration exported under several names takes the first in code-point
 * order, so the choice is stable.
 */
const exportNamesOf = (sourceFile: SourceFile, declarations: ReadonlyArray<TopLevelDeclaration>): Map<ts.Node, string> => {
    const byLocalName = new Map(declarations.map((declaration) => [declaration.getName(), declaration] as const));
    const names = new Map<ts.Node, string>();
    const offer = (declaration: TopLevelDeclaration | undefined, name: string | undefined): void => {
        if (declaration === undefined || name === undefined) {
            return;
        }

        const current = names.get(declaration.compilerNode);

        if (current === undefined || name < current) {
            names.set(declaration.compilerNode, name);
        }
    };

    for (const declaration of declarations) {
        offer(declaration, keywordExportName(declaration));
    }

    for (const [local, exported] of exportStatementNames(sourceFile)) {
        offer(byLocalName.get(local), exported);
    }

    return names;
};

/**
 * A reference that only names the helper's TYPE — `typeof helper`,
 * `Parameters<typeof helper>`, an annotation, a heritage clause — not a use of
 * its value, so it is not a call. A value passed on (`run(helper)`, `{ helper }`)
 * is kept: a helper handed off is plausibly invoked.
 */
const isTypePosition = (identifier: Identifier): boolean => identifier.getAncestors().some((ancestor) => ts.isTypeNode(ancestor.compilerNode));

/** The symbol an identifier refers to — a shorthand property (`{ helper }`) names its value, not the property. */
const referencedSymbolOf = (identifier: Identifier): ts.Symbol | undefined => {
    const parent = identifier.getParent();

    return (Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === identifier ? parent.getValueSymbol() : identifier.getSymbol())
        ?.compilerSymbol;
};

/** Where a helper is referenced from: an export (by name), another helper, or module scope (ignored). */
type ReferenceSource = { helper: ts.Node; kind: "helper" } | { kind: "export"; name: string };

/** What a reference made from `container` counts as: an export's, a helper's, or — at module scope — nothing. */
const referenceSourceOf = (container: LexicalContainer, exportNames: ReadonlyMap<ts.Node, string>): ReferenceSource | undefined => {
    if (container.kind === "default") {
        return { kind: "export", name: "default" };
    }

    if (container.kind === "module") {
        return undefined;
    }

    const exportName = exportNames.get(container.declaration.compilerNode);

    return exportName === undefined ? { helper: container.declaration.compilerNode, kind: "helper" } : { kind: "export", name: exportName };
};

/** The symbols and spellings of the helpers' own names, for the one identifier pass. */
const helperNamesOf = (helpers: ReadonlyArray<TopLevelDeclaration>): { bySymbol: Map<ts.Symbol, ts.Node>; nameNodes: Set<ts.Node>; spellings: Set<string> } => {
    const bySymbol = new Map<ts.Symbol, ts.Node>();
    const nameNodes = new Set<ts.Node>();
    const spellings = new Set<string>();

    for (const helper of helpers) {
        const nameNode = helper.getNameNode();
        const symbol = nameNode?.getSymbol()?.compilerSymbol;

        if (nameNode !== undefined && symbol !== undefined) {
            bySymbol.set(symbol, helper.compilerNode);
            nameNodes.add(nameNode.compilerNode);
            spellings.add(nameNode.getText());
        }
    }

    return { bySymbol, nameNodes, spellings };
};

/**
 * Every value reference to each helper, as the export or helper it is made from —
 * ONE identifier pass over the file, with the type checker consulted only for
 * identifiers spelled like a helper.
 */
const helperReferencesOf = (
    sourceFile: SourceFile,
    helpers: ReadonlyArray<TopLevelDeclaration>,
    exportNames: ReadonlyMap<ts.Node, string>,
): Map<ts.Node, ReferenceSource[]> => {
    const { bySymbol, nameNodes, spellings } = helperNamesOf(helpers);
    const references = new Map<ts.Node, ReferenceSource[]>();

    for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (!spellings.has(identifier.getText()) || nameNodes.has(identifier.compilerNode) || isTypePosition(identifier)) {
            continue;
        }

        const symbol = referencedSymbolOf(identifier);
        const helper = symbol === undefined ? undefined : bySymbol.get(symbol);

        if (helper === undefined) {
            continue;
        }

        const source = referenceSourceOf(lexicalContainerOf(identifier), exportNames);

        // A module-scope reference (`helper(boot)` at the top level) reaches no export.
        if (source !== undefined) {
            references.set(helper, [...(references.get(helper) ?? []), source]);
        }
    }

    return references;
};

/**
 * Helper → the exports reaching it: the fixed point of "an export referencing a
 * helper calls it; a helper referencing a helper passes its callers on". Cycles
 * converge because the sets only grow.
 */
const helperCallersOf = (helpers: ReadonlyArray<TopLevelDeclaration>, references: ReadonlyMap<ts.Node, ReferenceSource[]>): Map<ts.Node, string[]> => {
    const callers = new Map<ts.Node, Set<string>>(helpers.map((helper) => [helper.compilerNode, new Set<string>()]));
    // The names one reference passes on: its export's, or everything its helper has reached so far.
    const namesFrom = (source: ReferenceSource): Iterable<string> => (source.kind === "export" ? [source.name] : (callers.get(source.helper) ?? []));
    let changed = true;

    while (changed) {
        changed = false;

        for (const [helper, sources] of references) {
            const reached = callers.get(helper) ?? new Set<string>();
            const before = reached.size;

            for (const name of sources.flatMap((source) => [...namesFrom(source)])) {
                reached.add(name);
            }

            changed ||= reached.size !== before;
        }
    }

    return new Map([...callers].map(([helper, names]) => [helper, [...names].toSorted((a, b) => a.localeCompare(b))]));
};

/** Build (or reuse) the attribution index of one parsed file. */
const attributionOf = (sourceFile: SourceFile): FileAttribution => {
    const cached = INDEX_CACHE.get(sourceFile.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const declarations = topLevelDeclarations(sourceFile);
    const exportNames = exportNamesOf(sourceFile, declarations);
    const helpers = declarations.filter((declaration) => !exportNames.has(declaration.compilerNode));
    const index: FileAttribution = {
        exportNames,
        helperCallers: helpers.length === 0 ? new Map() : helperCallersOf(helpers, helperReferencesOf(sourceFile, helpers, exportNames)),
    };

    INDEX_CACHE.set(sourceFile.compilerNode, index);

    return index;
};

/**
 * The {@link CallSiteScope} of a call site: the export it sits in, the same-file
 * helper it sits in together with the exports reaching that helper, or module
 * scope.
 */
const callSiteScopeOf = (node: TsNode): CallSiteScope => {
    const container = lexicalContainerOf(node);

    if (container.kind === "default") {
        return { kind: "export", name: "default" };
    }

    if (container.kind === "module") {
        return { kind: "module" };
    }

    const index = attributionOf(node.getSourceFile());
    const key = container.declaration.compilerNode;
    const exportName = index.exportNames.get(key);

    if (exportName !== undefined) {
        return { kind: "export", name: exportName };
    }

    return { callers: index.helperCallers.get(key) ?? [], kind: "helper", name: container.declaration.getName() ?? "" };
};

/** The exports a site runs on behalf of: its own export, its helper's callers, or none. */
const exportedCallersOf = (scope: CallSiteScope): ReadonlyArray<string> => {
    switch (scope.kind) {
        case "export": {
            return [scope.name];
        }
        case "helper": {
            return scope.callers;
        }
        default: {
            return [];
        }
    }
};

/**
 * The visibility a site is reachable at through its callers, failing toward
 * reporting: `public` when any caller is public, `undefined` when any caller is
 * not a registered function (or there are none), else `internal`.
 */
const callerVisibilityOf = (
    scope: CallSiteScope,
    visibilityOf: (exportName: string) => "internal" | "public" | undefined,
): "internal" | "public" | undefined => {
    const visibilities = exportedCallersOf(scope).map((exportName) => visibilityOf(exportName));

    if (visibilities.includes("public")) {
        return "public";
    }

    return visibilities.length === 0 || visibilities.includes(undefined) ? undefined : "internal";
};

/** The name a top-level declaration is exported under (`export { run as start }` → `start`), or `undefined`. */
const exportedNameOf = (declaration: TopLevelDeclaration): string | undefined =>
    attributionOf(declaration.getSourceFile()).exportNames.get(declaration.compilerNode);

export { callerVisibilityOf, callSiteScopeOf, exportedCallersOf, exportedNameOf };
