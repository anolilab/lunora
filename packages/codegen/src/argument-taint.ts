import type {
    ArrowFunction,
    BindingElement,
    CallExpression,
    FunctionDeclaration,
    FunctionExpression,
    Identifier,
    MethodDeclaration,
    Node as TsNode,
    ParameterDeclaration,
    VariableDeclaration,
} from "ts-morph";
import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { bindingKeyName, descendantsOfKind, isConstDeclaration, propertyKeyName, unwrapExpression } from "./discover/ast";
import { declarationOf, isReassignedBinding, referencedSymbolOf } from "./discover/attribution";
import { contextTrustPathOf, isHandlerArgsParameter, referencesContext } from "./discover/context-root";

/**
 * The parameter binding element that declares `name`, searched from the
 * innermost enclosing function outward so a shadowing parameter wins over an
 * outer one. Only PARAMETER patterns are searched: `({ args: { url } })` is the
 * house style every handler is written in, and a parameter cannot be
 * reassigned out from under the use the way a later `const` can, so this needs
 * none of {@link singleHopInitializer}'s scope-order care.
 */
const parameterBindingFor = (identifier: Identifier): BindingElement | undefined => {
    const name = identifier.getText();
    const declares = (candidate: BindingElement): boolean => {
        const nameNode = candidate.getNameNode();

        return Node.isIdentifier(nameNode) && nameNode.getText() === name;
    };

    for (const ancestor of identifier.getAncestors()) {
        if (!Node.isArrowFunction(ancestor) && !Node.isFunctionExpression(ancestor) && !Node.isFunctionDeclaration(ancestor)) {
            continue;
        }

        for (const parameter of ancestor.getParameters()) {
            const element = parameter.getDescendantsOfKind(SyntaxKind.BindingElement).find((candidate) => declares(candidate));

            if (element !== undefined) {
                return element;
            }
        }
    }

    return undefined;
};

/**
 * The property name the outermost element of `element`'s destructuring chain
 * reads off the parameter object — `({ args: { url: target } })`'s `target`
 * resolves to `"args"`, and so does the `...rest` of `({ args: { url,
 * ...rest } })`, because a rest element holds what is left of the same object.
 * `undefined` when the chain is not rooted directly in a parameter's pattern
 * (an array pattern, or a nested function's own binding).
 */
const destructuringRootName = (element: BindingElement): string | undefined => {
    let outermost = element;

    for (;;) {
        const pattern = outermost.getParent();

        if (!Node.isObjectBindingPattern(pattern)) {
            return undefined;
        }

        const owner = pattern.getParent();

        if (Node.isBindingElement(owner)) {
            outermost = owner;

            continue;
        }

        if (!Node.isParameterDeclaration(owner)) {
            return undefined;
        }

        // The renamed spelling reads `propertyName`; a shorthand (and a rest
        // element) reads its own name.
        return bindingKeyName(outermost);
    }
};

/** Whether `identifier` resolves, by symbol, to a positional handler's `args` parameter or to a binding destructured from it. */
const isPositionalArgsReference = (identifier: Identifier): boolean => {
    // Cheap pre-filter before any symbol lookup: some enclosing positional handler binds this spelling as its `args`.
    const name = identifier.getText();
    const isCandidate = identifier.getAncestors().some((ancestor) => {
        const parameter = Node.isFunctionLikeDeclaration(ancestor) || Node.isArrowFunction(ancestor) ? ancestor.getParameters()[1] : undefined;
        const nameNode = parameter?.getNameNode();

        return (
            parameter !== undefined &&
            (Node.isIdentifier(nameNode)
                ? nameNode.getText() === name
                : parameter.getDescendantsOfKind(SyntaxKind.BindingElement).some((element) => element.getName() === name)) &&
            isHandlerArgsParameter(parameter)
        );
    });

    if (!isCandidate) {
        return false;
    }

    const declaration = declarationOf(identifier);
    const parameter = Node.isParameterDeclaration(declaration) ? declaration : declaration?.getFirstAncestorByKind(SyntaxKind.Parameter);

    return parameter !== undefined && (Node.isParameterDeclaration(declaration) || Node.isBindingElement(declaration)) && isHandlerArgsParameter(parameter);
};

/**
 * True when `identifier` is a *value* reference to the binding named `name` —
 * the taint-root check shared by every Wave 3 feeder, whether the root is the
 * fixed `args`/`ctx` binding or an `httpAction` handler's freely-named request
 * parameter (`request` / `req` / `r`). Excludes the trailing `.<name>` of a
 * member access and the key of an explicit `{ <name>: … }` property, which name
 * a different `<name>` and carry no taint; a `{ <name> }` shorthand IS a value
 * reference and is kept.
 *
 * A handler that destructures its parameter — `({ args: { url }, ctx }) => …
 * url` — binds `url` to a field OF `args`, so `url` is a value reference to
 * `args` just as `args.url` is. Renaming (`{ args: { url: target } }`),
 * nesting, and rest elements all resolve through the same chain walk. Without
 * this the destructured spelling (the one every registry item, example and doc
 * snippet is written in) carried no taint at all, so three ERROR/WARN sink
 * lints could not fire on the code this repo itself ships.
 */
const isValueReference = (identifier: Identifier, name: string): boolean => {
    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    if (identifier.getText() === name) {
        return true;
    }

    const element = parameterBindingFor(identifier);

    if (element !== undefined && destructuringRootName(element) === name) {
        return true;
    }

    // A positional handler's `args` under any name: `handler: (c, a) => … a.userId`, `(c, { userId })`.
    return name === "args" && isPositionalArgsReference(identifier);
};

/** True when `node` is, or textually contains, a value reference to the binding named `name`. */
const referencesBinding = (node: TsNode, name: string): boolean => {
    if (Node.isIdentifier(node)) {
        return isValueReference(node, name);
    }

    return node.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => isValueReference(identifier, name));
};

/**
 * The leftmost identifier of a member/element-access (and non-null) chain
 * (`body.tag.id` → `body`), or `undefined` when the chain doesn't root at a bare
 * identifier. Lets the request taint follow one hop through the *object* of a
 * member access (`const body = await request.json(); … body.tag`), which the
 * bare-identifier {@link singleHopInitializer} hop alone cannot reach.
 */
const memberAccessRootIdentifier = (node: TsNode): Identifier | undefined => {
    let current: TsNode = node;

    while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current) || Node.isNonNullExpression(current)) {
        current = current.getExpression();
    }

    return Node.isIdentifier(current) ? current : undefined;
};

/**
 * The initializer of the variable `node` names, resolved by symbol, when that
 * binding cannot have been repointed since (a `const`, or a `let` never
 * reassigned) — the hop a SUPPRESSOR may follow. `singleHopInitializer` is the
 * looser, spelling-based hop the taint side uses.
 */
const trustedInitializerOf = (node: TsNode): TsNode | undefined => {
    const declaration = Node.isIdentifier(node) ? declarationOf(node) : undefined;

    return Node.isVariableDeclaration(declaration) && Node.isIdentifier(declaration.getNameNode()) && !isReassignedBinding(declaration)
        ? declaration.getInitializer()
        : undefined;
};

/**
 * The node a declaration's binding is visible in: the enclosing function for a
 * `var`, else the block, `for` statement or file that holds the `let`/`const`.
 */
const bindingScope = (variable: VariableDeclaration, enclosingFunction: TsNode): TsNode | undefined => {
    const list = variable.getParent();

    if (Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Var) {
        return enclosingFunction;
    }

    const holder = list.getParent();

    return Node.isVariableStatement(holder) ? holder.getParent() : holder;
};

/** Whether `variable` binds `name` directly, or as an identifier anywhere inside a destructuring pattern. */
const declaresName = (variable: VariableDeclaration, name: string): boolean => {
    const nameNode = variable.getNameNode();

    if (Node.isIdentifier(nameNode)) {
        return nameNode.getText() === name;
    }

    return nameNode.getDescendantsOfKind(SyntaxKind.BindingElement).some((element) => {
        const elementName = element.getNameNode();

        return Node.isIdentifier(elementName) && elementName.getText() === name;
    });
};

/**
 * The identifiers in `node` that read a value: the trailing `.name` of a member
 * access and the key of an explicit `{ name: … }` property name a different
 * binding, so they are skipped.
 */
const valueIdentifiersIn = (node: TsNode): Identifier[] =>
    node.getDescendantsOfKind(SyntaxKind.Identifier).filter((identifier) => {
        const parent = identifier.getParent();

        return (
            !(Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) &&
            !(Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier)
        );
    });

/** The identifiers `node` reads a value through; `node` itself when it is a bare identifier. */
const valueIdentifiersOf = (node: TsNode): Identifier[] => (Node.isIdentifier(node) ? [node] : valueIdentifiersIn(node));

/** The outermost member/element-access (and non-null) chain that `node` heads, `node` itself when nothing extends it. */
const outermostChainOf = (node: TsNode): TsNode => {
    let outermost: TsNode = node;

    for (;;) {
        const parent = outermost.getParent();

        if (
            !(
                (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent) || Node.isNonNullExpression(parent)) &&
                parent.getExpression() === outermost
            )
        ) {
            return outermost;
        }

        outermost = parent;
    }
};

/** The `CallExpression` that invokes `chain` (`chain(…)`), or `undefined` when `chain` is only read. */
const invokedBy = (chain: TsNode): CallExpression | undefined => {
    const parent = chain.getParent();

    return Node.isCallExpression(parent) && parent.getExpression() === chain ? parent : undefined;
};

/** The `ctx.db` methods that read rows; a write returns whatever it wrote, so its arguments do not bind the row to anyone. */
const DB_READ_METHODS: ReadonlySet<string> = new Set(["find", "findFirst", "findFirstOrThrow", "findMany", "findUnique", "first", "get", "unique"]);

/** Whether `call` invokes a `ctx.db` row read (`ctx.db.files.findFirst(…)`, `ctx.db.get(…)`), not a write. */
const isDatabaseReadCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    return Node.isPropertyAccessExpression(callee) && DB_READ_METHODS.has(callee.getName()) && contextTrustPathOf(callee)?.[0] === "db";
};

/**
 * Whether `identifier` reaches the value of `within` only on some paths: the fallback of a `??` or
 * `||`, the left of a `&&`, or any part of a conditional. `args.key ?? ctx.auth.userId` is the
 * caller's key whenever one is sent, so the identity there scopes nothing; the identity on the
 * left of `ctx.auth.userId ?? "anon"` is used whenever it exists.
 */
const isAlternativeOf = (identifier: TsNode, within: TsNode): boolean => {
    for (let child = identifier, parent = identifier.getParent(); parent !== undefined && child !== within; child = parent, parent = parent.getParent()) {
        if (Node.isConditionalExpression(parent)) {
            return true;
        }

        if (Node.isBinaryExpression(parent)) {
            const operator = parent.getOperatorToken().getKind();

            if (
                (child === parent.getRight() && (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken)) ||
                (child === parent.getLeft() && operator === SyntaxKind.AmpersandAmpersandToken)
            ) {
                return true;
            }
        }
    }

    return false;
};

/**
 * Whether `argument` names the caller's identity, directly or through a local whose initializer does,
 * on every path: `ownerId: args.ownerId ?? ctx.auth.userId` selects the caller's row only when nothing is sent.
 */
const readsCallerIdentity = (argument: TsNode): boolean =>
    valueIdentifiersOf(argument).some((identifier) => {
        if (isAlternativeOf(identifier, argument)) {
            return false;
        }

        if (contextTrustPathOf(outermostChainOf(identifier))?.[0] === "auth") {
            return true;
        }

        const initializer = trustedInitializerOf(identifier);

        return (
            initializer !== undefined &&
            valueIdentifiersOf(initializer).some((inner) => contextTrustPathOf(outermostChainOf(inner))?.[0] === "auth" && !isAlternativeOf(inner, initializer))
        );
    });

/**
 * Whether a database read is bound to the caller: one of its arguments names the
 * caller's identity, directly or through a local whose initializer does
 * (`ctx.db.files.findFirst({ where: { ownerId: uid } })` with `uid = ctx.auth.userId`).
 * A read keyed by a caller-supplied id (`ctx.db.get("files", args.id)`) is not: the
 * row it returns is whichever one the caller pointed at, so a key read off it is
 * caller-chosen.
 */
const isIdentityBoundRead = (call: CallExpression): boolean =>
    isDatabaseReadCall(call) && call.getArguments().some((argument) => readsCallerIdentity(argument));

/** Whether a `ctx.db` call lies between `identifier` and `within`, counting `within` itself and nothing above it. */
const insideDatabaseCallWithin = (identifier: TsNode, within: TsNode): boolean => {
    for (let ancestor = identifier.getParent(); ancestor !== undefined; ancestor = ancestor.getParent()) {
        if (Node.isCallExpression(ancestor) && contextTrustPathOf(ancestor.getExpression())?.[0] === "db") {
            return true;
        }

        if (ancestor === within) {
            return false;
        }
    }

    return false;
};

/** Fields that name the row itself, so they differ for every caller that owns one. */
const ROW_ID_FIELDS: ReadonlySet<string> = new Set(["_id", "id"]);

/**
 * The field read off a row `source` yields, through any `await`, parentheses, `!` or type assertion
 * (`(await ctx.db.files.findFirst(…)).key`, `row.key`), and the expression that reads it.
 * `field` is `undefined` when the row itself is used.
 */
const rowFieldReadOf = (source: TsNode): { field: string | undefined; read: TsNode } => {
    let current = source;

    for (let parent = current.getParent(); ; parent = current.getParent()) {
        if (
            Node.isAwaitExpression(parent) ||
            Node.isParenthesizedExpression(parent) ||
            Node.isNonNullExpression(parent) ||
            Node.isAsExpression(parent) ||
            Node.isSatisfiesExpression(parent) ||
            Node.isTypeAssertion(parent)
        ) {
            current = parent;
            continue;
        }

        if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === current) {
            return { field: parent.getName(), read: parent };
        }

        if (Node.isElementAccessExpression(parent) && parent.getExpression() === current) {
            const argument = parent.getArgumentExpression();

            return { field: Node.isStringLiteral(argument) ? argument.getLiteralValue() : undefined, read: parent };
        }

        return { field: undefined, read: current };
    }
};

/**
 * Whether `field` of a row returned by the identity-bound `read` differs per caller: the row's
 * id, or a column the read matched against the caller (`ownerId` in `where: { ownerId:
 * ctx.auth.userId }`). Any other column (`me.plan`, `me.locale`) can hold the same value for
 * every caller, so it scopes a key no more than `ctx.env.PREFIX` does.
 */
const isIdentityField = (read: CallExpression, field: string | undefined): boolean => {
    if (field === undefined) {
        return false;
    }

    if (ROW_ID_FIELDS.has(field)) {
        return true;
    }

    return read.getArguments().some((argument) =>
        [...argument.getDescendantsOfKind(SyntaxKind.PropertyAssignment), ...argument.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)].some(
            (property) => {
                const value = Node.isPropertyAssignment(property) ? property.getInitializer() : property.getNameNode();

                return propertyKeyName(property) === field && value !== undefined && readsCallerIdentity(value);
            },
        ),
    );
};

/** Whether `read`'s row, consumed through `source`, scopes a key whose whole value is `wholeKey`. */
const rowScopesKey = (read: CallExpression, source: TsNode, field: string | undefined, wholeKey: TsNode | undefined): boolean => {
    if (!isIdentityBoundRead(read)) {
        return false;
    }

    // Used as the entire key, a field of the caller's own row is a stored reference the caller cannot repoint.
    const whole = wholeKey !== undefined && unwrapExpression(source) === unwrapExpression(wholeKey);

    return whole || isIdentityField(read, field);
};

/**
 * True when `node` is, or textually contains, a value reference to a key source the
 * caller cannot choose: the caller's identity (a ctx path whose first segment is
 * `auth`, `ctx.auth.userId`), or a value read from the database through a read that
 * is itself bound to that identity (see {@link isIdentityBoundRead}). A row fetched
 * by a caller-supplied id is not such a source, and a field of a caller's row scopes
 * only when it is `wholeKey` or names the caller (see {@link isIdentityField}).
 * Narrower than {@link referencesContext}: `ctx.env.PREFIX` and `ctx.now` are
 * server-trusted but name neither a caller nor a stored record.
 */
const referencesScopedKeySource = (node: TsNode, wholeKey?: TsNode): boolean =>
    valueIdentifiersOf(node).some((identifier) => {
        const outermost = outermostChainOf(identifier);
        const root = contextTrustPathOf(outermost)?.[0];

        // Inside a `ctx.db` call's arguments the identity only scopes the key through that call, judged below. Only
        // calls within the key count: a sink nested in a db write's arguments (`ctx.db.patch(id, { v: await
        // ctx.kv.get(\`${ctx.auth.userId}:…\`) })`) is still scoped by its own identity prefix.
        if (root === "auth") {
            return !isAlternativeOf(identifier, node) && !insideDatabaseCallWithin(identifier, node);
        }

        // A fallback read (`args.key ?? (await ownedRead()).key`) is only taken when the caller sends nothing.
        const call = root === "db" && !isAlternativeOf(identifier, node) ? invokedBy(outermost) : undefined;

        if (call === undefined) {
            return false;
        }

        const { field, read } = rowFieldReadOf(call);

        return rowScopesKey(call, read, field, wholeKey);
    });

/** A function whose body can hold an identity guard: the handler itself, or a helper it calls. */
type FunctionNode = ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

const isFunctionNode = (node: TsNode | undefined): node is FunctionNode =>
    Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node);

/** The innermost function containing `node`, or `undefined` at module level. */
const enclosingFunctionOf = (node: TsNode): FunctionNode | undefined => {
    const ancestor = node.getFirstAncestor((candidate) => isFunctionNode(candidate));

    return isFunctionNode(ancestor) ? ancestor : undefined;
};

/** The `await` operand of `node` (both unwrapped), or `node` itself when it is not awaited. */
const awaitedOperand = (node: TsNode | undefined): TsNode | undefined => {
    const unwrapped = unwrapExpression(node);

    return Node.isAwaitExpression(unwrapped) ? unwrapExpression(unwrapped.getExpression()) : unwrapped;
};

/** The root identifier and the names read off a property/element access chain (`ctx.db.files` → `ctx`, `["db", "files"]`). */
interface AccessPath {
    path: ReadonlyArray<string>;
    root: Identifier;
}

/** `undefined` for any shape that is not a pure access chain on an identifier, so a call or an `await` in the chain fails closed. */
const accessPathOf = (node: TsNode | undefined): AccessPath | undefined => {
    const names: string[] = [];
    let current: TsNode | undefined = unwrapExpression(node);

    while (current !== undefined) {
        if (Node.isPropertyAccessExpression(current)) {
            names.unshift(current.getName());
            current = unwrapExpression(current.getExpression());
        } else if (Node.isElementAccessExpression(current)) {
            const argument = current.getArgumentExpression();

            if (!Node.isStringLiteral(argument)) {
                return undefined;
            }

            names.unshift(argument.getLiteralValue());
            current = unwrapExpression(current.getExpression());
        } else if (Node.isIdentifier(current)) {
            return { path: names, root: current };
        } else {
            return undefined;
        }
    }

    return undefined;
};

/** Whether `identifier` resolves, by symbol, to `declaration`; a spelling match would pass a shadowing binding. */
const bindsTo = (identifier: Identifier, declaration: TsNode): boolean => declarationOf(identifier)?.compilerNode === declaration.compilerNode;

/**
 * The application function a bare-identifier callee names: a function declaration, or a `const`
 * bound to an arrow or function expression, followed through one import alias. Anything declared
 * in a `.d.ts` file or under `node_modules` is not app code and resolves to `undefined`.
 */
const appFunctionOf = (callee: TsNode | undefined): FunctionNode | undefined => {
    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    const symbol = referencedSymbolOf(callee);
    const target = symbol?.isAlias() === true ? symbol.getAliasedSymbol() : symbol;
    const declaration = target?.getValueDeclaration() ?? target?.getDeclarations()[0];

    if (declaration === undefined) {
        return undefined;
    }

    const sourceFile = declaration.getSourceFile();

    if (sourceFile.isDeclarationFile() || sourceFile.isInNodeModules()) {
        return undefined;
    }

    // A reassigned function declaration may not run the body inspected here, and calling a generator
    // runs none of its body: awaiting the generator object it returns checks nothing.
    if (Node.isFunctionDeclaration(declaration)) {
        return declaration.getBody() === undefined || declaration.isGenerator() || isReassignedBinding(declaration) ? undefined : declaration;
    }

    if (!isConstDeclaration(declaration)) {
        return undefined;
    }

    const initializer = unwrapExpression(declaration.getInitializer());

    return Node.isArrowFunction(initializer) || (Node.isFunctionExpression(initializer) && !initializer.isGenerator()) ? initializer : undefined;
};

const isAssignmentOperator = (kind: SyntaxKind): boolean => kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;

/** A chain of calls and property reads, as a `db` read is written: every call in it, the names read along it, and its root. */
interface DatabaseChain {
    calls: CallExpression[];
    names: ReadonlyArray<string>;
    root: Identifier;
}

/** The chain a read is written as (`ctx.db.query("m").withIndex(…).first()`), or `undefined` for any other shape. */
const databaseChainOf = (node: TsNode | undefined): DatabaseChain | undefined => {
    const calls: CallExpression[] = [];
    const names: string[] = [];
    let current: TsNode | undefined = unwrapExpression(node);

    while (current !== undefined) {
        if (Node.isCallExpression(current)) {
            calls.push(current);
            current = unwrapExpression(current.getExpression());
        } else if (Node.isPropertyAccessExpression(current)) {
            names.unshift(current.getName());
            current = unwrapExpression(current.getExpression());
        } else if (Node.isElementAccessExpression(current)) {
            const argument = current.getArgumentExpression();

            if (!Node.isStringLiteral(argument)) {
                return undefined;
            }

            names.unshift(argument.getLiteralValue());
            current = unwrapExpression(current.getExpression());
        } else if (Node.isIdentifier(current)) {
            return calls.length > 0 && names.length > 0 ? { calls, names, root: current } : undefined;
        } else {
            return undefined;
        }
    }

    return undefined;
};

/** The read methods that return one row, or none. */
const SINGLE_ROW_READS: ReadonlySet<string> = new Set(["findFirst", "findUnique", "first", "get", "unique"]);

/**
 * The single-row read a chain ends in. `selfEnforcing` is true for a `…OrThrow` variant, which throws on a
 * miss by itself. `undefined` for any other terminal (`findMany`, `collect`, …).
 */
const singleRowReadOf = (chain: DatabaseChain): { selfEnforcing: boolean } | undefined => {
    const method = chain.names[chain.names.length - 1] ?? "";

    if (SINGLE_ROW_READS.has(method)) {
        return { selfEnforcing: false };
    }

    const base = method.endsWith("OrThrow") ? method.slice(0, -"OrThrow".length) : undefined;

    return base !== undefined && SINGLE_ROW_READS.has(base) ? { selfEnforcing: true } : undefined;
};

/**
 * The row a sink key is read off: `K` (or the initializer of `K` when it is a bare identifier) is an
 * access chain with at least one level, rooted at a single-identifier `const` whose initializer is a
 * `ctx.db` read. `undefined` otherwise, which leaves the sink reported.
 */
const rowDeclarationOf = (key: TsNode): VariableDeclaration | undefined => {
    const unwrapped = unwrapExpression(key);
    const chain = Node.isIdentifier(unwrapped) ? (unwrapExpression(trustedInitializerOf(unwrapped)) ?? unwrapped) : unwrapped;
    const access = accessPathOf(chain);

    if (access === undefined || access.path.length === 0) {
        return undefined;
    }

    const declaration = declarationOf(access.root);

    if (!isConstDeclaration(declaration) || !Node.isIdentifier(declaration.getNameNode())) {
        return undefined;
    }

    // Only a single-row read: an insert or update returns the row as the caller wrote it.
    const read = awaitedOperand(declaration.getInitializer());
    const readChain = Node.isCallExpression(read) && contextTrustPathOf(read.getExpression())?.[0] === "db" ? databaseChainOf(read) : undefined;

    return readChain !== undefined && singleRowReadOf(readChain) !== undefined ? declaration : undefined;
};

/** Every argument of the chain, and every node inside each argument (a callback's body included). */
const chainArgumentNodes = (chain: DatabaseChain): TsNode[] =>
    chain.calls.flatMap((call) => call.getArguments().flatMap((argument) => [argument, ...argument.getDescendants()]));

/**
 * Whether `node` names a binding made by a direct element of `const { … } = P.auth…`: no nesting, rest or
 * default, so `{ userId }` and `{ userId: uid }` count while `{ auth: { userId } } = ctx` does not.
 */
const isDirectDestructuredIdentityOf = (node: TsNode, parameter: ParameterDeclaration): boolean => {
    const element = Node.isIdentifier(node) ? declarationOf(node) : undefined;

    if (!Node.isBindingElement(element) || element.getDotDotDotToken() !== undefined || element.getInitializer() !== undefined) {
        return false;
    }

    const pattern = element.getParent();
    const declaration = Node.isObjectBindingPattern(pattern) ? pattern.getParent() : undefined;

    if (!isConstDeclaration(declaration)) {
        return false;
    }

    const source = accessPathOf(declaration.getInitializer());

    return source?.path[0] === "auth" && bindsTo(source.root, parameter);
};

/**
 * Whether `node` reads the caller's identity through the ctx parameter `parameter`: a `P.auth…` chain, an
 * identifier whose one-hop `const` initializer is one (`const userId = ctx.auth.userId`), or a name a
 * direct `const { userId } = ctx.auth` destructuring binds (the form `prefer-destructuring` enforces).
 */
const isIdentityReadOf = (node: TsNode, parameter: ParameterDeclaration): boolean => {
    const access = accessPathOf(node);

    if (access !== undefined && access.path.length > 0) {
        return access.path[0] === "auth" && bindsTo(access.root, parameter);
    }

    const initializerAccess = accessPathOf(trustedInitializerOf(node));

    if (initializerAccess?.path[0] === "auth" && bindsTo(initializerAccess.root, parameter)) {
        return true;
    }

    return isDirectDestructuredIdentityOf(node, parameter);
};

/** The declaration a variable statement makes, when it is a single `const` binding one identifier. */
const constDeclarationOf = (statement: TsNode): VariableDeclaration | undefined => {
    if (!Node.isVariableStatement(statement)) {
        return undefined;
    }

    const declarations = statement.getDeclarations();
    const declaration = declarations.length === 1 ? declarations[0] : undefined;

    return declaration !== undefined && isConstDeclaration(declaration) && Node.isIdentifier(declaration.getNameNode()) ? declaration : undefined;
};

/** Whether `condition` is `!g` or `g == null`, in either operand order, for the binding `g`. */
const isMissingCheck = (condition: TsNode | undefined, declaration: VariableDeclaration): boolean => {
    const expression = unwrapExpression(condition);
    const isBinding = (node: TsNode | undefined): boolean => Node.isIdentifier(node) && bindsTo(node, declaration);

    if (Node.isPrefixUnaryExpression(expression)) {
        return expression.getOperatorToken() === SyntaxKind.ExclamationToken && isBinding(unwrapExpression(expression.getOperand()));
    }

    if (!Node.isBinaryExpression(expression) || expression.getOperatorToken().getKind() !== SyntaxKind.EqualsEqualsToken) {
        return false;
    }

    const left = unwrapExpression(expression.getLeft());
    const right = unwrapExpression(expression.getRight());

    return (isBinding(left) && Node.isNullLiteral(right)) || (isBinding(right) && Node.isNullLiteral(left));
};

/** Whether a branch's last statement (the branch itself, or its block's last statement) leaves the handler: a `throw`, or a `return` unless `throwOnly`. */
const exitsBranch = (branch: TsNode | undefined, throwOnly: boolean): boolean => {
    const statements = Node.isBlock(branch) ? branch.getStatements() : undefined;
    const last = statements === undefined ? branch : statements[statements.length - 1];

    return Node.isThrowStatement(last) || (!throwOnly && Node.isReturnStatement(last));
};

/** Whether `statement` is an `if` with no `else` that exits when the binding `g` is missing. */
const isNullCheckExit = (statement: TsNode | undefined, declaration: VariableDeclaration, throwOnly: boolean): boolean =>
    Node.isIfStatement(statement) &&
    statement.getElseStatement() === undefined &&
    isMissingCheck(statement.getExpression(), declaration) &&
    exitsBranch(statement.getThenStatement(), throwOnly);

/**
 * Whether `helper`'s own body enforces the identity check of {@link isHelperGuardCall}: a top-level
 * `const r = await P.db…` single-row read whose chain reads the caller's identity through `parameter` and
 * references a parameter that received the row. It is enforced by a later `if (!r)` / `if (r == null)` in
 * the same block whose branch throws, or by the read itself when it is a `…OrThrow` variant.
 */
const helperEnforcesRead = (helper: FunctionNode, parameter: ParameterDeclaration, tiedParameters: ReadonlyArray<ParameterDeclaration>): boolean => {
    const body = helper.getBody();

    if (!Node.isBlock(body)) {
        return false;
    }

    const statements = body.getStatements();

    return statements.some((statement, index) => {
        const declaration = constDeclarationOf(statement);
        const initializer = unwrapExpression(declaration?.getInitializer());
        const chain = Node.isAwaitExpression(initializer) ? databaseChainOf(initializer.getExpression()) : undefined;
        const single = chain === undefined ? undefined : singleRowReadOf(chain);

        if (declaration === undefined || chain === undefined || single === undefined || chain.names[0] !== "db" || !bindsTo(chain.root, parameter)) {
            return false;
        }

        const nodes = chainArgumentNodes(chain);
        const readsIdentity = nodes.some((node) => isIdentityReadOf(node, parameter));
        const readsRow = tiedParameters.some((tied) => nodes.some((node) => Node.isIdentifier(node) && bindsTo(node, tied)));

        if (!readsIdentity || !readsRow) {
            return false;
        }

        const enforcing = single.selfEnforcing ? statement : statements.slice(index + 1).find((later) => isNullCheckExit(later, declaration, true));

        // A `return` before the check is enforced lets a call complete without it.
        return (
            enforcing !== undefined &&
            !helper
                .getDescendantsOfKind(SyntaxKind.ReturnStatement)
                .some((exit) => enclosingFunctionOf(exit)?.compilerNode === helper.compilerNode && exit.getStart() < enforcing.getEnd())
        );
    });
};

/**
 * Whether a helper call is an identity guard for the row: the handler's ctx is its only ctx-valued argument,
 * another argument references the row, and the helper's body enforces the identity read of
 * {@link helperEnforcesRead}. A helper that may return a Promise must be awaited.
 */
const isHelperGuardCall = (call: CallExpression, row: VariableDeclaration, awaited: boolean): boolean => {
    const helper = appFunctionOf(call.getExpression());
    const args = call.getArguments();

    if (helper === undefined || args.some((argument) => Node.isSpreadElement(argument))) {
        return false;
    }

    const contextIndexes = args.flatMap((argument, index) => (contextTrustPathOf(argument)?.length === 0 ? [index] : []));
    const contextIndex = contextIndexes.length === 1 ? contextIndexes[0] : undefined;
    const parameter = contextIndex === undefined ? undefined : helper.getParameters()[contextIndex];

    if (contextIndex === undefined || parameter === undefined || parameter.isRestParameter() || !Node.isIdentifier(parameter.getNameNode())) {
        return false;
    }

    const tiedParameters: ParameterDeclaration[] = [];

    args.forEach((argument, index) => {
        // The argument must be the row or a field read off it; `args.id || row.id` may pass the caller's value.
        const access = accessPathOf(unwrapExpression(argument));
        const tied = index === contextIndex || access === undefined || !bindsTo(access.root, row) ? undefined : helper.getParameters()[index];

        if (tied !== undefined && Node.isIdentifier(tied.getNameNode())) {
            tiedParameters.push(tied);
        }
    });

    const returnType = helper.getReturnType();
    const mayBePromise = helper.isAsync() || returnType.isAny() || returnType.isUnknown() || returnType.getText().includes("Promise");

    if (tiedParameters.length === 0 || (!awaited && mayBePromise)) {
        return false;
    }

    return helperEnforcesRead(helper, parameter, tiedParameters);
};

/**
 * The `const g = await ctx.db…(…)` an inline guard reads: a single-row read rooted at the handler's ctx,
 * identity-bound in one of its calls (see {@link isIdentityBoundRead}), with an argument referencing the row.
 * `selfEnforcing` is true for a `…OrThrow` read, which needs no following `if`.
 */
const inlineGuardOf = (statement: TsNode, row: VariableDeclaration): { declaration: VariableDeclaration; selfEnforcing: boolean } | undefined => {
    const declaration = constDeclarationOf(statement);
    const initializer = unwrapExpression(declaration?.getInitializer());
    const chain = Node.isAwaitExpression(initializer) ? databaseChainOf(initializer.getExpression()) : undefined;
    const single = chain === undefined ? undefined : singleRowReadOf(chain);

    if (declaration === undefined || chain === undefined || single === undefined || chain.names[0] !== "db" || contextTrustPathOf(chain.root)?.length !== 0) {
        return undefined;
    }

    // The chain is already a `ctx.db` single-row read, so any of its calls may carry the identity: a fluent
    // `query(…).withIndex(…).first()` names it in `withIndex`, which `isIdentityBoundRead` cannot trace to `ctx.db`.
    const identityBound = chain.calls.some((call) => call.getArguments().some((argument) => readsCallerIdentity(argument)));
    const tied = chainArgumentNodes(chain).some((node) => Node.isIdentifier(node) && bindsTo(node, row));

    return identityBound && tied ? { declaration, selfEnforcing: single.selfEnforcing } : undefined;
};

/**
 * Whether `statement` runs before the sink on every path through the handler: no function, `if`,
 * loop, `switch` case or `catch` between it and `enclosing`. A `try` with a `catch` is allowed only when
 * both the statement and the sink lie in its `try` block.
 */
const runsBeforeSinkUnconditionally = (statement: TsNode, enclosing: FunctionNode, sinkCall: TsNode): boolean => {
    const within = (node: TsNode, container: TsNode): boolean => container.getStart() <= node.getStart() && node.getEnd() <= container.getEnd();

    for (let ancestor = statement.getParent(); ancestor !== undefined && ancestor.compilerNode !== enclosing.compilerNode; ancestor = ancestor.getParent()) {
        if (
            isFunctionNode(ancestor) ||
            Node.isIfStatement(ancestor) ||
            Node.isIterationStatement(ancestor) ||
            Node.isCaseClause(ancestor) ||
            Node.isDefaultClause(ancestor) ||
            Node.isCatchClause(ancestor)
        ) {
            return false;
        }

        if (Node.isTryStatement(ancestor) && ancestor.getCatchClause() !== undefined) {
            const tryBlock = ancestor.getTryBlock();

            if (!within(statement, tryBlock) || !within(sinkCall, tryBlock)) {
                return false;
            }
        }
    }

    return true;
};

/**
 * Whether one of the statements before the sink's own statement (`statements[index]`) is an identity
 * guard for `row`: a helper-guard call, or an inline single-row read followed directly by its enforcing
 * `if` (or a `…OrThrow` read, which enforces on its own).
 */
const hasPrecedingGuard = (statements: ReadonlyArray<TsNode>, index: number, row: VariableDeclaration, enclosing: FunctionNode, sinkCall: TsNode): boolean =>
    statements.slice(0, index).some((statement, position) => {
        if (!runsBeforeSinkUnconditionally(statement, enclosing, sinkCall)) {
            return false;
        }

        if (Node.isExpressionStatement(statement)) {
            const expression = unwrapExpression(statement.getExpression());
            const isAwaited = Node.isAwaitExpression(expression);
            const call = isAwaited ? unwrapExpression(expression.getExpression()) : expression;

            if (Node.isCallExpression(call) && isHelperGuardCall(call, row, isAwaited)) {
                return true;
            }
        }

        const inline = inlineGuardOf(statement, row);

        return inline !== undefined && (inline.selfEnforcing || (position + 1 < index && isNullCheckExit(statements[position + 1], inline.declaration, false)));
    });

/** `node` with any `await`, parentheses and type assertions removed. */
const unawaited = (node: TsNode): TsNode => {
    let current = unwrapExpression(node) ?? node;

    while (Node.isAwaitExpression(current)) {
        current = unwrapExpression(current.getExpression()) ?? current.getExpression();
    }

    return current;
};

/** A call or `new` under any `await`, parentheses or type assertion: `await sha256Hex(args.bytes)` recomputes its input. */
const isRecomputed = (node: TsNode): boolean => {
    const current = unawaited(node);

    return Node.isCallExpression(current) || Node.isNewExpression(current);
};

/** Whether `node` is any `ctx.db` call under any `await`. */
const isDatabaseCallSource = (node: TsNode): boolean => {
    const current = unawaited(node);

    return Node.isCallExpression(current) && contextTrustPathOf(current.getExpression())?.[0] === "db";
};

/** Whether `node` is a `ctx.db` row read under any `await`. */
const isDatabaseReadSource = (node: TsNode): boolean => {
    const current = unawaited(node);

    return Node.isCallExpression(current) && isDatabaseReadCall(current);
};

/** Whether `node` reads `args` itself or through one local (`const requestedKey = args.key`). */
const reachesArgsWithinOneHop = (node: TsNode): boolean =>
    referencesBinding(node, "args") ||
    valueIdentifiersOf(node).some((identifier) => {
        const initializer = trustedInitializerOf(identifier);

        return initializer !== undefined && referencesBinding(initializer, "args");
    });

/**
 * The defaults on the path to the destructured element of `variable` that binds `name`: its own
 * (`const { url = args.url } = config`) and every enclosing element's
 * (`const { network: { url } = args.network } = config`), each of which can supply the value.
 */
const bindingDefaultsOf = (variable: VariableDeclaration | undefined, name: string): TsNode[] => {
    const element = variable
        ?.getNameNode()
        .getDescendantsOfKind(SyntaxKind.BindingElement)
        .find((candidate) => Node.isIdentifier(candidate.getNameNode()) && candidate.getNameNode().getText() === name);

    if (element === undefined) {
        return [];
    }

    return [element, ...element.getAncestors().filter((ancestor) => Node.isBindingElement(ancestor))]
        .map((node) => (Node.isBindingElement(node) ? node.getInitializer() : undefined))
        .filter((initializer) => initializer !== undefined);
};

/**
 * For a name destructured from a `ctx.db` read (`const { key } = await ctx.db.files.findFirst(…)`),
 * that read; `undefined` for any other binding. Only a read qualifies: every field of a row the read
 * bound to the caller is the caller's own, while a literal's sibling `ctx.auth` field says nothing
 * about the field taken from it.
 */
const ownedRowInitializerOf = (node: TsNode): TsNode | undefined => {
    const element = Node.isIdentifier(node) ? declarationOf(node) : undefined;

    if (!Node.isBindingElement(element) || isReassignedBinding(element)) {
        return undefined;
    }

    const variable = element.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const initializer = variable?.getInitializer();

    // `const { storageKey = args.key } = await ownedRead()` takes the caller's key whenever the row lacks the field.
    if (bindingDefaultsOf(variable, node.getText()).some((fallback) => reachesArgsWithinOneHop(fallback))) {
        return undefined;
    }

    return initializer !== undefined && isDatabaseReadSource(initializer) ? initializer : undefined;
};

/** The `ctx.db` row read under any `await` in `node`, or `undefined`. */
const databaseReadOf = (node: TsNode): CallExpression | undefined => {
    const current = unawaited(node);

    return Node.isCallExpression(current) && isDatabaseReadCall(current) ? current : undefined;
};

/** The column a destructured `element` takes from the row; `undefined` below the top level of the pattern. */
const destructuredFieldOf = (element: TsNode | undefined): string | undefined => {
    if (!Node.isBindingElement(element) || Node.isBindingElement(element.getParent().getParent())) {
        return undefined;
    }

    return bindingKeyName(element);
};

/**
 * Whether the local `identifier` names a key source the caller cannot choose, one hop back. A
 * local holding a whole row (`const row = await ctx.db.files.findFirst(…)`) is judged by the
 * field read off it here; a destructured one (`const { key } = await …`) by the field it took.
 */
const bindingScopesKey = (identifier: TsNode, wholeKey: TsNode | undefined): boolean => {
    const isWhole = wholeKey !== undefined && unwrapExpression(identifier) === unwrapExpression(wholeKey);
    const trusted = trustedInitializerOf(identifier);

    if (trusted !== undefined) {
        const read = databaseReadOf(trusted);

        if (read === undefined) {
            return referencesScopedKeySource(trusted, isWhole ? trusted : undefined);
        }

        const { field, read: use } = rowFieldReadOf(identifier);

        return rowScopesKey(read, use, field, wholeKey);
    }

    const owned = ownedRowInitializerOf(identifier);
    const read = owned === undefined ? undefined : databaseReadOf(owned);

    return read !== undefined && Node.isIdentifier(identifier) && rowScopesKey(read, identifier, destructuredFieldOf(declarationOf(identifier)), wholeKey);
};

/** Whether `part`, one piece of a larger key, is scoped by a key source the caller cannot choose, directly or through one local. */
const scopesKeyPart = (part: TsNode): boolean =>
    referencesScopedKeySource(part) ||
    valueIdentifiersOf(part).some(
        (identifier) => !isAlternativeOf(identifier, part) && !insideDatabaseCallWithin(identifier, part) && bindingScopesKey(identifier, undefined),
    );

/** `node` with any `!` it is wrapped in, so `uid!` reads the same value as `uid`. */
const withNonNull = (node: TsNode): TsNode => {
    let current = node;

    for (let parent = current.getParent(); Node.isNonNullExpression(parent); parent = current.getParent()) {
        current = parent;
    }

    return current;
};

/** Whether `node` is an argument of a call at or below `within`, so the call decides what it contributes. */
const insideCallWithin = (node: TsNode, within: TsNode): boolean => {
    if (node === within) {
        return false;
    }

    for (let ancestor = node.getParent(); ancestor !== undefined; ancestor = ancestor.getParent()) {
        if (Node.isCallExpression(ancestor) || Node.isNewExpression(ancestor)) {
            return true;
        }

        if (ancestor === within) {
            return false;
        }
    }

    return false;
};

/**
 * Whether the identity `identifier` reaches `part` intact: read as itself (`ctx.auth.userId`, a local bound to
 * it), or as one identity column of an owned row (`row._id`), with no further access or call on top. A lossy
 * projection such as `.length`, `[0]` or `.slice(0, 0)` can yield the same text for every caller.
 */
const isIntactIdentity = (identifier: Identifier, part: TsNode): boolean => {
    const outermost = outermostChainOf(identifier);
    const root = contextTrustPathOf(outermost)?.[0];

    if (root === "auth") {
        return contextTrustPathOf(outermost)?.length === 2 && invokedBy(outermost) === undefined && !insideCallWithin(outermost, part);
    }

    if (root === "db") {
        const call = invokedBy(outermost);
        const { field, read } = call === undefined ? { field: undefined, read: outermost } : rowFieldReadOf(call);

        return field !== undefined && outermostChainOf(read) === read && invokedBy(read) === undefined && !insideCallWithin(read, part);
    }

    const trusted = trustedInitializerOf(identifier);
    const value = trusted !== undefined && databaseReadOf(trusted) !== undefined ? rowFieldReadOf(identifier) : { field: "", read: identifier };

    return (
        value.field !== undefined &&
        withNonNull(outermostChainOf(value.read)) === withNonNull(value.read) &&
        invokedBy(value.read) === undefined &&
        !insideCallWithin(value.read, part)
    );
};

/**
 * Whether `part` emits the identity it is scoped by: every identity value in it (outside the arguments of a
 * `ctx.db` read, which only select the row) reaches the key intact. Calls that never touch the identity, such
 * as a fixed `"/".repeat(1)` suffix, do not matter.
 */
const emitsIdentity = (part: TsNode): boolean =>
    scopesKeyPart(part) &&
    valueIdentifiersOf(part)
        .filter((identifier) => !insideDatabaseCallWithin(identifier, part))
        .filter((identifier) => ["auth", "db"].includes(contextTrustPathOf(outermostChainOf(identifier))?.[0] ?? "") || bindingScopesKey(identifier, undefined))
        .every((identifier) => isIntactIdentity(identifier, part));

/** Whether `parent`, a template or `+` concatenation, opens with an identity-scoped part before `child` and no caller part ahead of it. */
const opensWithIdentityBefore = (child: TsNode, parent: TsNode): boolean => {
    if (Node.isTemplateSpan(child) && Node.isTemplateExpression(parent)) {
        const spans = parent.getTemplateSpans();
        const leading = spans.slice(0, spans.indexOf(child)).map((span) => span.getExpression());
        const firstScoped = leading.findIndex((part) => emitsIdentity(part));

        return firstScoped !== -1 && !leading.slice(0, firstScoped).some((part) => reachesArgsWithinOneHop(part));
    }

    // The left side folds every earlier operand, so any caller value in it may precede the identity.
    return (
        Node.isBinaryExpression(parent) &&
        parent.getOperatorToken().getKind() === SyntaxKind.PlusToken &&
        child === parent.getRight() &&
        emitsIdentity(parent.getLeft()) &&
        !reachesArgsWithinOneHop(parent.getLeft())
    );
};

/**
 * Whether some template or `+` concatenation between `identifier` and `within` opens with an
 * identity-scoped part before the one holding `identifier`, with no caller-supplied part ahead
 * of that identity. Whatever the later part then resolves to, it is appended under the caller's
 * own prefix. A scoped part after it does not count (`${args.a ?? args.b}/${uid}`), and neither
 * does one behind a caller segment (`${args.tenant}/${uid}/${args.a ?? args.b}`): the caller
 * chooses the leading segment there.
 */
const followsIdentityPrefix = (identifier: TsNode, within: TsNode): boolean => {
    for (let child = identifier, parent = identifier.getParent(); parent !== undefined && child !== within; child = parent, parent = parent.getParent()) {
        if (opensWithIdentityBefore(child, parent)) {
            return true;
        }
    }

    return false;
};

/** True when `node` is, or textually contains, a value reference to the `args` binding. */
export const referencesArgs = (node: TsNode): boolean => referencesBinding(node, "args");

/**
 * When `node` is a bare identifier bound by a `const key = args.key` (or by a
 * destructure such as `const { key } = args`) in the enclosing handler, return that
 * declaration so a *single* extra hop of taint can be checked (`const key = args.key;
 * … key`); otherwise `undefined`. Only same-function declarations are followed — the
 * taint stays deliberately single-hop.
 */
export const singleHopDeclaration = (node: TsNode): VariableDeclaration | undefined => {
    if (!Node.isIdentifier(node)) {
        return undefined;
    }

    const name = node.getText();
    const enclosingFunction = node.getFirstAncestor(
        (ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor),
    );

    if (enclosingFunction === undefined) {
        return undefined;
    }

    // The nearest same-named `const` declared *before* this use. A declaration that
    // follows the use — or a shadowing one in a sibling branch — can't be its source,
    // so preferring the closest preceding binding avoids resolving through a shadow.
    // Kept spelling-based on purpose: over-resolving here only makes the taint
    // predicate report MORE, which fails open. The project does carry a type
    // checker, and a predicate that SILENCES on a match must use it instead, as
    // the owner-field feeder does for mutator impls (`implTaintOf`).
    // A declaration inside a nested function is out of scope at this use, so it cannot be its source.
    const usePosition = node.getStart();
    let nearest: VariableDeclaration | undefined;
    let nearestPosition = -1;

    for (const variable of descendantsOfKind(enclosingFunction, SyntaxKind.VariableDeclaration)) {
        if (!declaresName(variable, name)) {
            continue;
        }

        // A binding in a block that does not contain the use is a different variable,
        // and taking its initializer would replace the real source.
        const scope = bindingScope(variable, enclosingFunction);

        if (scope === undefined || usePosition < scope.getStart() || usePosition >= scope.getEnd()) {
            continue;
        }

        const initializer = variable.getInitializer();
        const declarationPosition = variable.getStart();

        if (initializer !== undefined && declarationPosition < usePosition && declarationPosition > nearestPosition) {
            nearest = variable;
            nearestPosition = declarationPosition;
        }
    }

    return nearest;
};

/** The initializer of {@link singleHopDeclaration}: for a destructured binding, the whole object it was taken from. */
export const singleHopInitializer = (node: TsNode): TsNode | undefined => singleHopDeclaration(node)?.getInitializer();

/**
 * True when `expression` is derived from the handler's `args` — directly (`args.x`,
 * a template / `new URL(...)` / helper call embedding `args.*`), through one local
 * hop on the expression itself (`const key = args.key; … key`), or through one hop
 * on each value identifier composed into a larger expression (`const host =
 * args.host; fetch(\`https://${host}/x\`)`). Each identifier is followed one hop
 * only; an initializer is never followed again. This is the shared taint predicate
 * every Wave 3 sink feeder (SSRF fetch, owner-field write, storage/kv IDOR) reads.
 */
export const isArgumentDerived = (expression: TsNode): boolean => {
    if (referencesArgs(expression)) {
        return true;
    }

    // A destructured binding's default (`const { url = args.url } = config`) supplies the value
    // whenever the object lacks the field, so it is a source alongside the initializer.
    const reachesArgs = (node: TsNode): boolean => {
        const variable = singleHopDeclaration(node);
        const initializer = variable?.getInitializer();
        return (
            (initializer !== undefined && referencesArgs(initializer)) ||
            bindingDefaultsOf(variable, node.getText()).some((fallback) => referencesArgs(fallback))
        );
    };

    return reachesArgs(expression) || valueIdentifiersIn(expression).some((identifier) => reachesArgs(identifier));
};

/**
 * True when `expression` — or its single-hop initializer — is NOT itself a call
 * (a `CallExpression` or `new` expression) that could transform the value before
 * it reaches the sink. `isArgumentDerived` deliberately also matches "a helper
 * call embedding `args.*`" (e.g. `hash(args.key)`, `deriveKey(args)`) so taint
 * detection stays fail-open; that is right for most sinks, but wrong for a rule
 * whose entire premise is that the caller controls the exact bytes reaching the
 * sink. A content-addressed key — the return of a server-side `storeFile(...)`
 * helper, itself the SHA-256 of the uploaded bytes — textually references
 * `args` (it IS the arg) yet is not attacker-chosen, because the call in
 * between recomputed it from data the server already trusts.
 *
 * Only a direct member/element-access chain, a template literal, or a binary
 * concatenation reaches here as "unmodified" — a wrapping call anywhere between
 * the sink argument and its (at most single-hop) `args`/`ctx` root means the
 * value was derived, not merely forwarded, so the rule should not treat it as
 * caller-controlled input reaching the sink verbatim.
 */
export const isUnmodifiedArgumentPassthrough = (node: TsNode): boolean => {
    if (isRecomputed(node)) {
        return false;
    }

    // A default that forwards args reaches the sink whenever the object lacks the field.
    if (bindingDefaultsOf(singleHopDeclaration(node), node.getText()).some((fallback) => referencesArgs(fallback) && !isRecomputed(fallback))) {
        return true;
    }

    const initializer = singleHopInitializer(node);

    // A row fetched by a caller-supplied id is a lookup, not a recomputation, as below for composed keys.
    if (initializer !== undefined && isRecomputed(initializer) && !(isDatabaseReadSource(initializer) && referencesArgs(initializer))) {
        return false;
    }

    const composed = initializer ?? node;

    if (referencesArgs(composed)) {
        return true;
    }

    // `isArgumentDerived` also follows each composed identifier one hop, so a key built only from
    // call results (`blobs/${digest}` with `digest = sha256Hex(args.bytes)`) is tainted but was
    // recomputed; it is a passthrough only when some composed binding forwards args unchanged.
    // An identifier read inside a call in the key (`blobs/${sha256Hex(name)}`) is recomputed there.
    return valueIdentifiersIn(composed).some((identifier) => {
        const nearest = identifier.getFirstAncestor((ancestor) => ancestor === composed || Node.isCallExpression(ancestor) || Node.isNewExpression(ancestor));

        if (nearest !== composed) {
            return false;
        }

        const declaration = singleHopDeclaration(identifier);
        // A `ctx.db` call is a lookup or a write, not a recomputation: a key read off the row it returns is the one the
        // caller pointed at, or the one the caller wrote.
        const forwards = (source: TsNode | undefined): boolean =>
            source !== undefined && referencesArgs(source) && (!isRecomputed(source) || isDatabaseCallSource(source));

        return forwards(declaration?.getInitializer()) || bindingDefaultsOf(declaration, identifier.getText()).some((fallback) => forwards(fallback));
    });
};

/**
 * True when `node` is scoped by a server-trusted `ctx` value — directly, through
 * one local `const` hop (symmetric with {@link isArgumentDerived}), or through a
 * locally-bound ctx identity composed into the key. A storage/kv key such as
 * `${ctx.auth.userId}/${args.name}` references *both* `args` and `ctx`; the IDOR
 * sinks treat any key that reaches `ctx` — even via `const k = scoped; … k` — as
 * scoped rather than attacker-controlled, so a correctly-prefixed key is not
 * flagged.
 *
 * The recommended remediation is usually written through an intermediate binding —
 * `const userId = ctx.auth.userId; … `${userId}/${args.name}`` — which puts the
 * ctx value *two* hops from the sink: one hop expands the key to its template, and
 * the identity reaches `ctx` only through the `userId` binding. So after the direct
 * and single-hop checks, each value-identifier composed into the key is followed
 * one hop to its own initializer, treating a key built from a ctx-derived local as
 * scoped. This only ever *suppresses* a finding (a fail-safe under-report), never
 * introduces one.
 */
export const isScopedByContext = (node: TsNode): boolean => {
    if (referencesContext(node)) {
        return true;
    }

    const initializer = trustedInitializerOf(node);

    if (initializer !== undefined && referencesContext(initializer)) {
        return true;
    }

    // Follow each value-identifier composed into the (expanded) key one hop to its
    // own initializer — `${userId}/…` reaches ctx via `const userId = ctx.*`.
    const composed = initializer ?? node;
    const identifiers = Node.isIdentifier(composed) ? [composed] : composed.getDescendantsOfKind(SyntaxKind.Identifier);

    return identifiers.some((identifier) => {
        const boundInitializer = trustedInitializerOf(identifier);

        return boundInitializer !== undefined && referencesContext(boundInitializer);
    });
};

/**
 * Whether `node` is scoped to a key source the caller cannot choose: the caller's
 * identity, or a database read bound to that identity (an owned record's field read
 * off `ctx.db…findFirst({ where: { ownerId: ctx.auth.userId } })`). A row fetched by
 * a caller-supplied id (`ctx.db.get("files", args.id)`) does not scope a key: the
 * caller picked the row. It runs the same direct, one-hop and composed-local stages
 * as {@link isScopedByContext}, asking {@link referencesScopedKeySource} instead of
 * {@link referencesContext}. Only the IDOR sinks (kv, storage, container keys) use
 * it: a key built from an env value (`${ctx.env.PREFIX}/${args.key}`) or `ctx.now`
 * is still shared or caller-chosen, so it is not scoped. Browser URLs keep the
 * broader check, because a server-pinned host (`${ctx.env.CDN}/…`) is exactly the
 * safe shape there.
 */
export const isScopedByIdentity = (node: TsNode): boolean => {
    // A caller value on any fallback path (`row?.storageKey ?? args.key`) is the key whenever the scoped
    // side is missing, so nothing the key also reads can scope it, unless every alternative lands
    // after an identity prefix (`${ctx.auth.userId}/${args.key ?? args.other}`).
    const expanded = trustedInitializerOf(node) ?? node;

    if (
        valueIdentifiersOf(expanded).some(
            (identifier) =>
                isAlternativeOf(identifier, expanded) && reachesArgsWithinOneHop(outermostChainOf(identifier)) && !followsIdentityPrefix(identifier, expanded),
        )
    ) {
        return false;
    }

    if (referencesScopedKeySource(node, node)) {
        return true;
    }

    if (bindingScopesKey(node, node)) {
        return true;
    }

    const composed = trustedInitializerOf(node) ?? node;
    const identifiers = Node.isIdentifier(composed) ? [composed] : composed.getDescendantsOfKind(SyntaxKind.Identifier);

    return identifiers.some(
        // `args.key ?? uid` is the caller's key whenever one is sent, whatever `uid` holds, and a value passed into a
        // `ctx.db` call does not scope the key either: only an identity-bound read does, through the direct branch.
        (identifier) => !isAlternativeOf(identifier, composed) && !insideDatabaseCallWithin(identifier, composed) && bindingScopesKey(identifier, composed),
    );
};

/**
 * True when `node` is, or textually contains, a value reference to the `httpAction`
 * request parameter `requestName`. The request-rooted analog of
 * {@link referencesArgs}: catches `request.headers.get("x")`,
 * `new URL(request.url).searchParams.get("q")`, and `await request.json()`, which
 * the `args`-rooted feeders can't see (an HTTP handler receives a raw `Request`,
 * not the validated `args` object).
 */
export const referencesRequestInput = (node: TsNode, requestName: string): boolean => referencesBinding(node, requestName);

/**
 * True when `node` is derived from the `httpAction` request parameter — directly,
 * through one local `const` hop (`const h = request.headers; h.get("x")`), or
 * through one hop on the *root* of a member access (`const body = await
 * request.json(); … body.tag`). Symmetric with {@link isArgumentDerived}, plus the
 * member-root hop so a reflected request *body* value (always bound to a `const`
 * before its fields are read) is reached. Deliberately bounded to a single hop —
 * an unreached case is a fail-safe under-report, not a false negative that matters.
 */
export const isRequestInputDerived = (node: TsNode, requestName: string): boolean => {
    if (referencesRequestInput(node, requestName)) {
        return true;
    }

    const initializer = singleHopInitializer(node);

    if (initializer !== undefined && referencesRequestInput(initializer, requestName)) {
        return true;
    }

    const root = memberAccessRootIdentifier(node);

    if (root !== undefined) {
        const rootInitializer = singleHopInitializer(root);

        return rootInitializer !== undefined && referencesRequestInput(rootInitializer, requestName);
    }

    return false;
};

/**
 * Whether a sink's key is read off a row that the handler has already checked against the caller's
 * identity, before the sink. `sinkCall` is the sink call, `key` its key argument, and `F` the innermost
 * function containing the sink. The rule holds only when all three parts hold; every other shape
 * reports.
 *
 * (R) The row. `key` (or, when it is a bare identifier, its one-hop `const` initializer) is an access
 * chain with at least one level, rooted at identifier `R`. `R` is a single-identifier `const` directly
 * in `F`, initialised by (`await`) a `ctx.db` read.
 *
 * (a) An identity-bound guard, in one of two forms.
 *
 * Helper guard: an expression statement `await h(…)` or `h(…)`. `h` is an app function (see
 * {@link appFunctionOf}) reached by one level only, not through another helper. Exactly one
 * argument is the handler's ctx; `h`'s parameter at that position is a plain identifier `P`. `h`'s
 * own body (not a nested function) contains a read `P.db…(…)` whose arguments contain a `P.auth…`
 * chain, and a `throw`. If `h` is `async` or may return a Promise, the call is awaited.
 *
 * Inline guard: `const g = await ctx.db…(…)` in `F`, whose read arguments reference `ctx.auth`
 * (see {@link isIdentityBoundRead}), followed directly by `if (!g | g === undefined | g === null |
 * g == null) { … }` with no `else`. The branch's last statement (the block's, or the branch itself)
 * is a `throw` or a `return`.
 *
 * (b) Tied to the row. For a helper guard, an argument other than the ctx references `R`. For an
 * inline guard, the read's arguments reference `R`. A reference is a symbol match, not a spelling
 * match.
 *
 * (c) Dominates and is enforced. The guard statement is a direct child of a `Block` that contains the
 * sink, and comes before the statement of that block that contains the sink. The guard is not inside a
 * nested function, loop, `if`, `switch` case, `catch`, or a `try` with a `catch` unless the sink is in
 * that same `try` block. An inline guard is enforced only by its `if`, and a helper guard only by
 * its `throw`; neither return value is inspected.
 *
 * Used by the identity-scoped IDOR feeders only, in addition to {@link isScopedByIdentity}.
 */
export const isGuardedByIdentityCheck = (sinkCall: CallExpression, key: TsNode): boolean => {
    const enclosing = enclosingFunctionOf(sinkCall);
    const row = rowDeclarationOf(key);

    if (enclosing === undefined || row === undefined || enclosingFunctionOf(row)?.compilerNode !== enclosing.compilerNode) {
        return false;
    }

    // A `const` row's fields stay writable: `row.key = args.key` after the guard replaces what the guard vouched for.
    const overwritten = enclosing.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((expression) => {
        const target = accessPathOf(expression.getLeft());

        return isAssignmentOperator(expression.getOperatorToken().getKind()) && target !== undefined && bindsTo(target.root, row);
    });

    if (overwritten) {
        return false;
    }

    let child: TsNode = sinkCall;
    let ancestor: TsNode | undefined = sinkCall.getParent();

    while (ancestor !== undefined && ancestor.compilerNode !== enclosing.compilerNode) {
        if (Node.isBlock(ancestor)) {
            const statements = ancestor.getStatements();
            const index = statements.findIndex((statement) => statement.compilerNode === child.compilerNode);

            if (index > 0 && hasPrecedingGuard(statements, index, row, enclosing, sinkCall)) {
                return true;
            }
        }

        child = ancestor;
        ancestor = ancestor.getParent();
    }

    return false;
};

export { appFunctionOf };
