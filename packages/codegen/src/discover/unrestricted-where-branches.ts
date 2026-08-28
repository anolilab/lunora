import type { ArrowFunction, FunctionExpression, IfStatement, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { UnrestrictedWhereBranchIR } from "../ir";
import { listLunoraSourceFiles, lunoraRelativePath } from "./ast";

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
 * A non-empty object, a variable, a call — all left alone. That includes `deny()`
 * and `allowAll()` from `@lunora/server`: both are calls, so they never match either
 * form here regardless of which arm they sit on — an explicit `allowAll()` is never
 * flagged. The lint's value is catching the near-miss, not second-guessing
 * predicates it cannot evaluate.
 */
const unrestrictedForm = (node: TsNode | undefined): "empty-object" | "undefined" | undefined => {
    if (node === undefined) {
        return undefined;
    }

    // A bare `return;` — `returnedValue` hands the statement itself over, since
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

/** `if`-statements belonging to `predicate` itself, not to a nested callback. */
const ownIfStatements = (predicate: PredicateFunction): IfStatement[] =>
    predicate.getDescendantsOfKind(SyntaxKind.IfStatement).filter((ifStatement) => enclosingFunction(ifStatement) === predicate);

/**
 * `true` for the operands that make an equality comparison read as an ABSENCE test:
 * `null`, `undefined`, and the falsy literals `false` / `0` / `""`.
 *
 * `x === undefined` is the same assertion as `!x` for guard purposes — it is true
 * exactly when the caller has no identity — so it must read `negative`, not the
 * `positive` every `===` would otherwise get.
 */
const isAbsenceOperand = (node: TsNode): boolean => {
    if (node.getKind() === SyntaxKind.NullKeyword || node.getKind() === SyntaxKind.FalseKeyword) {
        return true;
    }

    if (Node.isIdentifier(node) && node.getText() === "undefined") {
        return true;
    }

    if (Node.isNumericLiteral(node)) {
        return node.getLiteralValue() === 0;
    }

    return Node.isStringLiteral(node) && node.getLiteralValue() === "";
};

/** `true` when either side of a comparison is an {@link isAbsenceOperand}. */
const comparesAgainstAbsence = (left: TsNode, right: TsNode): boolean => isAbsenceOperand(left) || isAbsenceOperand(right);

/** How each equality operator reads for an IDENTITY match (`ctx.auth.userId === userId`). */
const EQUALITY_POLARITY = new Map<SyntaxKind, "negative" | "positive">([
    [SyntaxKind.EqualsEqualsEqualsToken, "positive"],
    [SyntaxKind.EqualsEqualsToken, "positive"],
    [SyntaxKind.ExclamationEqualsEqualsToken, "negative"],
    [SyntaxKind.ExclamationEqualsToken, "negative"],
]);

/**
 * `true` for a literal that is NOT an {@link isAbsenceOperand} — `"admin"`, `42`,
 * `true`, a template with no substitutions.
 *
 * Compared against one of these, an equality operator carries no access meaning:
 * `ctx.role === "admin"` is an allow check and `ctx.role === "banned"` a deny check,
 * written identically; `ctx.role !== "guest"` is an allow check written with the
 * operator that otherwise reads as a denial. This is the operand class that has to
 * stay unclassified, and it is narrower than "not an identity match" — the ownership
 * comparison `ctx.auth.userId !== userId` DOES read negative, and is the shape that
 * prompted this lint in the first place.
 */
const isOpaqueLiteralOperand = (node: TsNode): boolean =>
    !isAbsenceOperand(node) && (Node.isLiteralExpression(node) || node.getKind() === SyntaxKind.TrueKeyword);

/**
 * Polarity of an equality comparison, or `undefined` when `operator` is not one or
 * this cannot read a polarity off it.
 *
 * An absence operand inverts the base identity reading: `x === y` asserts a match
 * (positive) but `x === undefined` asserts the caller has none (negative), and
 * `x !== undefined` is the presence assertion `!x` inverted (positive). An
 * {@link isOpaqueLiteralOperand} on either side yields no reading at all — which
 * also leaves `typeof x !== "undefined"` unclassified, as {@link conditionPolarity}
 * documents.
 */
const equalityPolarity = (operator: SyntaxKind, left: TsNode, right: TsNode): "negative" | "positive" | undefined => {
    const base = EQUALITY_POLARITY.get(operator);

    if (base === undefined) {
        return undefined;
    }

    if (comparesAgainstAbsence(left, right)) {
        return base === "positive" ? "negative" : "positive";
    }

    return isOpaqueLiteralOperand(left) || isOpaqueLiteralOperand(right) ? undefined : base;
};

/**
 * Whether a guard condition reads as testing FOR access ("positive": true means
 * "this caller is allowed") or testing for its ABSENCE ("negative": true means
 * "this caller is NOT allowed") — judged purely from syntactic shape (`!` reads
 * negative; a bare truthy check reads positive; an identity comparison reads off its
 * operator, `===`/`==` positive and `!==`/`!=` negative; an absence operand — `null`,
 * `undefined`, `false`, `0`, `""` — flips that, so `x === undefined` reads negative
 * and `x !== undefined` positive; any OTHER literal operand cancels the reading
 * entirely, so `x === "admin"` and `x !== "guest"` say nothing; an `&&`/`||` chain
 * reads as whichever polarity every operand agrees on), never by evaluating what
 * the condition actually means.
 *
 * `"indeterminate"` covers everything this can't classify safely — a compound
 * condition mixing both polarities, `typeof`, `instanceof`, anything else — and the
 * caller must leave those alone rather than guess which arm is the deny one.
 */
const conditionPolarity = (condition: TsNode): "indeterminate" | "negative" | "positive" => {
    if (Node.isParenthesizedExpression(condition)) {
        return conditionPolarity(condition.getExpression());
    }

    if (Node.isPrefixUnaryExpression(condition) && condition.getOperatorToken() === SyntaxKind.ExclamationToken) {
        return "negative";
    }

    if (Node.isBinaryExpression(condition)) {
        const operator = condition.getOperatorToken().getKind();
        const equality = equalityPolarity(operator, condition.getLeft(), condition.getRight());

        if (equality !== undefined) {
            return equality;
        }

        if (operator === SyntaxKind.AmpersandAmpersandToken || operator === SyntaxKind.BarBarToken) {
            const left = conditionPolarity(condition.getLeft());
            const right = conditionPolarity(condition.getRight());

            return left === right ? left : "indeterminate";
        }
    }

    // A bare truthy check (`ctx.auth.isAdmin`, `flags.enabled`, a call) — a caller
    // writing just the identifier is asserting it, not its absence.
    if (
        Node.isIdentifier(condition) ||
        Node.isPropertyAccessExpression(condition) ||
        Node.isElementAccessExpression(condition) ||
        Node.isCallExpression(condition)
    ) {
        return "positive";
    }

    return "indeterminate";
};

/** The direct `return` statement of an `if`'s `then`/`else` clause, or `undefined` if it isn't simply that. */
const directReturn = (clause: TsNode | undefined): TsNode | undefined => {
    if (clause === undefined) {
        return undefined;
    }

    if (Node.isReturnStatement(clause)) {
        return clause;
    }

    if (Node.isBlock(clause)) {
        const last = clause.getStatements().at(-1);

        return last !== undefined && Node.isReturnStatement(last) ? last : undefined;
    }

    return undefined;
};

/**
 * The `return` reached when `ifStatement` has no `else` and its guard is false — the
 * single `return` immediately following it in the same block, with nothing else
 * after that. A second guard clause chained on afterward (`if (a) return x; if (b)
 * return y; return z;`) breaks that "immediately following" test for the first
 * `if`: `z` is reached only when BOTH guards are false, not just this one, so
 * attributing it to a single condition would be a guess rather than a fact the AST
 * actually gives us.
 */
const fallthroughReturn = (ifStatement: IfStatement): TsNode | undefined => {
    if (ifStatement.getElseStatement() !== undefined) {
        return undefined;
    }

    const next = ifStatement.getNextSiblingIfKind(SyntaxKind.ReturnStatement);

    return next !== undefined && next.getNextSibling() === undefined ? next : undefined;
};

/** The expression an exit `return`s, or the bare `return;` statement itself when it has none. */
const returnedValue = (statement: TsNode): TsNode => (Node.isReturnStatement(statement) ? (statement.getExpression() ?? statement) : statement);

/**
 * Every exit of `predicate` that is reached when its guarding condition is NOT
 * satisfied — the conventional deny position. `cond ? allow : deny` and `if (cond)
 * return allow; return deny;` are the same shape read two ways: a ternary's
 * `whenFalse`/`whenTrue` already says which arm that is without needing to
 * interpret `cond`, but an `if`'s consequent is unconditionally the TRUE arm, so
 * telling deny from allow there needs {@link conditionPolarity} — a `negative`
 * guard (`!ctx.auth.userId`) means the early return IS the deny arm; a `positive`
 * one (`ctx.auth.isAdmin`) means it's the opposite, the intentional "no further
 * restriction" arm, and the deny side (if there is one) is whatever follows.
 * `indeterminate` guards are skipped entirely rather than guessed at.
 */
const denyArmCandidates = (predicate: PredicateFunction): TsNode[] => {
    const candidates: TsNode[] = [];

    for (const conditional of ownConditionals(predicate)) {
        const polarity = conditionPolarity(conditional.getCondition());

        if (polarity === "positive") {
            candidates.push(conditional.getWhenFalse());
        } else if (polarity === "negative") {
            candidates.push(conditional.getWhenTrue());
        }
    }

    for (const ifStatement of ownIfStatements(predicate)) {
        const polarity = conditionPolarity(ifStatement.getExpression());

        if (polarity === "indeterminate") {
            continue;
        }

        const denyStatement =
            polarity === "negative"
                ? directReturn(ifStatement.getThenStatement())
                : (directReturn(ifStatement.getElseStatement()) ?? fallthroughReturn(ifStatement));

        if (denyStatement !== undefined) {
            candidates.push(returnedValue(denyStatement));
        }
    }

    return candidates;
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

        for (const candidate of denyArmCandidates(initializer)) {
            const form = unrestrictedForm(candidate);

            if (form !== undefined) {
                found.push({
                    exportName: enclosingExport(call),
                    file: relativePath,
                    form,
                    key: property.getName(),
                    line: candidate.getStartLineNumber(),
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
 *
 * Only the deny arm is inspected — see {@link denyArmCandidates} — so the mirror
 * pattern (`ctx.auth.isAdmin ? {} : {...}`, an intentional "no further restriction"
 * for the allow side) is left alone instead of flagged alongside the real bug.
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
