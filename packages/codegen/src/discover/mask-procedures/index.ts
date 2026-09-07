import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { MaskProcedureIR } from "../../ir";
import { listLunoraSourceFiles, lunoraRelativePath, tablesAccessedIn } from "../ast";
import { classifyProcedureCall } from "../functions/classify-procedure-call";
import { maskCallsInChain, memberName } from "./internal/mask-call";

/**
 * Extract the `(table, column)` pairs declared by a `mask(policies)` call. The
 * `policies` argument is a table → `{ column: strategy }` object literal
 * (unlike `rls`'s array of `{ table }` objects), so we descend two levels: each
 * top-level property is a table; each of its nested properties is a masked
 * column. A non-object-literal argument (a variable reference) yields `[]`
 * (conservative: `usesMask` stays `true`, but no columns are enumerated).
 */
const extractMaskColumns = (maskCall: CallExpression): { column: string; table: string }[] => {
    const argument = maskCall.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        return [];
    }

    const pairs: { column: string; table: string }[] = [];

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
                pairs.push({ column, table });
            }
        }
    }

    return pairs;
};

/** Lint view of a builder chain: whether it carries any `.use(mask(...))` and the `(table, column)` pairs those masks declare. */
const maskFromBuilderChain = (receiver: TsNode): { maskColumns: { column: string; table: string }[]; usesMask: boolean } => {
    const calls = maskCallsInChain(receiver);

    return { maskColumns: calls.flatMap((call) => extractMaskColumns(call)), usesMask: calls.length > 0 };
};

// ---------------------------------------------------------------------------
// Table-access discovery inside a function body
// ---------------------------------------------------------------------------

/** Read-access call sites masking transforms: `ctx.db.query/findMany/findFirst/findFirstOrThrow/get`. */
const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findMany", "get", "query"]);

/** Write-access call sites: `ctx.db.insert/patch/replace/delete` (masking never touches these — captured only for completeness). */
const WRITE_METHODS = new Set(["delete", "insert", "patch", "replace"]);

// ---------------------------------------------------------------------------
// Top-level discovery
// ---------------------------------------------------------------------------

/**
 * Reduce one exported procedure declaration to its {@link MaskProcedureIR}, or
 * `undefined` when it isn't a procedure builder. Only the builder form
 * (`c.use(...).query(...)`) can carry `.use(mask(...))`; a bare factory has no
 * chain → never masks. Both forms are returned so the lint can flag a
 * bare-factory procedure that reads a mask-covered table.
 */
const procedureIrFromDeclaration = (declaration: TsNode, relativePath: string): MaskProcedureIR | undefined => {
    if (!Node.isVariableDeclaration(declaration)) {
        return undefined;
    }

    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const classified = classifyProcedureCall(initializer);

    if (!classified) {
        return undefined;
    }

    const chain = classified.receiver ? maskFromBuilderChain(classified.receiver) : { maskColumns: [], usesMask: false };
    const { tablesRead, tablesWritten } = tablesAccessedIn(declaration, READ_METHODS, WRITE_METHODS);

    return {
        exportName: declaration.getName(),
        file: relativePath,
        maskColumns: chain.maskColumns,
        tablesRead,
        tablesWritten,
        usesMask: chain.usesMask,
        visibility: classified.visibility,
    };
};

/**
 * Discover masking usage for every exported Lunora procedure under the lunora
 * source directory — the column-level twin of `discoverRlsProcedures`. For each
 * procedure, records whether its builder chain includes `.use(mask(...))`, which
 * `(table, column)` pairs that mask declares, and which tables it reads/writes
 * through `ctx.db`. Feeds the `mask_uncovered_pii_column` advisor lint.
 */
const discoverMaskProcedures = (project: Project, lunoraDirectory: string): MaskProcedureIR[] => {
    const procedures: MaskProcedureIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const statement of sourceFile.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                const ir = procedureIrFromDeclaration(declaration, relativePath);

                if (ir) {
                    procedures.push(ir);
                }
            }
        }
    }

    return procedures;
};

export default discoverMaskProcedures;
