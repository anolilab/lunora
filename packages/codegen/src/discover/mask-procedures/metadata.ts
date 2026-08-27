import type { CallExpression, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { MaskColumnMetadataIR, MaskMetadataIR } from "../../ir";
import { listLunoraSourceFiles } from "../ast";
import exportedProcedureChains from "../functions/exported-procedure-chains";
import { maskCallsInChain, memberName, strategyOf } from "./internal/mask-call";

/**
 * Extract the `(table, column, strategy)` triples a `mask(policies)` call
 * declares — the studio-metadata twin of `extractMaskColumns`, which drops
 * the strategy. Descends the same two object-literal levels (table → column) and
 * resolves each column's strategy via {@link strategyOf}.
 */
const extractMaskColumnMetadata = (maskCall: CallExpression): MaskColumnMetadataIR[] => {
    const argument = maskCall.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        return [];
    }

    const columns: MaskColumnMetadataIR[] = [];

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

            if (column !== undefined) {
                columns.push({ column, strategy: strategyOf(columnProperty), table });
            }
        }
    }

    return columns;
};

/**
 * Aggregate the schema-wide masking metadata the studio's data-browser mask
 * toggle reads: every statically-discovered `(table, column, strategy)` masked
 * column across the project's `.use(mask(...))` chains. Walks the same builder
 * chains as `discoverMaskProcedures` but carries the strategy the preview
 * needs to choose redact-vs-hash-vs-custom rendering. Deduped by `(table,
 * column)` with the first declaration winning, so a column masked by several
 * procedures lists once — the same evidence the advisor lint uses.
 */
const discoverMaskMetadata = (project: Project, lunoraDirectory: string): MaskMetadataIR => {
    const columnsByKey = new Map<string, MaskColumnMetadataIR>();

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const { receiver } of exportedProcedureChains(sourceFile)) {
            for (const maskCall of maskCallsInChain(receiver)) {
                for (const column of extractMaskColumnMetadata(maskCall)) {
                    const key = `${column.table}\u0000${column.column}`;

                    if (!columnsByKey.has(key)) {
                        columnsByKey.set(key, column);
                    }
                }
            }
        }
    }

    return { columns: [...columnsByKey.values()] };
};

export default discoverMaskMetadata;
