import type { CallExpression, Node as TsNode, ObjectLiteralExpression, ParameterDeclaration, Project, ts } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isArgumentDerived, isScopedByContext, readsRequestParameter } from "../argument-taint";
import type { CallSiteScope, FunctionIR, MutatorIR, OwnerFieldWriteIR } from "../ir";
import { bindingKeyName, collectCallRows, isConstDeclaration, isWriteTarget, outermostValueWrapper, propertyKeyName, unwrapExpression } from "./ast";
import { callSiteScopeOf, declarationOf, withCallerVisibility } from "./attribution";
import type { MutatorServerImpl } from "./mutators";
import { mutatorServerImplOf } from "./mutators";

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
 * The mutator `server` impl `call` runs in, plus its own `args` parameter.
 * `pristine` says whether that parameter is still exactly the object
 * `applyOwnerScope` verified (see {@link isPristineArgsParameter}).
 */
interface MutatorImplScope {
    impl: MutatorServerImpl;
    parameter: ParameterDeclaration | undefined;
    pristine: boolean;
}

/** Per-impl {@link isPristineArgsParameter} verdicts, keyed on the compiler node so a re-parse recomputes. */
const PRISTINE_CACHE = new WeakMap<ts.Node, boolean>();

/** Whether `node` is the operand of a plain member READ: `x.k`, `x?.k`, `x[k]`, seen through wrappers, and not written. */
const isMemberRead = (node: TsNode): boolean => {
    const value = outermostValueWrapper(node);
    const access = value.getParent();

    return (Node.isPropertyAccessExpression(access) || Node.isElementAccessExpression(access)) && access.getExpression() === value && !isWriteTarget(access);
};

/** Whether `node` is the initializer of a destructuring declaration (`const { a } = node`), which only reads members. */
const isDestructuringRead = (node: TsNode): boolean => {
    // With a binding-pattern name, the only expression child a declaration has is its initializer.
    const declaration = outermostValueWrapper(node).getParent();

    return Node.isVariableDeclaration(declaration) && Node.isObjectBindingPattern(declaration.getNameNode());
};

/**
 * Whether the impl's `args` parameter is still exactly the object
 * `applyOwnerScope` verified, for every read of it in the impl. Fails closed:
 *
 * - `arguments` anywhere in the impl reaches the parameter without naming it;
 * - a `var` redeclaration of a parameter binding is a second declaration of it;
 * - an `args` parameter used as anything but a plain member read (or a
 * destructuring initializer) — written through, passed to a call
 * (`fix(args)`, `Object.assign(args, …)`), aliased (`const a = args`),
 * spread — may be changed where this cannot see;
 * - a destructured binding of the parameter that is written (`userId = …`).
 */
const isPristineArgsParameter = (impl: MutatorServerImpl, parameter: ParameterDeclaration): boolean => {
    const cached = PRISTINE_CACHE.get(impl.compilerNode);

    if (cached !== undefined) {
        return cached;
    }

    const nameNode = parameter.getNameNode();
    const bindings = Node.isIdentifier(nameNode)
        ? [nameNode]
        : nameNode.getDescendantsOfKind(SyntaxKind.BindingElement).flatMap((element) => {
              const name = element.getNameNode();

              return Node.isIdentifier(name) ? [name] : [];
          });
    const declarationByName = new Map(bindings.map((binding) => [binding.getText(), binding.getParentOrThrow().compilerNode]));
    const pristine =
        bindings.every((binding) => (binding.getSymbol()?.getDeclarations().length ?? 0) === 1) &&
        impl.getDescendantsOfKind(SyntaxKind.Identifier).every((identifier) => {
            const name = identifier.getText();

            if (name === "arguments") {
                return false;
            }

            const declaration = declarationByName.get(name);

            if (declaration === undefined || bindings.includes(identifier) || declarationOf(identifier)?.compilerNode !== declaration) {
                return true;
            }

            return Node.isIdentifier(nameNode) ? isMemberRead(identifier) || isDestructuringRead(identifier) : !isWriteTarget(identifier);
        });

    PRISTINE_CACHE.set(impl.compilerNode, pristine);

    return pristine;
};

/**
 * The {@link MutatorImplScope} of `call`, resolved DOWN from the top-level
 * declaration `call` sits in to that declaration's own `server` impl (see
 * {@link mutatorServerImplOf}); `undefined` when the call is not inside it.
 * Never matched by name on an ancestor: a nested `const save = defineMutator(…)`
 * inside the exported `save` resolves to the export's impl, in which the nested
 * mutator's `args` is just a nested function's parameter.
 */
const mutatorImplScopeOf = (call: CallExpression): MutatorImplScope | undefined => {
    const statement = call.getAncestors().at(-2);
    const declaration = Node.isVariableStatement(statement)
        ? statement.getDeclarations().find((candidate) => candidate.getPos() <= call.getPos() && call.getEnd() <= candidate.getEnd())
        : undefined;
    const impl = declaration === undefined ? undefined : mutatorServerImplOf(declaration);

    if (impl === undefined || call.getPos() < impl.getPos() || impl.getEnd() < call.getEnd()) {
        return undefined;
    }

    const candidate = impl.getParameters()[1];
    const parameter = candidate === undefined || candidate.isRestParameter() ? undefined : candidate;

    return { impl, parameter, pristine: parameter !== undefined && isPristineArgsParameter(impl, parameter) };
};

/**
 * Whether `parameter` is caller-controlled inside `scope`'s impl: the impl's own
 * `args`, or ANY parameter of a function nested in the impl. A nested function
 * can be called with anything (`persist({ userId: args.targetUserId })`), so
 * its parameters are taint sources however they are spelled, and never
 * owner-scoped.
 */
const isRequestParameterIn =
    (scope: MutatorImplScope) =>
    (parameter: ParameterDeclaration): boolean => {
        if (parameter.compilerNode === scope.parameter?.compilerNode) {
            return true;
        }

        return parameter.getParent() !== scope.impl && scope.impl.getPos() <= parameter.getPos() && parameter.getEnd() <= scope.impl.getEnd();
    };

/** The object `node` reads `field` from (`<object>.<field>`, `<object>?.<field>`, `<object>["<field>"]`), unwrapped; else `undefined`. */
const ownerPropertyObject = (node: TsNode, field: string): TsNode | undefined => {
    if (Node.isPropertyAccessExpression(node)) {
        return node.getName() === field ? unwrapExpression(node.getExpression()) : undefined;
    }

    if (Node.isElementAccessExpression(node)) {
        const argument = node.getArgumentExpression();

        return argument !== undefined && Node.isStringLiteral(argument) && argument.getLiteralValue() === field
            ? unwrapExpression(node.getExpression())
            : undefined;
    }

    return undefined;
};

/** Whether `node` is an identifier resolving, by symbol, to `parameter` itself. */
const isParameterReference = (node: TsNode | undefined, parameter: ParameterDeclaration): boolean =>
    Node.isIdentifier(node) && declarationOf(node)?.compilerNode === parameter.compilerNode;

/**
 * Whether `value` resolves to the verified `args[owner]` of a PRISTINE impl
 * parameter `parameter`: `args.<owner>` / `args?.<owner>` / `args["<owner>"]`,
 * the `<owner>` element of the destructured parameter (`(ctx, { userId })`) or
 * of a `const` destructure of it (`const { userId } = args`) — directly or
 * through one `const` alias. `applyOwnerScope` stamps the parsed args BEFORE
 * `server(context, args)` runs, so each of these reads the stamped value.
 *
 * Every identifier is resolved by SYMBOL: a nested closure's own `args`, a
 * shadowing `for` / `catch` / block binding, or anything else merely spelled
 * `args` resolves elsewhere. The column NAME matching `owner` is not enough
 * either: `{ userId: args.targetUserId }` is a genuine act-as-any-user IDOR. A
 * `let` destructure or alias, a nested destructuring, or a rest element falls
 * through as NOT owner-scoped, which fails toward reporting.
 */
const resolvesToOwnerArgument = (value: TsNode, parameter: ParameterDeclaration, ownerField: string, hops = 1): boolean => {
    const object = ownerPropertyObject(value, ownerField);

    if (object !== undefined) {
        return isParameterReference(object, parameter);
    }

    const declaration = Node.isIdentifier(value) ? declarationOf(value) : undefined;

    if (Node.isBindingElement(declaration)) {
        const pattern = declaration.getParent();
        const holder = pattern.getParent();
        const isOwnerElement =
            declaration.getDotDotDotToken() === undefined && bindingKeyName(declaration) === ownerField && Node.isObjectBindingPattern(pattern);

        return (
            isOwnerElement &&
            (holder.compilerNode === parameter.compilerNode ||
                (isConstDeclaration(holder) && isParameterReference(unwrapExpression(holder.getInitializer()), parameter)))
        );
    }

    const initializer = isConstDeclaration(declaration) ? declaration.getInitializer() : undefined;

    return hops > 0 && initializer !== undefined && resolvesToOwnerArgument(initializer, parameter, ownerField, hops - 1);
};

/** Whether `value` mentions the `arguments` object. */
const readsArgumentsObject = (value: TsNode): boolean =>
    (Node.isIdentifier(value) ? [value] : value.getDescendantsOfKind(SyntaxKind.Identifier)).some((identifier) => identifier.getText() === "arguments");

/** Identity columns in one object literal that are written from `args` and not from `ctx`. */
const identityWritesInObjectLiteral = (
    objectLiteral: ObjectLiteralExpression,
    write: { call: CallExpression; method: string; ownerField: string | undefined; relativePath: string; scope: CallSiteScope },
    implScope: MutatorImplScope | undefined,
): OwnerFieldWriteIR[] => {
    const rows: OwnerFieldWriteIR[] = [];
    const isSource = implScope === undefined ? undefined : isRequestParameterIn(implScope);

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

        // Correct: `userId: ctx.auth.userId`; offending: `userId: args.userId`.
        // A value that references `ctx` is server-scoped even when it also embeds
        // `args`, so it is not flagged — mirrors the shared taint convention.
        // Inside a mutator impl, `arguments` reaches the args without naming them.
        const isTainted = isArgumentDerived(value) || (isSource !== undefined && (readsRequestParameter(value, isSource) || readsArgumentsObject(value)));

        if (isTainted && !isScopedByContext(value)) {
            // Recorded either way — the lint decides what to do with it. Dropping it
            // here would make the feeder the only place that knows the write
            // happened, and the `visibility` stamp is the precedent for annotating
            // rather than discarding.
            //
            // Owner-scoped ONLY when the value is, by symbol, the `args[owner]` the
            // runtime verified: `applyOwnerScope` stamps the parsed args object this
            // export's `defineMutator` `server` impl receives as its 2nd parameter,
            // and nothing else. A write anywhere in that impl, nested closures
            // included, qualifies iff it reads THAT parameter and the impl never
            // rewrites or lets it escape. A helper's or a nested function's own
            // parameters can be filled from anything, so they never qualify.
            const ownerScoped =
                write.ownerField === name &&
                implScope?.parameter !== undefined &&
                implScope.pristine &&
                resolvesToOwnerArgument(value, implScope.parameter, name);

            rows.push({
                field: name,
                file: write.relativePath,
                line: write.call.getStartLineNumber(),
                method: write.method,
                scope: write.scope,
                ...(ownerScoped && { ownerScoped: true }),
            });
        }
    }

    return rows;
};

/** Identity columns written from `args` by a single `ctx.db` write call. */
const ownerFieldWritesInCall = (call: CallExpression, relativePath: string, ownerFieldOf: (exportName: string) => string | undefined): OwnerFieldWriteIR[] => {
    const method = contextDatabaseWriteMethod(call.getExpression());
    const documentArgument = method === undefined ? undefined : call.getArguments()[1];

    if (method === undefined || documentArgument === undefined) {
        return [];
    }

    const objectLiterals = documentObjectLiterals(documentArgument, method);

    if (objectLiterals.length === 0) {
        return [];
    }

    const scope = callSiteScopeOf(call);
    const isExport = scope.kind === "export";
    const write = { call, method, ownerField: isExport ? ownerFieldOf(scope.name) : undefined, relativePath, scope };
    const implScope = isExport ? mutatorImplScopeOf(call) : undefined;

    return objectLiterals.flatMap((objectLiteral) => identityWritesInObjectLiteral(objectLiteral, write, implScope));
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
