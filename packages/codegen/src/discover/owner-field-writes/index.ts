import type { CallExpression, Node as TsNode, ObjectLiteralExpression, ParameterDeclaration, Project } from "ts-morph";
import { Node } from "ts-morph";

import { isArgumentDerived } from "../../argument-taint";
import type { CallSiteScope, FunctionIR, MutatorIR, OwnerFieldWriteIR } from "../../ir";
import { bindingKeyName, collectCallRows, isConstDeclaration, propertyKeyName, unwrapExpression } from "../ast";
import { callSiteScopeOf, declarationOf, withCallerVisibility } from "../attribution";
import { isContextRooted, mayDenoteContextDatabase } from "../context-root";
import type { MutatorImplScope } from "./args-pristine";
import { mutatorImplScopeOf } from "./args-pristine";
import implTaintOf from "./impl-taint";

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
 * When `node` is a `<ctx>.db.<method>` member access for one of the
 * {@link IDENTITY_WRITE_METHODS}, return the method name; otherwise `undefined`.
 * The `ctx.db` receiver is resolved by symbol (see `mayDenoteContextDatabase`), so a
 * renamed (`(c, args) => c.db.insert(…)`) or destructured
 * (`({ db }, args) => db.insert(…)`, `const { db } = ctx`) ctx still matches.
 */
const contextDatabaseWriteMethod = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();

    return IDENTITY_WRITE_METHODS.has(method) && mayDenoteContextDatabase(node.getExpression()) ? method : undefined;
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

/** Identity columns in one object literal that are written from `args` and not from `ctx`. */
const identityWritesInObjectLiteral = (
    objectLiteral: ObjectLiteralExpression,
    write: { call: CallExpression; method: string; ownerField: string | undefined; relativePath: string; scope: CallSiteScope },
    implScope: MutatorImplScope | undefined,
): OwnerFieldWriteIR[] => {
    const rows: OwnerFieldWriteIR[] = [];
    const taint = implScope === undefined ? undefined : implTaintOf(implScope);

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
        // Only a value ROOTED in the handler's ctx is server-scoped — merely
        // referencing ctx is not, the rule every other feeder keeps: an identity
        // column `ctx.auth.userId ?? args.userId` is an IDOR whatever its left
        // side is. Outside a mutator impl the root is resolved by
        // `isContextRooted`; inside one, by the impl's own taint model
        // (`ImplTaint`).
        const isTainted = taint === undefined ? isArgumentDerived(value) && !isContextRooted(value) : taint.isTaintedValue(value, true);

        if (isTainted) {
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
    // The owner a write may be scoped by is its mutator's: the impl it runs in, inline or declared apart.
    const implScope = mutatorImplScopeOf(call);
    const write = { call, method, ownerField: implScope === undefined ? undefined : ownerFieldOf(implScope.mutatorName), relativePath, scope };

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
