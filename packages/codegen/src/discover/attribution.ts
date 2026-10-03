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
import { byCodepoint, callSiteCallers } from "@lunora/advisor";
import type { BindingElement, FunctionDeclaration, Identifier, Node as TsNode, SourceFile, Symbol as TsSymbol, VariableDeclaration } from "ts-morph";
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
    /** Exported top-level declaration → every name it is exported under, sorted. */
    exportNames: ReadonlyMap<ts.Node, ReadonlyArray<string>>;
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

/** The value an export specifier's name node spells: `start` for `start`, `kebab-name` for `"kebab-name"`. */
const exportNameText = (node: TsNode): string => (Node.isStringLiteral(node) ? node.getLiteralValue() : node.getText());

/** The local names a top-level statement with the `export` keyword exports under their own names (`default` for an anonymous default). */
const keywordExportedNames = (statement: TsNode): [local: string, exported: string][] => {
    if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement)) {
        const name = statement.getName();

        if (!statement.hasExportKeyword()) {
            return [];
        }

        return [[name ?? "default", statement.hasDefaultKeyword() ? "default" : (name ?? "default")]];
    }

    if (!Node.isVariableStatement(statement) || !statement.hasExportKeyword()) {
        return [];
    }

    return statement.getDeclarations().flatMap((declaration): [string, string][] => {
        const nameNode = declaration.getNameNode();

        if (Node.isIdentifier(nameNode)) {
            return [[nameNode.getText(), nameNode.getText()]];
        }

        return nameNode
            .getDescendantsOfKind(SyntaxKind.BindingElement)
            .flatMap((element): [string, string][] => (Node.isIdentifier(element.getNameNode()) ? [[element.getName(), element.getName()]] : []));
    });
};

/** The `[local, exported]` name pairs one top-level statement contributes: its `export` keyword, a local `export { … }`, `export default <identifier>`. */
const exportedNamesOfStatement = (statement: TsNode): [local: string, exported: string][] => {
    if (Node.isExportDeclaration(statement)) {
        return statement.hasModuleSpecifier() || statement.isTypeOnly()
            ? []
            : statement
                  .getNamedExports()
                  .filter((specifier) => !specifier.isTypeOnly())
                  .map((specifier): [string, string] => {
                      const local = exportNameText(specifier.getNameNode());
                      const alias = specifier.getAliasNode();

                      return [local, alias === undefined ? local : exportNameText(alias)];
                  });
    }

    const expression = Node.isExportAssignment(statement) && !statement.isExportEquals() ? statement.getExpression() : undefined;

    return Node.isIdentifier(expression) ? [[expression.getText(), "default"]] : keywordExportedNames(statement);
};

/** Per-file {@link exportNamesByLocalOf} indexes, keyed by the compiler node so a re-parse rebuilds them. */
const EXPORT_NAMES_CACHE = new WeakMap<ts.SourceFile, ReadonlyMap<string, ReadonlyArray<string>>>();

/**
 * Local top-level binding name → every name the module exports it under,
 * sorted in code-point order, read syntactically (no type checker): the
 * `export` keyword on its declaration (`export const run`, `export function`,
 * a destructured `export const { check } = …`), each local specifier
 * (`export { run as start }` → `start`, `export { run as "kebab-name" }` →
 * `kebab-name`), and `export default run` → `default`. Re-exports
 * (`export { x } from "./other"`) and type-only specifiers name no local value.
 */
const exportNamesByLocalOf = (sourceFile: SourceFile): ReadonlyMap<string, ReadonlyArray<string>> => {
    const cached = EXPORT_NAMES_CACHE.get(sourceFile.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const names = new Map<string, Set<string>>();

    for (const [local, exported] of sourceFile.getStatements().flatMap((statement) => exportedNamesOfStatement(statement))) {
        names.set(local, (names.get(local) ?? new Set()).add(exported));
    }

    const index = new Map([...names].map(([local, exported]) => [local, [...exported].toSorted(byCodepoint)] as const));

    EXPORT_NAMES_CACHE.set(sourceFile.compilerNode, index);

    return index;
};

/**
 * Every name a top-level `function`, variable or destructured binding is
 * exported under, sorted in code-point order (see {@link exportNamesByLocalOf});
 * `[]` for one the module does not export. A binding nested in a function is
 * never exported.
 */
const exportNamesOfDeclaration = (declaration: BindingElement | FunctionDeclaration | VariableDeclaration): ReadonlyArray<string> => {
    const statement = Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement) : undefined;
    const variableStatement = Node.isVariableDeclaration(declaration) ? declaration.getVariableStatement() : undefined;
    const holder = Node.isFunctionDeclaration(declaration) ? declaration : (statement ?? variableStatement);

    if (holder === undefined || !Node.isSourceFile(holder.getParent())) {
        return [];
    }

    const name = Node.isFunctionDeclaration(declaration) ? (declaration.getName() ?? "default") : declaration.getName();

    return exportNamesByLocalOf(declaration.getSourceFile()).get(name) ?? [];
};

/**
 * Exported top-level declaration → every name it is exported under, sorted;
 * the attribution names an export site by the first, so the choice is stable.
 */
const exportNamesOf = (declarations: ReadonlyArray<TopLevelDeclaration>): Map<ts.Node, ReadonlyArray<string>> =>
    new Map(
        declarations.flatMap((declaration) => {
            const names = exportNamesOfDeclaration(declaration);

            return names.length === 0 ? [] : [[declaration.compilerNode, names] as const];
        }),
    );

/**
 * The ONE mapping from where code sits to who owns it. Walks to the top-level
 * container: an `export default <expression>` is the `default` export; a
 * top-level `function` / identifier-named `const` is its export or a helper;
 * anything else — module scope, a class, a destructured declaration — is
 * untracked.
 */
const ownerOf = (node: TsNode, exportNames: ReadonlyMap<ts.Node, ReadonlyArray<string>>): Owner => {
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
            const name = exportNames.get(ancestor.compilerNode)?.[0];

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

/** The declaration an identifier's {@link referencedSymbolOf} symbol points at, or `undefined` when it has none. */
const declarationOf = (identifier: Identifier): TsNode | undefined => {
    const symbol = referencedSymbolOf(identifier);

    return symbol?.getValueDeclaration() ?? symbol?.getDeclarations()[0];
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
    exportNames: ReadonlyMap<ts.Node, ReadonlyArray<string>>,
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
    const exportNames = exportNamesOf(declarations);
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
const exportedNameOf = (declaration: TopLevelDeclaration): string | undefined => exportNamesOfDeclaration(declaration)[0];

/**
 * The top-level variable declarations `sourceFile` exports, however it spells
 * the export: the `export` keyword, a local `export { a as b }` specifier, or
 * `export default a`. The per-procedure feeders walk these, so a procedure
 * exported only by a specifier gets the same lints as `export const`.
 */
const exportedVariableDeclarationsOf = (sourceFile: SourceFile): VariableDeclaration[] =>
    sourceFile
        .getVariableStatements()
        .flatMap((statement) => statement.getDeclarations())
        .filter((declaration) =>
            Node.isIdentifier(declaration.getNameNode())
                ? exportNamesOfDeclaration(declaration).length > 0
                : declaration.getVariableStatement()?.hasExportKeyword() === true,
        );

/**
 * The name a lint row names an exported declaration by: the first of its
 * exported names (the one attribution names its sites by), or its own name for
 * a destructured `export const { … }`.
 */
const primaryExportName = (declaration: VariableDeclaration): string => exportNamesOfDeclaration(declaration)[0] ?? declaration.getName();

/** An ASCII JavaScript identifier, the names emit can spell as `lunora_x.<name>`. */
const IDENTIFIER_NAME = /^[$A-Z_a-z][\w$]*$/u;

/**
 * Whether `name` can be emitted as a property access on the generated module
 * namespace (`lunora_x.<name>`): an identifier. A string-literal export alias
 * (`export { run as "kebab-name" }`) is not, so it is never registered.
 */
const isAddressableExportName = (name: string): boolean => IDENTIFIER_NAME.test(name);

export {
    callSiteScopeOf,
    declarationOf,
    exportedNameOf,
    exportedVariableDeclarationsOf,
    exportNamesByLocalOf,
    exportNamesOfDeclaration,
    isAddressableExportName,
    isTypePosition,
    primaryExportName,
    referencedSymbolOf,
    withCallerVisibility,
};
