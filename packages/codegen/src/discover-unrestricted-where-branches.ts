import type { ArrowFunction, FunctionExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { UnrestrictedWhereBranchIR } from "./ir";

/**
 * Config keys whose value is a row predicate returning a `WhereInput`: a
 * `defineShape({ where })` and an RLS `definePolicy({ when })`.
 *
 * Both share the same trap. The predicate returns a *filter*, not a boolean, so the
 * denial branch has to be a predicate matching **no** rows — `deny()` /
 * `{ OR: [] }`, a disjunction over zero branches. The plausible-looking `{}` is its
 * exact opposite: it matches every row, so a branch meaning "this caller sees
 * nothing" silently replicates (or exposes) the whole table. There is no error, no
 * log line, and the shape still "works".
 */
const PREDICATE_KEYS = new Set<string>(["when", "where"]);

/** Calls whose config object may carry one of the {@link PREDICATE_KEYS}. */
const PREDICATE_OWNERS = new Set<string>(["definePolicy", "defineShape"]);

/** A function-ish predicate body we can walk. */
type PredicateFunction = ArrowFunction | FunctionExpression;

/**
 * The `defineShape` / `definePolicy` callee name for `call`, or `undefined`.
 *
 * Matched by shape (a bare identifier, or the member name of a namespace import)
 * rather than by resolving the import, the same import-agnostic convention the other
 * feeders use — so an alias or a re-export still resolves.
 */
const predicateOwnerName = (call: TsNode): string | undefined => {
    if (!Node.isCallExpression(call)) {
        return undefined;
    }

    const callee = call.getExpression();

    // `ns.defineShape(...)` — the member name is the declared name, aliases don't apply.
    if (Node.isPropertyAccessExpression(callee)) {
        const name = callee.getName();

        return PREDICATE_OWNERS.has(name) ? name : undefined;
    }

    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    // Resolve through the import so `import { defineShape as shape }` still counts —
    // the local spelling is `shape`, but the *imported* name is what identifies the
    // predicate owner. Mirrors how the shape/migration feeders resolve their markers.
    for (const declaration of callee.getSymbol()?.getDeclarations() ?? []) {
        if (Node.isImportSpecifier(declaration)) {
            const imported = declaration.getNameNode().getText();

            return PREDICATE_OWNERS.has(imported) ? imported : undefined;
        }
    }

    // No symbol (an un-typechecked fixture) — fall back to the surface text.
    const text = callee.getText();

    return PREDICATE_OWNERS.has(text) ? text : undefined;
};

/** `true` for an object literal with no properties — the everything-matches predicate. */
const isEmptyObjectLiteral = (node: TsNode): boolean => Node.isObjectLiteralExpression(node) && node.getProperties().length === 0;

/**
 * Classify a returned expression as an unrestricted predicate, or `undefined` when
 * it is fine (or not statically decidable).
 *
 * Only two forms are reported, both unambiguous. `{}` matches every row. And
 * `undefined` — for a policy `when` that means "opt this policy out", which reads like
 * a denial but isn't one; for a shape `where` it isn't a predicate at all.
 *
 * A non-empty object, a variable, a call (`deny()`), a spread, a conditional — all
 * left alone. The lint's value is catching the near-miss, not second-guessing
 * predicates it cannot evaluate.
 */
const unrestrictedForm = (node: TsNode | undefined): "empty-object" | "undefined" | undefined => {
    if (node === undefined) {
        return undefined;
    }

    // A bare `return;` — `returnedExpressions` hands the statement itself over, since
    // there is no expression node to point at.
    if (Node.isReturnStatement(node) && node.getExpression() === undefined) {
        return "undefined";
    }

    // An explicit `return undefined;`.
    if (node.getKind() === SyntaxKind.UndefinedKeyword || node.getText() === "undefined") {
        return "undefined";
    }

    if (isEmptyObjectLiteral(node)) {
        return "empty-object";
    }

    // `({})` — a parenthesized concise arrow body.
    if (Node.isParenthesizedExpression(node)) {
        return unrestrictedForm(node.getExpression());
    }

    return undefined;
};

/**
 * The nearest enclosing function of `node`, or `undefined` at the top level.
 *
 * `getDescendantsOfKind` recurses through nested functions, so a `return {}` inside a
 * helper callback would otherwise be read as one of the predicate's own exits — turning
 * a single-exit predicate into an apparent guard and reporting a false positive.
 */
const enclosingFunction = (node: TsNode): TsNode | undefined =>
    node.getAncestors().find((ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor));

/** `return` statements belonging to `predicate` itself, not to a nested callback. */
const ownReturnStatements = (predicate: PredicateFunction): TsNode[] =>
    predicate.getDescendantsOfKind(SyntaxKind.ReturnStatement).filter((statement) => enclosingFunction(statement) === predicate);

/** Ternaries belonging to `predicate` itself, not to a nested callback. */
const ownConditionals = (predicate: PredicateFunction) =>
    predicate.getDescendantsOfKind(SyntaxKind.ConditionalExpression).filter((conditional) => enclosingFunction(conditional) === predicate);

/**
 * Whether the predicate has more than one exit — i.e. it *branches*.
 *
 * A single-exit `where: () => ({})` is an author deliberately writing "replicate
 * everything", which is a legitimate (if broad) shape and not what this lint is
 * about. The dangerous pattern is a predicate that guards — `if (!ctx.auth.userId)
 * return {}` — where one arm was meant to deny and instead opens the table up. So a
 * form is only reported when the function has a conditional exit alongside it.
 */
const hasBranchingExits = (predicate: PredicateFunction): boolean => {
    const returns = ownReturnStatements(predicate);

    if (returns.length > 1) {
        return true;
    }

    // One `return` inside an `if` (with the fall-through being the other exit), or a
    // ternary in a concise body, both count as branching.
    return returns.some((statement) => statement.getFirstAncestorByKind(SyntaxKind.IfStatement) !== undefined) || ownConditionals(predicate).length > 0;
};

/** Every returned expression of `predicate`, including a concise arrow body. */
const returnedExpressions = (predicate: PredicateFunction): TsNode[] => {
    const found: TsNode[] = [];
    const body = predicate.getBody();

    // Concise arrow body (`() => ({})`): the body IS the returned expression.
    if (!Node.isBlock(body)) {
        found.push(body);
    }

    for (const statement of ownReturnStatements(predicate)) {
        const expression = Node.isReturnStatement(statement) ? statement.getExpression() : undefined;

        // A bare `return;` yields undefined — record the statement so the line is right.
        found.push(expression ?? statement);
    }

    // A ternary's two arms are each an exit.
    for (const conditional of ownConditionals(predicate)) {
        found.push(conditional.getWhenTrue(), conditional.getWhenFalse());
    }

    return found;
};

/** Resolve the enclosing exported binding name for a node, or `"<anonymous>"`. */
const enclosingExport = (node: TsNode): string => {
    for (const declaration of node.getAncestors()) {
        if (Node.isVariableDeclaration(declaration)) {
            const nameNode = declaration.getNameNode();

            if (Node.isIdentifier(nameNode)) {
                return nameNode.getText();
            }
        }
    }

    return "<anonymous>";
};

/** Unrestricted branches in one `defineShape`/`definePolicy` call. */
const branchesInCall = (call: TsNode, owner: string, relativePath: string): UnrestrictedWhereBranchIR[] => {
    if (!Node.isCallExpression(call)) {
        return [];
    }

    const [config] = call.getArguments();

    if (!config || !Node.isObjectLiteralExpression(config)) {
        return [];
    }

    const found: UnrestrictedWhereBranchIR[] = [];

    for (const property of config.getProperties()) {
        if (!Node.isPropertyAssignment(property) || !PREDICATE_KEYS.has(property.getName())) {
            continue;
        }

        const initializer = property.getInitializer();

        if (!initializer || !(Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
            continue;
        }

        if (!hasBranchingExits(initializer)) {
            continue;
        }

        for (const returned of returnedExpressions(initializer)) {
            const form = unrestrictedForm(returned);

            if (form !== undefined) {
                found.push({
                    exportName: enclosingExport(call),
                    file: relativePath,
                    form,
                    key: property.getName(),
                    line: returned.getStartLineNumber(),
                    owner,
                });
            }
        }
    }

    return found;
};

/** Unrestricted predicate branches across one source file. */
const branchesInSourceFile = (sourceFile: SourceFile, relativePath: string): UnrestrictedWhereBranchIR[] => {
    const found: UnrestrictedWhereBranchIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const owner = predicateOwnerName(call);

        if (owner !== undefined) {
            found.push(...branchesInCall(call, owner, relativePath));
        }
    }

    return found;
};

/**
 * Discover branching `defineShape({ where })` / `definePolicy({ when })` predicates
 * with an arm that returns `{}` or `undefined` — the `unrestricted_where_branch`
 * lint input.
 *
 * A row predicate's denial arm must match no rows (`deny()`), and `{}` matches every
 * row, so this is the one mistake in the shape/RLS surface that silently replicates
 * a whole table instead of failing. `deny()` exists to be written; this catches the
 * case where it wasn't.
 */
const discoverUnrestrictedWhereBranches = (project: Project, lunoraDirectory: string): UnrestrictedWhereBranchIR[] => {
    const branches: UnrestrictedWhereBranchIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        branches.push(...branchesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return branches;
};

export default discoverUnrestrictedWhereBranches;
