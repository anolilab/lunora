import type { CallExpression, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { FunctionIR, OwnerFieldWriteIR } from "./ir";

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

/** Identity columns in one object literal that are written from `args` and not from `ctx`. */
const identityWritesInObjectLiteral = (
    objectLiteral: ObjectLiteralExpression,
    method: string,
    call: CallExpression,
    relativePath: string,
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
            rows.push({ exportName: enclosingExportName(call), field: name, file: relativePath, line: call.getStartLineNumber(), method });
        }
    }

    return rows;
};

/** Identity columns written from `args` by a single `ctx.db` write call. */
const ownerFieldWritesInCall = (call: CallExpression, relativePath: string): OwnerFieldWriteIR[] => {
    const method = contextDatabaseWriteMethod(call.getExpression());

    if (method === undefined) {
        return [];
    }

    const documentArgument = call.getArguments()[1];

    if (!documentArgument) {
        return [];
    }

    return documentObjectLiterals(documentArgument, method).flatMap((objectLiteral) =>
        identityWritesInObjectLiteral(objectLiteral, method, call, relativePath),
    );
};

/** Identity columns written from `args` across one source file's `ctx.db` writes. */
const ownerFieldWritesInSourceFile = (
    sourceFile: SourceFile,
    relativePath: string,
    visibilityOf: (exportName: string) => "internal" | "public" | undefined,
): OwnerFieldWriteIR[] => {
    const found: OwnerFieldWriteIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        for (const write of ownerFieldWritesInCall(call, relativePath)) {
            const visibility = visibilityOf(write.exportName);

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
const discoverOwnerFieldWrites = (project: Project, lunoraDirectory: string, functions: ReadonlyArray<FunctionIR> = []): OwnerFieldWriteIR[] => {
    const writes: OwnerFieldWriteIR[] = [];
    // Keyed on file + export because two modules may export the same name.
    const visibilityByKey = new Map(functions.map((entry) => [`${entry.filePath}:${entry.exportName}`, entry.visibility]));

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        writes.push(...ownerFieldWritesInSourceFile(sourceFile, relativePath, (exportName) => visibilityByKey.get(`${relativePath}:${exportName}`)));
    }

    return writes;
};

export default discoverOwnerFieldWrites;
