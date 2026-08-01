import type { CallExpression, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { MaskColumnMetadataIR, MaskMetadataIR, MaskProcedureIR, MaskStrategyIR } from "./ir";

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

// ---------------------------------------------------------------------------
// Weak-hash-on-PII lint evidence (table + column + strategy + file/line/export)
// ---------------------------------------------------------------------------

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
 * or carries no mask chain. Mirrors {@link procedureIrFromDeclaration}'s
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
 * {@link discoverMaskProcedures}/{@link discoverMaskMetadata}, but — unlike
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

/**
 * True when `member` has a name {@link memberName} would resolve, but the name
 * is COMPUTED (`[expr]: …`) rather than a plain identifier/string/numeric
 * literal — e.g. `mask({ [tableName]: { email: "redact" } })`. Whether
 * ts-morph's `getName()` renders the bracketed source text or throws for such
 * a member, neither is a table/column name codegen can trust enumerating
 * against, so this is checked independently of {@link memberName} rather than
 * relying on it returning `undefined`. Covers every member kind `memberName`
 * accepts except `ShorthandPropertyAssignment`, which can't have a computed
 * name by grammar.
 */
const hasComputedName = (member: TsNode): boolean => {
    if (Node.isPropertyAssignment(member) || Node.isMethodDeclaration(member) || Node.isGetAccessorDeclaration(member)) {
        return Node.isComputedPropertyName(member.getNameNode());
    }

    return false;
};

/**
 * True when `member` is something {@link memberName} can't turn into a usable
 * table/column name — mirrors `memberName`'s accepted-kinds list BY
 * CONSTRUCTION rather than enumerating specific unsupported kinds by name:
 * anything that isn't one of the four kinds `memberName` accepts
 * (`PropertyAssignment`, `ShorthandPropertyAssignment`, `MethodDeclaration`,
 * `GetAccessorDeclaration`) is unnameable — this covers `SpreadAssignment`,
 * `SetAccessorDeclaration`, and any other object-literal member kind
 * ts-morph exposes now or later, matching exactly what the extractors'
 * `memberName(...) === undefined` skip already treats as unenumerable. Among
 * the four accepted kinds, a COMPUTED name is unnameable too even though
 * `memberName` resolves some text for it (see {@link hasComputedName}).
 */
const isUnnameableMember = (member: TsNode): boolean => {
    if (
        Node.isPropertyAssignment(member) ||
        Node.isShorthandPropertyAssignment(member) ||
        Node.isMethodDeclaration(member) ||
        Node.isGetAccessorDeclaration(member)
    ) {
        return hasComputedName(member);
    }

    return true;
};

/**
 * True when `object` — a `mask(...)` policies literal — has a member
 * {@link extractMaskColumns} can't enumerate, checked at the table level and,
 * for each table entry that IS enumerable, ONE further level at the column
 * level. This is exactly the two-level table→column walk
 * {@link extractMaskColumns}/{@link extractMaskColumnMetadata} perform — NOT
 * unbounded recursion, and NOT the same test at both levels.
 *
 * Table level applies {@link isUnnameableMember} plus a stricter shape check:
 * the extractor's table loop requires the entry to be a plain property
 * assignment (a shorthand, method, or get-accessor table entry — e.g.
 * `{ users }` referencing a variable — is skipped there even though
 * {@link memberName} can name it) whose value is a bare object literal; an
 * identifier reference (`{ users: piiColumns }`), an `as const`/`satisfies`
 * wrapper, or a call expression all fail that shape check and are treated as
 * unnameable, matching the extractor's fall-through-and-skip.
 *
 * Column level (recursed one level in, `atColumnLevel: true`) applies only
 * {@link isUnnameableMember} — a column's value is a STRATEGY, not required
 * to be an object literal. {@link strategyOf} labels any non-string-literal
 * strategy `"custom"` without needing to enumerate inside it, so column
 * values are never shape-checked or recursed into further. A legitimately
 * nested object at that depth — e.g.
 * `mask({ users: { ssn: { kind: "custom", ...opts } } })`, a fully literal
 * and fully enumerable table/column pair — is therefore NOT a fail-open the
 * extractors miss, and flagging it would be a false positive (recursing past
 * the column level was an earlier bug here).
 */
const objectLiteralHasUnnameableMember = (object: ObjectLiteralExpression, atColumnLevel = false): boolean => {
    for (const property of object.getProperties()) {
        if (isUnnameableMember(property)) {
            return true;
        }

        if (atColumnLevel) {
            continue;
        }

        if (!Node.isPropertyAssignment(property)) {
            return true;
        }

        const initializer = property.getInitializer();

        if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
            return true;
        }

        if (objectLiteralHasUnnameableMember(initializer, true)) {
            return true;
        }
    }

    return false;
};

/**
 * True when the project declares at least one `mask(...)` call whose policies
 * argument IS PRESENT but isn't a plain object literal — e.g. a hoisted
 * `mask(sharedPolicies)` — OR is an object literal that contains a spread or
 * computed key (see {@link objectLiteralHasUnnameableMember}) at either the
 * table or the column level — e.g. `mask({ ...sharedPolicies })`,
 * `mask({ [tableName]: { email: "redact" } })`, or
 * `mask({ users: { ...piiColumns } })`. {@link extractMaskColumns}/
 * {@link extractMaskColumnMetadata} silently contribute `[]` (or an
 * incomplete column list) for all of these — a variable reference, a spread,
 * or a computed key can't be statically enumerated — so every masked-column
 * consumer derived from {@link discoverMaskMetadata} is blind to whichever
 * table(s)/column(s) the call actually masks. `assertNoMaskedShapeTable` (in
 * `run-codegen.ts`) uses this to fail closed rather than clear a `defineShape`
 * it can't actually prove safe.
 *
 * Deliberately kept OUT of {@link MaskMetadataIR} — that IR is JSON-embedded
 * verbatim into the generated `LUNORA_MASK_METADATA` literal and type-checked
 * against `@lunora/do`'s hand-mirrored `MaskPoliciesResult`; adding a field
 * here would embed it in that literal and trip the generated file's
 * excess-property check under strict TS. This stays a standalone signal
 * consumed only by the codegen-time guard, never emitted.
 */
const discoverMaskHasNonLiteralPolicy = (project: Project, lunoraDirectory: string): boolean => {
    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const receiver of exportedProcedureChains(sourceFile)) {
            for (const maskCall of maskCallsInChain(receiver)) {
                const argument = maskCall.getArguments()[0];

                if (argument !== undefined && (!Node.isObjectLiteralExpression(argument) || objectLiteralHasUnnameableMember(argument))) {
                    return true;
                }
            }
        }
    }

    return false;
};

export { discoverMaskHasNonLiteralPolicy, discoverMaskMetadata, discoverMaskStrategies };

export default discoverMaskProcedures;
