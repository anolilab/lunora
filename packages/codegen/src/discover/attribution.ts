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
import { callSiteCallers } from "@lunora/advisor";
import type { FunctionDeclaration, Identifier, Node as TsNode, SourceFile, Symbol as TsSymbol, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind, ts } from "ts-morph";

import type { CallSiteScope, FunctionIR } from "../ir";

type TopLevelDeclaration = FunctionDeclaration | VariableDeclaration;

/**
 * What code lexically belongs to: an export (by its exported name), a same-file
 * helper, or something attribution cannot follow — module scope (an inline
 * `http.route({ handler })`), a class body, a destructured declaration.
 */
type Owner = { declaration: TopLevelDeclaration; kind: "helper" } | { kind: "export"; name: string } | { kind: "untracked" };

/** How a helper is reached: the exports calling it, and whether untracked code also does. */
interface HelperReach {
    callers: ReadonlyArray<string>;
    untracked: boolean;
}

/** The per-file attribution index, keyed by compiler nodes so it never outlives a re-parse. */
interface FileAttribution {
    /** Exported top-level declaration → the name it is exported under. */
    exportNames: ReadonlyMap<ts.Node, string>;
    /** Non-exported top-level declaration (a helper) → how it is reached. */
    helperReach: ReadonlyMap<ts.Node, HelperReach>;
}

const INDEX_CACHE = new WeakMap<ts.SourceFile, FileAttribution>();

/** The top-level `function` / identifier-named `const` declarations of a file. */
const topLevelDeclarations = (sourceFile: SourceFile): TopLevelDeclaration[] =>
    sourceFile.getStatements().flatMap((statement): TopLevelDeclaration[] => {
        if (Node.isFunctionDeclaration(statement)) {
            return [statement];
        }

        return Node.isVariableStatement(statement) ? statement.getDeclarations().filter((declaration) => Node.isIdentifier(declaration.getNameNode())) : [];
    });

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
 * The ONE mapping from where code sits to who owns it. Walks to the top-level
 * container: an `export default <expression>` is the `default` export; a
 * top-level `function` / identifier-named `const` is its export or a helper;
 * anything else — module scope, a class, a destructured declaration — is
 * untracked.
 */
const ownerOf = (node: TsNode, exportNames: ReadonlyMap<ts.Node, string>): Owner => {
    for (const ancestor of node.getAncestors()) {
        if (Node.isExportAssignment(ancestor) && !ancestor.isExportEquals()) {
            return { kind: "export", name: "default" };
        }

        const isTopLevel =
            (Node.isFunctionDeclaration(ancestor) && Node.isSourceFile(ancestor.getParent())) ||
            (Node.isVariableDeclaration(ancestor) &&
                Node.isSourceFile(ancestor.getVariableStatement()?.getParent()) &&
                Node.isIdentifier(ancestor.getNameNode()));

        if (isTopLevel && (Node.isFunctionDeclaration(ancestor) || Node.isVariableDeclaration(ancestor))) {
            const name = exportNames.get(ancestor.compilerNode);

            return name === undefined ? { declaration: ancestor, kind: "helper" } : { kind: "export", name };
        }
    }

    return { kind: "untracked" };
};

/**
 * A reference that only names the helper's TYPE — `typeof helper`,
 * `Parameters<typeof helper>`, an annotation, an `implements` / interface
 * heritage clause — not a use of its value, so it is not a call. A value passed
 * on (`run(helper)`, `{ helper }`) is kept, and so is a class's `extends`
 * expression (`extends mixin(helper)`), which runs.
 */
const isTypePosition = (identifier: Identifier): boolean => {
    for (const ancestor of identifier.getAncestors()) {
        if (Node.isExpressionWithTypeArguments(ancestor)) {
            const clause = ancestor.getParent();
            const isClassExtends =
                Node.isHeritageClause(clause) &&
                clause.getToken() === SyntaxKind.ExtendsKeyword &&
                (Node.isClassDeclaration(clause.getParent()) || Node.isClassExpression(clause.getParent()));

            return !isClassExtends;
        }

        if (ts.isTypeNode(ancestor.compilerNode)) {
            return true;
        }
    }

    return false;
};

/** The symbol an identifier refers to — a shorthand property (`{ helper }`) names its value, not the property. */
const referencedSymbolOf = (identifier: Identifier): TsSymbol | undefined => {
    const parent = identifier.getParent();

    return Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === identifier ? parent.getValueSymbol() : identifier.getSymbol();
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
 * Every value reference to each helper, as the {@link Owner} of the code making
 * it — ONE identifier pass over the file, with the type checker consulted only
 * for identifiers spelled like a helper.
 */
const helperReferencesOf = (
    sourceFile: SourceFile,
    helpers: ReadonlyArray<TopLevelDeclaration>,
    exportNames: ReadonlyMap<ts.Node, string>,
): Map<ts.Node, Owner[]> => {
    const { bySymbol, nameNodes, spellings } = helperNamesOf(helpers);
    const references = new Map<ts.Node, Owner[]>();

    for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (!spellings.has(identifier.getText()) || nameNodes.has(identifier.compilerNode) || isTypePosition(identifier)) {
            continue;
        }

        const symbol = referencedSymbolOf(identifier)?.compilerSymbol;
        const helper = symbol === undefined ? undefined : bySymbol.get(symbol);

        if (helper !== undefined) {
            references.set(helper, [...(references.get(helper) ?? []), ownerOf(identifier, exportNames)]);
        }
    }

    return references;
};

/**
 * Helper → how it is reached: the fixed point of "an export referencing a helper
 * calls it; untracked code referencing it makes it untracked; a helper
 * referencing a helper passes its callers (and untracked-ness) on". Cycles
 * converge because both only grow.
 */
const helperReachOf = (helpers: ReadonlyArray<TopLevelDeclaration>, references: ReadonlyMap<ts.Node, Owner[]>): Map<ts.Node, HelperReach> => {
    const callers = new Map<ts.Node, Set<string>>(helpers.map((helper) => [helper.compilerNode, new Set<string>()]));
    const untracked = new Set<ts.Node>();
    const sizeOf = (helper: ts.Node): number => (callers.get(helper)?.size ?? 0) + (untracked.has(helper) ? 1 : 0);
    // Fold one reference into `helper`'s reach; true when that grew it.
    const absorb = (helper: ts.Node, owner: Owner): boolean => {
        const before = sizeOf(helper);
        const reached = callers.get(helper);
        const inherited = owner.kind === "helper" ? owner.declaration.compilerNode : undefined;

        if (owner.kind === "export") {
            reached?.add(owner.name);
        }

        for (const name of inherited === undefined ? [] : (callers.get(inherited) ?? [])) {
            reached?.add(name);
        }

        if (owner.kind === "untracked" || (inherited !== undefined && untracked.has(inherited))) {
            untracked.add(helper);
        }

        return sizeOf(helper) !== before;
    };
    let changed = true;

    while (changed) {
        changed = false;

        for (const [helper, owners] of references) {
            for (const owner of owners) {
                changed = absorb(helper, owner) || changed;
            }
        }
    }

    return new Map(
        [...callers].map(([helper, names]) => [helper, { callers: [...names].toSorted((a, b) => a.localeCompare(b)), untracked: untracked.has(helper) }]),
    );
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
        helperReach: helpers.length === 0 ? new Map() : helperReachOf(helpers, helperReferencesOf(sourceFile, helpers, exportNames)),
    };

    INDEX_CACHE.set(sourceFile.compilerNode, index);

    return index;
};

/**
 * The {@link CallSiteScope} of a call site: the export it sits in, the same-file
 * helper it sits in together with how that helper is reached, or module scope
 * (which covers every container attribution cannot follow).
 */
const callSiteScopeOf = (node: TsNode): CallSiteScope => {
    const index = attributionOf(node.getSourceFile());
    const owner = ownerOf(node, index.exportNames);

    switch (owner.kind) {
        case "export": {
            return { kind: "export", name: owner.name };
        }
        case "helper": {
            const name = owner.declaration.getName();
            const reach = index.helperReach.get(owner.declaration.compilerNode);

            // A helper is never an unnamed `function` (that only parses as `export default`).
            if (name === undefined || reach === undefined) {
                throw new Error(`call-site attribution: helper at ${owner.declaration.getSourceFile().getFilePath()} is not indexed`);
            }

            return { callers: reach.callers, kind: "helper", name, ...(reach.untracked ? { untracked: true as const } : {}) };
        }
        default: {
            return { kind: "module" };
        }
    }
};

type Visibility = FunctionIR["visibility"];

/**
 * The visibility a site is reachable at through its callers, failing toward
 * reporting: `public` when any caller is public; `undefined` — report as if
 * public — when any caller is not a registered function, when untracked code
 * reaches the helper, or when nothing does; else `internal`.
 */
const callerVisibilityOf = (scope: CallSiteScope, visibilityOf: (exportName: string) => Visibility | undefined): Visibility | undefined => {
    const visibilities = callSiteCallers(scope).map((exportName) => visibilityOf(exportName));

    if (visibilities.includes("public")) {
        return "public";
    }

    const incomplete = visibilities.length === 0 || visibilities.includes(undefined) || (scope.kind === "helper" && scope.untracked === true);

    return incomplete ? undefined : "internal";
};

/** Stamp each row with its {@link callerVisibilityOf} visibility, read off the registered functions of its file. */
const withCallerVisibility = <Row extends { file: string; scope: CallSiteScope }>(
    rows: ReadonlyArray<Row>,
    functions: ReadonlyArray<Pick<FunctionIR, "exportName" | "filePath" | "visibility">>,
): (Row & { visibility?: Visibility })[] => {
    // Keyed on file + export because two modules may export the same name.
    const visibilityByKey = new Map(functions.map((entry) => [`${entry.filePath}:${entry.exportName}`, entry.visibility]));

    return rows.map((row) => {
        const visibility = callerVisibilityOf(row.scope, (exportName) => visibilityByKey.get(`${row.file}:${exportName}`));

        return visibility === undefined ? row : { ...row, visibility };
    });
};

/** The name a top-level declaration is exported under (`export { run as start }` → `start`), or `undefined`. */
const exportedNameOf = (declaration: TopLevelDeclaration): string | undefined =>
    attributionOf(declaration.getSourceFile()).exportNames.get(declaration.compilerNode);

export { callSiteScopeOf, exportedNameOf, referencedSymbolOf, withCallerVisibility };
