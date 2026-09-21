import type { CallExpression, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "../argument-taint";
import type { FunctionIR, MutatorIR, OwnerFieldWriteIR } from "../ir";
import { listLunoraSourceFiles, lunoraRelativePath } from "./ast";

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

/** What discovery knows about the exported procedure or mutator a write sits inside. */
interface EnclosingDeclaration {
    /** The ownership column a `defineMutator({ owner })` declares, when it is one. */
    owner?: string;
    /** Procedure visibility, when the write sits in a registered procedure. */
    visibility?: "internal" | "public";
}

/** True when `node` is `args.<field>` or `args["<field>"]` — that exact property, nothing else. */
const isArgsProperty = (node: TsNode, field: string): boolean => {
    if (Node.isPropertyAccessExpression(node)) {
        const object = node.getExpression();

        return Node.isIdentifier(object) && object.getText() === "args" && node.getName() === field;
    }

    if (Node.isElementAccessExpression(node)) {
        const object = node.getExpression();
        const argument = node.getArgumentExpression();

        return (
            Node.isIdentifier(object) &&
            object.getText() === "args" &&
            argument !== undefined &&
            Node.isStringLiteral(argument) &&
            argument.getLiteralValue() === field
        );
    }

    return false;
};

/**
 * The initializer of an IMMUTABLE local alias for `node`, or `undefined`.
 *
 * Deliberately stricter than the shared `singleHopInitializer` in
 * `argument-taint.ts`, which is
 * built for taint detection and is right to be loose there: over-resolving makes
 * that predicate report MORE, which fails open. Here the same looseness fails the
 * other way — this hop is what SILENCES a finding — so it has to be exact.
 *
 * That helper takes the nearest preceding same-named declaration
 * regardless of `const`/`let`/`var` and never looks at assignments, so
 * `let userId = args.userId; userId = args.targetUserId` still resolves through
 * the stale initializer. That is an act-as-any-user IDOR being waved through.
 * Requiring `const`, and rejecting any binding the function reassigns, closes it.
 */
const constAliasInitializer = (node: TsNode): TsNode | undefined => {
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

    // Any write to this name anywhere in the function disqualifies the alias. A
    // `const` cannot be reassigned, so this only ever rejects a `let`/`var` that
    // the declaration check below would already have caught — belt and braces,
    // because the cost of being wrong here is a suppressed IDOR.
    for (const assignment of enclosingFunction.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        const left = assignment.getLeft();

        if (Node.isIdentifier(left) && left.getText() === name && assignment.getOperatorToken().getText().endsWith("=")) {
            return undefined;
        }
    }

    const usePosition = node.getStart();
    let nearest: TsNode | undefined;
    let nearestPosition = -1;

    for (const variable of enclosingFunction.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        if (variable.getName() !== name) {
            continue;
        }

        const list = variable.getParent();

        if (!Node.isVariableDeclarationList(list) || list.getDeclarationKind() !== VariableDeclarationKind.Const) {
            continue;
        }

        const initializer = variable.getInitializer();
        const declarationPosition = variable.getStart();

        if (initializer !== undefined && declarationPosition < usePosition && declarationPosition > nearestPosition) {
            nearest = initializer;
            nearestPosition = declarationPosition;
        }
    }

    return nearest;
};

/**
 * Whether `value` resolves to the mutator's own `args[owner]` — directly, or
 * through one immutable local `const` alias.
 *
 * The column NAME matching the declared `owner` is not enough.
 * `applyOwnerScope` overwrites exactly `args[ownerField]` with the verified
 * identity, so only that one argument is laundered: a mutator declaring
 * `owner: "userId"` whose impl writes `{ userId: args.targetUserId }` is a
 * genuine act-as-any-user IDOR, and matching on the name alone would suppress it.
 * Anything this cannot resolve — a destructured binding, a computed key, a
 * reassignable alias — falls through as NOT owner-scoped, which fails toward
 * reporting.
 */
const resolvesToOwnerArgument = (value: TsNode, ownerField: string): boolean => {
    if (isArgsProperty(value, ownerField)) {
        return true;
    }

    const hop = constAliasInitializer(value);

    return hop !== undefined && isArgsProperty(hop, ownerField);
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
            name = property.getName();
            value = property.getInitializer();
        } else if (Node.isShorthandPropertyAssignment(property)) {
            name = property.getName();
            value = property.getNameNode();
        }

        if (name === undefined || value === undefined || !IDENTITY_FIELDS.has(name)) {
            continue;
        }

        // Correct: `userId: ctx.auth.userId`; offending: `userId: args.userId`.
        // A value that references `ctx` is server-scoped even when it also embeds
        // `args`, so it is not flagged — mirrors the shared taint convention.
        if (isArgumentDerived(value) && !isScopedByContext(value)) {
            const exportName = enclosingExportName(call);
            // Recorded either way — the lint decides what to do with it. Dropping it
            // here would make the feeder the only place that knows the write
            // happened, and the sibling `visibility` stamp two lines down is the
            // precedent for annotating rather than discarding.
            const ownerScoped = ownerFieldOf(exportName) === name && resolvesToOwnerArgument(value, name);

            rows.push({
                exportName,
                field: name,
                file: relativePath,
                line: call.getStartLineNumber(),
                method,
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

/** Identity columns written from `args` across one source file's `ctx.db` writes. */
const ownerFieldWritesInSourceFile = (
    sourceFile: SourceFile,
    relativePath: string,
    declarationOf: (exportName: string) => EnclosingDeclaration,
): OwnerFieldWriteIR[] => {
    const found: OwnerFieldWriteIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        for (const write of ownerFieldWritesInCall(call, relativePath, (exportName) => declarationOf(exportName).owner)) {
            const { visibility } = declarationOf(write.exportName);

            found.push(visibility === undefined ? write : { ...write, visibility });
        }
    }

    return found;
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
    const writes: OwnerFieldWriteIR[] = [];
    // ONE map, keyed on file + export because two modules may export the same
    // name. Two parallel maps threaded as two same-shaped positional callbacks is
    // a silent-transposition hazard: `"internal" | "public" | undefined` is
    // assignable to `string | undefined`, so swapping them type-checks.
    const declarations = new Map<string, EnclosingDeclaration>();

    for (const entry of functions) {
        declarations.set(`${entry.filePath}:${entry.exportName}`, { visibility: entry.visibility });
    }

    for (const entry of mutators) {
        const key = `${entry.filePath}:${entry.exportName}`;

        declarations.set(key, { ...declarations.get(key), owner: entry.owner });
    }

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        writes.push(...ownerFieldWritesInSourceFile(sourceFile, relativePath, (exportName) => declarations.get(`${relativePath}:${exportName}`) ?? {}));
    }

    return writes;
};

export default discoverOwnerFieldWrites;
