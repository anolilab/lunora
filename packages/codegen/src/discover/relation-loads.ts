import type { Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { RelationLoadIR } from "../ir";
import { listLunoraSourceFiles, lunoraRelativePath, propertyInitializer, readTargetOf } from "./ast";
import { classifyProcedureCall } from "./functions/classify-procedure-call";

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

        const relations = relationNamesOf(propertyInitializer(target.options, "with"));

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
 * lint input. Column masking is **per-procedure**: `@lunora/server`'s
 * `mask/middleware` threads a `relationMask` hook down and `@lunora/shard-engine`'s
 * relation loader applies it to every `with` hop, so what leaks is a read whose
 * OWN procedure declares no policy for the related table — a mask on that table's
 * other procedures does not carry over. This feeder records the parent table +
 * relation accessor names +
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
