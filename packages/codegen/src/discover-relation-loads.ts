import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { RelationLoadIR } from "./ir";

/**
 * List reads whose options object accepts a `with` relation-hydration map. Only
 * `findMany` / `findFirst` / `findFirstOrThrow` take that options object — `get`
 * is id-only and the fluent `query(...)` reader has no `with` — so both are
 * excluded (see `@lunora/server`'s `mask/middleware` note that `with` relations
 * are hydrated unmasked).
 */
const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findMany"]);

/**
 * The `(table, options)` a `ctx.db` list read addresses, or `undefined` when the
 * call isn't one. Matched by receiver **shape** (not import origin), fail-closed,
 * in both surface forms Lunora exposes. Facade form
 * `ctx.db.<table>.findMany(options?)` — the form real app code writes — puts the
 * table in the receiver's property name and the options object at argument 0.
 * Table-arg form `ctx.db.findMany("table", options?)` puts the table in the
 * string-literal argument 0 and the options object at argument 1. `table` is `""`
 * when the table-arg form's first argument isn't a string literal (a dynamic
 * table — not resolvable against the schema's relations).
 */
const readTargetOf = (call: CallExpression): { options: TsNode | undefined; table: string } | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !READ_METHODS.has(callee.getName())) {
        return undefined;
    }

    const receiver = callee.getExpression();

    // Table-arg form: the receiver is `ctx.db` (property named `db`) or a bare `db`.
    if ((Node.isPropertyAccessExpression(receiver) && receiver.getName() === "db") || (Node.isIdentifier(receiver) && receiver.getText() === "db")) {
        const first = call.getArguments()[0];

        return { options: call.getArguments()[1], table: first && Node.isStringLiteral(first) ? first.getLiteralText() : "" };
    }

    // Facade form: the receiver is `ctx.db.<table>` (or `db.<table>`) — its inner
    // expression is the `db` accessor and its own name is the table.
    if (Node.isPropertyAccessExpression(receiver)) {
        const inner = receiver.getExpression();
        const onDatabase = (Node.isPropertyAccessExpression(inner) && inner.getName() === "db") || (Node.isIdentifier(inner) && inner.getText() === "db");

        if (onDatabase) {
            return { options: call.getArguments()[0], table: receiver.getName() };
        }
    }

    return undefined;
};

/** The relation accessor names declared by a `with: { … }` object literal (`{ author: true }`, `{ author }`, `{ author() {} }`) — the keys matched against the schema's relation names. Spreads/computed keys yield nothing. */
const relationNamesOf = (withValue: TsNode | undefined): string[] => {
    if (!withValue || !Node.isObjectLiteralExpression(withValue)) {
        return [];
    }

    const names: string[] = [];

    for (const member of withValue.getProperties()) {
        if (
            Node.isPropertyAssignment(member) ||
            Node.isShorthandPropertyAssignment(member) ||
            Node.isMethodDeclaration(member) ||
            Node.isGetAccessorDeclaration(member)
        ) {
            names.push(member.getName());
        }
    }

    return names;
};

/** The initializer expression of a named property on an options object literal, or `undefined` when absent / not a plain assignment. */
const optionValue = (options: TsNode | undefined, key: string): TsNode | undefined => {
    if (!options || !Node.isObjectLiteralExpression(options)) {
        return undefined;
    }

    const property = options.getProperty(key);

    return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
};

/**
 * Reduce one exported procedure declaration to the `with`-hydrating list reads
 * inside its body. Classify-then-walk (the {@link classifyProcedureCall} shape
 * the mask/rls feeders use): the classification supplies the procedure's
 * visibility, then every `ctx.db` list read carrying a `with: { … }` relation
 * map is recorded with its parent table and the relation accessor names. The
 * lint resolves each relation to its target table and only flags when that
 * target is masked and the read is public.
 */
const relationLoadsInDeclaration = (declaration: TsNode, relativePath: string): RelationLoadIR[] => {
    if (!Node.isVariableDeclaration(declaration)) {
        return [];
    }

    const initializer = declaration.getInitializer();
    const classified = initializer && Node.isCallExpression(initializer) ? classifyProcedureCall(initializer) : undefined;

    if (!classified) {
        return [];
    }

    const rows: RelationLoadIR[] = [];

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const target = readTargetOf(call);

        if (target === undefined) {
            continue;
        }

        const relations = relationNamesOf(optionValue(target.options, "with"));

        if (relations.length === 0) {
            continue;
        }

        rows.push({
            exportName: declaration.getName(),
            file: relativePath,
            line: call.getStartLineNumber(),
            parentTable: target.table,
            relations,
            visibility: classified.visibility,
        });
    }

    return rows;
};

/**
 * Discover `ctx.db.<table>.findMany({ with: { <rel> } })` relation-hydrating
 * list reads under the lunora source directory — the `masked_relation_leak_via_with`
 * lint input. Column masking is applied per-procedure to the top-level rows of
 * the table named in the read; it does **not** descend into `with`-hydrated
 * relations (documented in `@lunora/server`'s `mask/middleware`), so a masked
 * table surfaced only through a `with` on an unprotected parent read is returned
 * in the clear. This feeder records the parent table + relation accessor names +
 * visibility; the lint resolves the relation target and joins it against the
 * discovered mask evidence before flagging.
 */
const discoverRelationLoads = (project: Project, lunoraDirectory: string): RelationLoadIR[] => {
    const rows: RelationLoadIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const statement of sourceFile.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                rows.push(...relationLoadsInDeclaration(declaration, relativePath));
            }
        }
    }

    return rows;
};

export default discoverRelationLoads;
