import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { lunoraRelativePath, classifyProcedureCall, listLunoraSourceFiles } from "./discover-functions";
import type { MaskColumnMetadataIR, MaskMetadataIR, MaskProcedureIR } from "./ir";

// ---------------------------------------------------------------------------
// Builder-chain helpers
// ---------------------------------------------------------------------------

/**
 * True when `node` is a `CallExpression` whose callee resolves to the name
 * `"mask"` — either a bare identifier (`mask(policies)`) or a property access
 * (`maskModule.mask(policies)`). Matched by name (not import origin) so the
 * check is robust even when ts-morph has degraded type info — exactly the
 * discipline `discover-rls-procedures` uses for `rls`.
 */
const isMaskCall = (node: TsNode): boolean => {
    if (!Node.isCallExpression(node)) {
        return false;
    }

    const callee = node.getExpression();

    if (Node.isIdentifier(callee)) {
        return callee.getText() === "mask";
    }

    if (Node.isPropertyAccessExpression(callee)) {
        return callee.getName() === "mask";
    }

    return false;
};

/** The declared name of an object-literal member (`email: …`, `email() {}`, `email`), or `undefined` for spreads/computed keys. */
const memberName = (member: TsNode): string | undefined => {
    if (
        Node.isPropertyAssignment(member) ||
        Node.isShorthandPropertyAssignment(member) ||
        Node.isMethodDeclaration(member) ||
        Node.isGetAccessorDeclaration(member)
    ) {
        return member.getName();
    }

    return undefined;
};

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

/**
 * Walk a builder chain leftward from `receiver` and collect every `mask(...)`
 * `CallExpression` carried through a `.use(mask(...))` step — the column-masking
 * twin of `discover-rls-procedures`'s `rlsCallsInChain`. Each chain step is a
 * `CallExpression` whose callee is a `PropertyAccessExpression`; a `.use(...)`
 * step whose first argument is a `mask(...)` call is what we collect.
 */
const maskCallsInChain = (receiver: TsNode): CallExpression[] => {
    const calls: CallExpression[] = [];
    let node: TsNode = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "use") {
            const argument = node.getArguments()[0];

            if (argument && isMaskCall(argument)) {
                calls.push(argument as CallExpression);
            }
        }

        node = chainCallee.getExpression();
    }

    return calls;
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

/** True when `call` is a `ctx.db.&lt;method>(...)` or bare `db.&lt;method>(...)` call against `methodSet`. */
const isDatabaseCall = (call: CallExpression, methodSet: Set<string>): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !methodSet.has(callee.getName())) {
        return false;
    }

    const receiver = callee.getExpression();

    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "db";
    }

    return Node.isIdentifier(receiver) && receiver.getText() === "db";
};

/** String-literal first argument of a `ctx.db.&lt;method>("table", ...)` call, or `""` when the argument is not a string literal (dynamic table — not lintable). */
const tableArgumentOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/** Discover the set of tables read and written inside the lexical scope of the exported procedure binding (including helper closures in the body). */
const tablesAccessedIn = (declaration: TsNode): { tablesRead: string[]; tablesWritten: string[] } => {
    const tablesRead = new Set<string>();
    const tablesWritten = new Set<string>();

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isDatabaseCall(call, READ_METHODS)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesRead.add(table);
            }
        } else if (isDatabaseCall(call, WRITE_METHODS)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesWritten.add(table);
            }
        }
    }

    return { tablesRead: [...tablesRead], tablesWritten: [...tablesWritten] };
};

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
    const { tablesRead, tablesWritten } = tablesAccessedIn(declaration);

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

// ---------------------------------------------------------------------------
// Studio mask-preview metadata (table + column + strategy)
// ---------------------------------------------------------------------------

/**
 * The masking strategy declared for one column property. A string-literal
 * initializer of `"redact"`/`"hash"` maps to that strategy; anything else (a
 * `(value, ctx) => …` function, a shorthand/method member, or a non-literal
 * reference) is `"custom"` — fail-closed: the studio preview renders a fixed
 * sentinel rather than guessing the closure's output.
 */
const strategyOf = (columnProperty: TsNode): MaskColumnMetadataIR["strategy"] => {
    if (Node.isPropertyAssignment(columnProperty)) {
        const initializer = columnProperty.getInitializer();

        if (initializer && Node.isStringLiteral(initializer)) {
            const literal = initializer.getLiteralText();

            if (literal === "redact" || literal === "hash") {
                return literal;
            }
        }
    }

    return "custom";
};

/**
 * Extract the `(table, column, strategy)` triples a `mask(policies)` call
 * declares — the studio-metadata twin of {@link extractMaskColumns}, which drops
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

/** The exported variable declarations in `sourceFile` whose initializer is a procedure builder chain with a receiver. */
const exportedProcedureChains = (sourceFile: SourceFile): TsNode[] => {
    const receivers: TsNode[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const initializer = declaration.getInitializer();
            const classified = initializer && Node.isCallExpression(initializer) ? classifyProcedureCall(initializer) : undefined;

            if (classified?.receiver) {
                receivers.push(classified.receiver);
            }
        }
    }

    return receivers;
};

/**
 * Aggregate the schema-wide masking metadata the studio's data-browser mask
 * toggle reads: every statically-discovered `(table, column, strategy)` masked
 * column across the project's `.use(mask(...))` chains. Walks the same builder
 * chains as {@link discoverMaskProcedures} but carries the strategy the preview
 * needs to choose redact-vs-hash-vs-custom rendering. Deduped by `(table,
 * column)` with the first declaration winning, so a column masked by several
 * procedures lists once — the same evidence the advisor lint uses.
 */
const discoverMaskMetadata = (project: Project, lunoraDirectory: string): MaskMetadataIR => {
    const columnsByKey = new Map<string, MaskColumnMetadataIR>();

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const receiver of exportedProcedureChains(sourceFile)) {
            for (const maskCall of maskCallsInChain(receiver)) {
                for (const column of extractMaskColumnMetadata(maskCall)) {
                    const key = `${column.table} ${column.column}`;

                    if (!columnsByKey.has(key)) {
                        columnsByKey.set(key, column);
                    }
                }
            }
        }
    }

    return { columns: [...columnsByKey.values()] };
};

export { discoverMaskMetadata };

export default discoverMaskProcedures;
