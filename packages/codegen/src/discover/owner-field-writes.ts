import type { CallExpression, Identifier, Node as TsNode, ObjectLiteralExpression, ParameterDeclaration, Project, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { isArgumentDerived, isScopedByContext } from "../argument-taint";
import type { FunctionIR, MutatorIR, OwnerFieldWriteIR } from "../ir";
import { bindingKeyName, collectCallRows, propertyKeyName } from "./ast";
import { callSiteScopeOf, referencedSymbolOf, withCallerVisibility } from "./attribution";
import { isDefineMutatorCallee } from "./mutators";

/**
 * Ownership / identity columns whose value must come from the server-trusted
 * identity (`ctx.auth` / `ctx.identity`), never from request input. Writing one
 * of these from `args` lets a caller act as another user or tenant — a
 * cross-tenant IDOR. Kept deliberately tight to identity / tenancy columns (not
 * arbitrary foreign keys the caller may legitimately choose) to hold the
 * false-positive rate down; the members are the identity-ish columns that
 * actually appear in the repo's example schemas.
 */
const IDENTITY_FIELDS = new Set<string>([
    "accountId",
    "authorId",
    "createdBy",
    "createdById",
    "organizationId",
    "orgId",
    "ownerId",
    "tenantId",
    "updatedBy",
    "userId",
    "workspaceId",
]);

/**
 * `ctx.db` write surfaces whose document / partial (the object whose identity
 * columns this feeder inspects) is the SECOND argument: `insert(table, doc)`,
 * `replace(id, doc)`, `patch(id, partial)`, and `insertManyUnsafe(table, rows)`
 * (`rows` an array of documents). The document argument is always `arg[1]`.
 */
const IDENTITY_WRITE_METHODS = new Set<string>(["insert", "insertManyUnsafe", "patch", "replace"]);

/**
 * When `node` is a `ctx.db.<method>` member access for one of the
 * {@link IDENTITY_WRITE_METHODS}, return the method name; otherwise `undefined`.
 * Matched by shape (a member chain rooted at `ctx.db`), the same import-agnostic,
 * fail-closed convention the other feeders use, so a re-export or alias still resolves.
 */
const contextDatabaseWriteMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    if (!IDENTITY_WRITE_METHODS.has(method)) {
        return undefined;
    }

    const database = node.getExpression();

    if (!Node.isPropertyAccessExpression(database) || database.getName() !== "db") {
        return undefined;
    }

    const context = database.getExpression();

    return Node.isIdentifier(context) && context.getText() === "ctx" ? method : undefined;
};

/**
 * The object literals whose identity columns a write's document argument
 * contributes: the argument itself for the single-document writes, and each
 * array element for `insertManyUnsafe`'s row list.
 */
const documentObjectLiterals = (documentArgument: TsNode, method: string): ObjectLiteralExpression[] => {
    if (method !== "insertManyUnsafe") {
        return Node.isObjectLiteralExpression(documentArgument) ? [documentArgument] : [];
    }

    if (!Node.isArrayLiteralExpression(documentArgument)) {
        return [];
    }

    const objectLiterals: ObjectLiteralExpression[] = [];

    for (const element of documentArgument.getElements()) {
        if (Node.isObjectLiteralExpression(element)) {
            objectLiterals.push(element);
        }
    }

    return objectLiterals;
};

/**
 * The 2nd parameter (the validated `args`) of the `defineMutator` `server`
 * impl that `node` sits in, when that mutator is the export `exportName`;
 * otherwise `undefined`.
 *
 * Walks out to the nearest enclosing function that IS such an impl: inline
 * `server: (ctx, args) => …`, `server: function (ctx, args) {…}`, or the method
 * shorthand `server(ctx, args) {…}`. A closure nested inside the impl is walked
 * through, so a write in it still finds the impl; whether that write reads the
 * impl's own parameter is then decided by symbol, never by spelling.
 */
const mutatorArgsParameterOf = (node: TsNode, exportName: string): ParameterDeclaration | undefined => {
    for (const ancestor of node.getAncestors()) {
        if (!(Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isMethodDeclaration(ancestor))) {
            continue;
        }

        // A function whose parent is a property assignment is that property's value.
        const member = Node.isMethodDeclaration(ancestor) ? ancestor : ancestor.getParent();
        const isServerMember = (Node.isMethodDeclaration(member) || Node.isPropertyAssignment(member)) && propertyKeyName(member) === "server";
        const literal = isServerMember ? member.getParent() : undefined;
        const call = literal?.getParent();
        const declaration = call?.getParent();

        if (
            Node.isObjectLiteralExpression(literal) &&
            Node.isCallExpression(call) &&
            call.getArguments()[0] === literal &&
            isDefineMutatorCallee(call.getExpression()) &&
            Node.isVariableDeclaration(declaration) &&
            declaration.getInitializer() === call &&
            declaration.getName() === exportName
        ) {
            const parameter = ancestor.getParameters()[1];

            return parameter === undefined || parameter.isRestParameter() ? undefined : parameter;
        }
    }

    return undefined;
};

/** The declaration `identifier` resolves to through the type checker, or `undefined` when it has no symbol. */
const declarationOf = (identifier: Identifier): TsNode | undefined => {
    const symbol = referencedSymbolOf(identifier);

    return symbol?.getValueDeclaration() ?? symbol?.getDeclarations()[0];
};

/** Whether `declaration` is a `const` variable, the only binding that cannot be repointed after its initializer ran. */
const isConstVariable = (declaration: TsNode | undefined): declaration is VariableDeclaration => {
    const list = declaration?.getParent();

    return Node.isVariableDeclaration(declaration) && Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Const;
};

/**
 * Whether the expression `node` is written to: the left of any assignment
 * operator, an `++` / `--` / `delete` operand, a `for…in` / `for…of` target, or
 * a slot inside a destructuring assignment's left side (`({ userId } = other)`).
 */
const isWriteTarget = (node: TsNode): boolean => {
    const parent = node.getParent();

    if (parent === undefined) {
        return false;
    }

    if (Node.isBinaryExpression(parent)) {
        const operator = parent.getOperatorToken().getKind();

        return parent.getLeft() === node && operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment;
    }

    if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
        const operator = parent.getOperatorToken();

        return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken;
    }

    if (Node.isDeleteExpression(parent)) {
        return true;
    }

    if (Node.isForOfStatement(parent) || Node.isForInStatement(parent)) {
        return parent.getInitializer() === node;
    }

    if (Node.isPropertyAssignment(parent)) {
        const initializer: TsNode | undefined = parent.getInitializer();

        return initializer === node && isWriteTarget(parent);
    }

    // A slot of a destructuring assignment: the enclosing literal is the write target.
    const isSlot =
        Node.isShorthandPropertyAssignment(parent) ||
        Node.isSpreadAssignment(parent) ||
        Node.isSpreadElement(parent) ||
        Node.isParenthesizedExpression(parent) ||
        Node.isObjectLiteralExpression(parent) ||
        Node.isArrayLiteralExpression(parent);

    return isSlot && isWriteTarget(parent);
};

/**
 * Whether the binding `declaration` (a parameter, or an element of a
 * destructured parameter) is written anywhere in `handler`: rebinding it
 * (`args = {…}`, `userId = other`) or, for the `args` object, writing one of
 * its members (`args.userId = other`, `delete args[key]`). Any of these makes
 * the binding something other than the value `applyOwnerScope` verified,
 * wherever the write sits relative to the read, so it disqualifies the binding.
 */
const isRewrittenIn = (handler: TsNode, declaration: TsNode, name: string): boolean =>
    handler.getDescendantsOfKind(SyntaxKind.Identifier).some((reference) => {
        if (reference.getText() !== name || declarationOf(reference)?.compilerNode !== declaration.compilerNode) {
            return false;
        }

        const access = reference.getParent();
        const isMemberWrite =
            (Node.isPropertyAccessExpression(access) || Node.isElementAccessExpression(access)) &&
            access.getExpression() === reference &&
            isWriteTarget(access);

        return isMemberWrite || isWriteTarget(reference);
    });

/**
 * Whether `node` is the mutator's own `args` parameter, by symbol: an identifier
 * resolving to `parameter` itself, which the impl never rebinds or writes a
 * member of. A nested closure's own `args`, a `for` / `catch` / block binding
 * that shadows it, or anything else merely spelled `args` resolves elsewhere.
 */
const isVerifiedArgsObject = (node: TsNode, parameter: ParameterDeclaration): boolean => {
    const nameNode = parameter.getNameNode();

    return (
        Node.isIdentifier(node) &&
        Node.isIdentifier(nameNode) &&
        declarationOf(node)?.compilerNode === parameter.compilerNode &&
        !isRewrittenIn(parameter.getParentOrThrow(), parameter, nameNode.getText())
    );
};

/** The object `node` reads `field` from (`node` being `<object>.<field>` or `<object>["<field>"]`), else `undefined`. */
const ownerPropertyObject = (node: TsNode, field: string): TsNode | undefined => {
    if (Node.isPropertyAccessExpression(node)) {
        return node.getName() === field ? node.getExpression() : undefined;
    }

    if (Node.isElementAccessExpression(node)) {
        const argument = node.getArgumentExpression();

        return argument !== undefined && Node.isStringLiteral(argument) && argument.getLiteralValue() === field ? node.getExpression() : undefined;
    }

    return undefined;
};

/**
 * Whether the identifier `node` is a destructured binding of the verified
 * `args[owner]`: an element of the impl's own destructured parameter
 * (`server: (ctx, { userId }) => …`, never rebound), or of a `const`
 * destructure of the verified args object (`const { userId } = args`).
 * `applyOwnerScope` stamps the parsed args object BEFORE `server` is called with
 * it, so destructuring that parameter reads the stamped value. A rest element
 * (`...rest`) is not followed.
 */
const isVerifiedOwnerBinding = (node: TsNode, parameter: ParameterDeclaration, ownerField: string): boolean => {
    const element = Node.isIdentifier(node) ? declarationOf(node) : undefined;

    if (!Node.isBindingElement(element) || element.getDotDotDotToken() !== undefined || bindingKeyName(element) !== ownerField) {
        return false;
    }

    const elementName = element.getNameNode();
    const pattern = element.getParent();
    const holder = pattern.getParent();

    if (!Node.isIdentifier(elementName) || !Node.isObjectBindingPattern(pattern)) {
        return false;
    }

    if (holder === parameter) {
        return !isRewrittenIn(parameter.getParentOrThrow(), element, elementName.getText());
    }

    const initializer = isConstVariable(holder) ? holder.getInitializer() : undefined;

    return initializer !== undefined && isVerifiedArgsObject(initializer, parameter);
};

/** `value` reads the verified owner directly: `args.<owner>`, `args["<owner>"]`, or a destructured binding of it. */
const readsOwnerArgument = (value: TsNode, parameter: ParameterDeclaration, ownerField: string): boolean => {
    const object = ownerPropertyObject(value, ownerField);

    return object === undefined ? isVerifiedOwnerBinding(value, parameter, ownerField) : isVerifiedArgsObject(object, parameter);
};

/**
 * Whether `value` resolves to the verified `args[owner]` of the mutator impl
 * whose own `args` is `parameter`: directly, or through one immutable local
 * `const` alias.
 *
 * The column NAME matching the declared `owner` is not enough.
 * `applyOwnerScope` overwrites exactly `args[ownerField]` with the verified
 * identity, so only that one argument is laundered: a mutator declaring
 * `owner: "userId"` whose impl writes `{ userId: args.targetUserId }` is a
 * genuine act-as-any-user IDOR, and matching on the name alone would suppress it.
 *
 * Every identifier is resolved by SYMBOL. Matching the spelling `args` let a
 * nested closure with its own `args` parameter (or any shadowing `for` /
 * `catch` / block binding) launder a caller-chosen value into an
 * "owner-scoped" write. Anything this cannot resolve (a computed key, a
 * reassignable alias, a rewritten parameter) falls through as NOT
 * owner-scoped, which fails toward reporting.
 */
const resolvesToOwnerArgument = (value: TsNode, parameter: ParameterDeclaration, ownerField: string): boolean => {
    if (readsOwnerArgument(value, parameter, ownerField)) {
        return true;
    }

    const alias = Node.isIdentifier(value) ? declarationOf(value) : undefined;
    const initializer = isConstVariable(alias) && Node.isIdentifier(alias.getNameNode()) ? alias.getInitializer() : undefined;

    return initializer !== undefined && readsOwnerArgument(initializer, parameter, ownerField);
};

/**
 * Whether `value` reads the mutator impl's own `args` parameter by symbol,
 * whatever it is called: the parameter itself (`server: (ctx, input) => …`) or
 * a binding destructured out of it (`server: (ctx, { targetUserId }) => …`),
 * directly or through one `const` alias. The shared taint predicate matches the
 * spelling `args` (and bindings destructured from a parameter KEYED `args`), so
 * a renamed or positionally destructured parameter would otherwise record no
 * write at all.
 */
const readsParameterBinding = (value: TsNode, parameter: ParameterDeclaration): boolean => {
    const isParameter = (identifier: Identifier): boolean => declarationOf(identifier)?.compilerNode === parameter.compilerNode;
    const isParameterBinding = (identifier: Identifier): boolean => {
        const declaration = declarationOf(identifier);

        if (
            declaration?.compilerNode === parameter.compilerNode ||
            declaration?.getFirstAncestorByKind(SyntaxKind.Parameter)?.compilerNode === parameter.compilerNode
        ) {
            return true;
        }

        // `const { targetUserId } = args`: a binding destructured from the parameter in the body.
        const holder = Node.isBindingElement(declaration) ? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) : undefined;
        const initializer = holder?.getInitializer();

        return initializer !== undefined && Node.isIdentifier(initializer) && isParameter(initializer);
    };
    const readsDirectly = (node: TsNode): boolean =>
        (Node.isIdentifier(node) ? [node] : node.getDescendantsOfKind(SyntaxKind.Identifier)).some((identifier) => isParameterBinding(identifier));

    if (readsDirectly(value)) {
        return true;
    }

    const alias = Node.isIdentifier(value) ? declarationOf(value) : undefined;
    const initializer = isConstVariable(alias) ? alias.getInitializer() : undefined;

    return initializer !== undefined && readsDirectly(initializer);
};

/** Identity columns in one object literal that are written from `args` and not from `ctx`. */
const identityWritesInObjectLiteral = (
    objectLiteral: ObjectLiteralExpression,
    method: string,
    call: CallExpression,
    relativePath: string,
    ownerFieldOf: (exportName: string) => string | undefined,
): OwnerFieldWriteIR[] => {
    const rows: OwnerFieldWriteIR[] = [];

    for (const property of objectLiteral.getProperties()) {
        let name: string | undefined;
        let value: TsNode | undefined;

        if (Node.isPropertyAssignment(property)) {
            name = propertyKeyName(property);
            value = property.getInitializer();
        } else if (Node.isShorthandPropertyAssignment(property)) {
            name = propertyKeyName(property);
            value = property.getNameNode();
        }

        if (name === undefined || value === undefined || !IDENTITY_FIELDS.has(name)) {
            continue;
        }

        const scope = callSiteScopeOf(call);
        const parameter = scope.kind === "export" ? mutatorArgsParameterOf(call, scope.name) : undefined;

        // Correct: `userId: ctx.auth.userId`; offending: `userId: args.userId`.
        // A value that references `ctx` is server-scoped even when it also embeds
        // `args`, so it is not flagged — mirrors the shared taint convention.
        if ((isArgumentDerived(value) || (parameter !== undefined && readsParameterBinding(value, parameter))) && !isScopedByContext(value)) {
            // Recorded either way — the lint decides what to do with it. Dropping it
            // here would make the feeder the only place that knows the write
            // happened, and the `visibility` stamp is the precedent for annotating
            // rather than discarding.
            //
            // Owner-scoped ONLY when the value is, by symbol, the `args[owner]`
            // the runtime verified. `applyOwnerScope` stamps the parsed args
            // object that this export's `defineMutator` `server` impl receives as
            // its 2nd parameter, and nothing else. A write anywhere in that impl,
            // nested closures included, qualifies iff it reads THAT parameter (or
            // a destructured / `const` binding of its owner field). A helper's or
            // a nested closure's own `args` can be filled from anything
            // (`persist({ userId: args.targetUserId })`), so it never qualifies.
            const ownerScoped =
                scope.kind === "export" && parameter !== undefined && ownerFieldOf(scope.name) === name && resolvesToOwnerArgument(value, parameter, name);

            rows.push({
                field: name,
                file: relativePath,
                line: call.getStartLineNumber(),
                method,
                scope,
                ...(ownerScoped && { ownerScoped: true }),
            });
        }
    }

    return rows;
};

/** Identity columns written from `args` by a single `ctx.db` write call. */
const ownerFieldWritesInCall = (call: CallExpression, relativePath: string, ownerFieldOf: (exportName: string) => string | undefined): OwnerFieldWriteIR[] => {
    const method = contextDatabaseWriteMethod(call.getExpression());

    if (method === undefined) {
        return [];
    }

    const documentArgument = call.getArguments()[1];

    if (!documentArgument) {
        return [];
    }

    return documentObjectLiterals(documentArgument, method).flatMap((objectLiteral) =>
        identityWritesInObjectLiteral(objectLiteral, method, call, relativePath, ownerFieldOf),
    );
};

/**
 * Discover `ctx.db` writes (`insert`, `replace`, `patch`, `insertManyUnsafe`) in
 * `lunora/` that set an ownership / identity column — `userId`, `ownerId`,
 * `tenantId`, and the like — from the handler's `args` instead of the
 * server-trusted identity. This is the `owner_field_from_args_not_auth` lint
 * input: the ownership column decides who a row belongs to, so a value taken from
 * request input lets any caller write rows owned by another user or tenant (the
 * act-as-any-user / cross-tenant IDOR vector). A column stamped from `ctx.*`, or
 * set to a fixed literal, is not recorded; only an arg-derived identity write
 * (directly, or through one local `const` hop) reaches here.
 */
const discoverOwnerFieldWrites = (
    project: Project,
    lunoraDirectory: string,
    functions: ReadonlyArray<FunctionIR> = [],
    mutators: ReadonlyArray<MutatorIR> = [],
): OwnerFieldWriteIR[] => {
    // Keyed on file + export because two modules may export the same name.
    const ownerByKey = new Map(mutators.map((entry) => [`${entry.filePath}:${entry.exportName}`, entry.owner]));
    const writes = collectCallRows(project, lunoraDirectory, (call, relativePath) =>
        ownerFieldWritesInCall(call, relativePath, (exportName) => ownerByKey.get(`${relativePath}:${exportName}`)),
    );

    return withCallerVisibility(writes, functions);
};

export default discoverOwnerFieldWrites;
