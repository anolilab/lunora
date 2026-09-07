import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { MaskStrategyIR } from "../../ir";
import { listLunoraSourceFiles, lunoraRelativePath } from "../ast";
import { classifyProcedureCall } from "../functions/classify-procedure-call";
import { maskCallsInChain, memberName, strategyOf } from "./internal/mask-call";

/**
 * Extract `{ column, line, strategy, table }` rows for masked columns declared
 * by one `mask(policies)` call whose strategy is a statically-known literal
 * (`"hash"`/`"redact"`) — a `MaskFn`/non-literal strategy ({@link strategyOf}
 * returning `"custom"`) carries no lint-relevant signal and is skipped. The
 * line is the masked column's property, not the enclosing `mask(...)` call, so
 * the lint can point at the exact offending strategy when a policy declares
 * several columns.
 */
const extractMaskStrategyRows = (maskCall: CallExpression, exportName: string, relativePath: string): MaskStrategyIR[] => {
    const argument = maskCall.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        return [];
    }

    const rows: MaskStrategyIR[] = [];

    for (const tableProperty of argument.getProperties()) {
        const table = memberName(tableProperty);

        if (table === undefined || !Node.isPropertyAssignment(tableProperty)) {
            continue;
        }

        const initializer = tableProperty.getInitializer();

        if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
            continue;
        }

        for (const columnProperty of initializer.getProperties()) {
            const column = memberName(columnProperty);

            if (column === undefined) {
                continue;
            }

            const strategy = strategyOf(columnProperty);

            if (strategy === "custom") {
                continue;
            }

            rows.push({ column, exportName, file: relativePath, line: columnProperty.getStartLineNumber(), strategy, table });
        }
    }

    return rows;
};

/**
 * Reduce one exported declaration to the {@link MaskStrategyIR} rows its
 * `.use(mask(...))` chain declares, or `[]` when it isn't a procedure builder
 * or carries no mask chain. Mirrors `procedureIrFromDeclaration`'s
 * classify-then-walk shape, split out so {@link discoverMaskStrategies} stays a
 * plain file/statement/declaration walk.
 */
const maskStrategyRowsFromDeclaration = (declaration: TsNode, relativePath: string): MaskStrategyIR[] => {
    if (!Node.isVariableDeclaration(declaration)) {
        return [];
    }

    const initializer = declaration.getInitializer();
    const classified = initializer && Node.isCallExpression(initializer) ? classifyProcedureCall(initializer) : undefined;

    if (!classified?.receiver) {
        return [];
    }

    return maskCallsInChain(classified.receiver).flatMap((maskCall) => extractMaskStrategyRows(maskCall, declaration.getName(), relativePath));
};

/**
 * Discover every masked column across the project's `.use(mask(...))` chains
 * whose strategy is a statically-known literal (`"hash"`/`"redact"`) — the
 * `mask_weak_hash_strategy_on_pii` lint input. Walks the same builder chains as
 * `discoverMaskProcedures`/`discoverMaskMetadata`, but — unlike
 * `discoverMaskMetadata` (app-wide, deduped by `(table, column)`, first
 * declaration wins) — records one row per declaration site (file + line +
 * enclosing export), undeduped, so the PII lint can point at the exact
 * `mask(...)` call site. A bare-factory procedure has no builder chain and so
 * never masks.
 */
const discoverMaskStrategies = (project: Project, lunoraDirectory: string): MaskStrategyIR[] => {
    const rows: MaskStrategyIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const statement of sourceFile.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                rows.push(...maskStrategyRowsFromDeclaration(declaration, relativePath));
            }
        }
    }

    return rows;
};

export default discoverMaskStrategies;
